import { randomUUID } from "node:crypto";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { AGENTS, WORKERS, systemPrompt, type AgentName } from "./agents.ts";
import type { Books } from "./db.ts";
import type { Model } from "./model.ts";
import { Rejected, TOOLS, escalate, type Ctx } from "./tools.ts";

type ToolUse = Anthropic.Beta.Messages.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type RunOptions = {
  books: Books;
  model: Model;
  today: string;
  maxTurns?: number;
  runId?: string;
};

export type RunResult = {
  agent: AgentName;
  outcome: "done" | "escalated";
  summary: string;
  turns: number;
};

/** JSON Schema for the API, without the $schema key and the safe-integer bounds Zod adds. */
function inputSchema(schema: z.ZodType): Anthropic.Beta.Messages.BetaTool.InputSchema {
  const json = JSON.stringify(z.toJSONSchema(schema), (key, value) =>
    key === "$schema" || (Math.abs(value) === Number.MAX_SAFE_INTEGER && (key === "minimum" || key === "maximum"))
      ? undefined
      : value,
  );
  return JSON.parse(json);
}

const delegateInput = z
  .object({
    agent: z.enum(WORKERS as [AgentName, ...AgentName[]]).describe("The agent that owns this kind of work"),
    task: z.string().min(10).max(2000).describe("What to do, in one or two sentences"),
  })
  .strict();

const delegateTool = {
  name: "delegate",
  description:
    "Give a task to one of the six agents and wait for its summary: intake (inbox), payables (supplier " +
    "payments), billing (customer invoices), collections (overdue customers), reconciliation (bank), archive " +
    "(questions about records).",
  input_schema: inputSchema(delegateInput),
};

/**
 * The agent loop. It is written by hand rather than with the SDK's tool runner
 * because every call has to switch to the agent's Postgres role, be logged, and
 * turn refusals and runaway loops into escalations.
 */
export async function runAgent(name: AgentName, task: string, opts: RunOptions, depth = 0): Promise<RunResult> {
  const agent = AGENTS[name];
  const runId = opts.runId ?? randomUUID();
  const maxTurns = opts.maxTurns ?? 15;
  const ctx: Ctx = { today: opts.today };

  const tools: Anthropic.Beta.Messages.BetaTool[] = agent.tools.map((t) => ({
    name: TOOLS[t].name,
    description: TOOLS[t].description,
    input_schema: inputSchema(TOOLS[t].input),
  }));
  if (name === "orchestrator") tools.push(delegateTool);
  const system = systemPrompt(agent, opts.today);
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [{ role: "user", content: task }];

  const log = (tool: string, input: unknown, ok: boolean, result: unknown) =>
    opts.books.asOwner((q) =>
      q("insert into agent_actions (run_id, agent, tool, input, ok, result) values ($1, $2, $3, $4, $5, $6)", [
        runId,
        name,
        tool,
        JSON.stringify(input ?? {}),
        ok,
        JSON.stringify(result ?? null),
      ]),
    );

  // Escalations the harness raises on the agent's behalf still go in as the agent's role.
  const giveUp = async (reason: string, turns: number): Promise<RunResult> => {
    const input = { subject: `${name} agent stopped: ${task.slice(0, 120)}`, reason };
    const result = await opts.books.asAgent(agent.role, (q) => escalate.run(q, input, ctx));
    await log("escalate", input, true, result);
    return { agent: name, outcome: "escalated", summary: reason, turns };
  };

  async function execute(call: ToolUse): Promise<{ ok: boolean; result: unknown }> {
    if (call.name === "delegate" && name === "orchestrator" && depth === 0) {
      const parsed = delegateInput.safeParse(call.input);
      if (!parsed.success) return { ok: false, result: z.prettifyError(parsed.error) };
      const sub = await runAgent(parsed.data.agent, parsed.data.task, { ...opts, runId }, depth + 1);
      return { ok: true, result: sub };
    }
    const tool = (agent.tools as string[]).includes(call.name) ? TOOLS[call.name as keyof typeof TOOLS] : undefined;
    if (!tool) return { ok: false, result: `Tool ${call.name} is not available to the ${name} agent.` };
    const parsed = tool.input.safeParse(call.input);
    if (!parsed.success) return { ok: false, result: z.prettifyError(parsed.error) };
    try {
      return { ok: true, result: await opts.books.asAgent(agent.role, (q) => tool.run(q, parsed.data, ctx)) };
    } catch (err) {
      if (err instanceof Rejected) return { ok: false, result: err.message };
      // Postgres said no: missing grant, constraint, bad value. The agent sees why.
      return { ok: false, result: `The database refused: ${(err as Error).message}` };
    }
  }

  for (let turn = 1; turn <= maxTurns; turn++) {
    const reply = await opts.model({ agent: name, system, tools, messages });
    messages.push({ role: "assistant", content: reply.content }); // unchanged, thinking blocks included

    if (reply.stop_reason === "refusal") return giveUp("The model declined this task.", turn);
    if (reply.stop_reason === "max_tokens") return giveUp("The model's reply was cut off.", turn);
    if (reply.stop_reason === "pause_turn") continue;

    const calls = reply.content.filter((b): b is ToolUse => b.type === "tool_use");
    if (!calls.length) {
      const summary = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      return { agent: name, outcome: "done", summary, turns: turn };
    }

    const results: ToolResult[] = [];
    for (const call of calls) {
      const { ok, result } = await execute(call);
      await log(call.name, call.input, ok, result);
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
        ...(ok ? {} : { is_error: true }),
      });
    }
    messages.push({ role: "user", content: results }); // all results of a turn in one message
  }
  return giveUp(`Stopped after ${maxTurns} turns without finishing.`, maxTurns);
}
