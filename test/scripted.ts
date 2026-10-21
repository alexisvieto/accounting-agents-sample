import type Anthropic from "@anthropic-ai/sdk";
import type { AgentName } from "../src/agents.ts";
import type { Model, ModelRequest } from "../src/model.ts";

type Call = { tool: string; input: Record<string, unknown> };
export type Turn = Call[] | { text: string } | { stop: "refusal" | "max_tokens" };

/**
 * A stand-in for Claude that plays back a fixed script per agent, so the
 * harness, the tools and the database rules can be tested without the API.
 * It records every request so tests can check what each agent was offered.
 */
export function scripted(script: Partial<Record<AgentName, Turn[]>>) {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]));
  const requests: ModelRequest[] = [];
  let n = 0;
  const model: Model = async (req) => {
    requests.push(structuredClone(req));
    const turn = queues[req.agent]?.shift();
    if (!turn) throw new Error(`No scripted turn left for ${req.agent}`);
    if ("stop" in turn) return { content: [], stop_reason: turn.stop };
    if ("text" in turn) return { content: [{ type: "text", text: turn.text, citations: null }], stop_reason: "end_turn" };
    const content = turn.map(
      (c): Anthropic.Beta.Messages.BetaToolUseBlock => ({
        type: "tool_use",
        id: `toolu_${++n}`,
        name: c.tool,
        input: c.input,
        caller: { type: "direct" },
      }),
    );
    return { content, stop_reason: "tool_use" };
  };
  /** The tool results an agent got back, in order. */
  const resultsFor = (agent: AgentName) =>
    requests
      .filter((r) => r.agent === agent)
      .flatMap((r) => {
        const last = r.messages.at(-1);
        return last?.role === "user" && Array.isArray(last.content) ? last.content : [];
      })
      .filter((b): b is Anthropic.Beta.Messages.BetaToolResultBlockParam => b.type === "tool_result")
      .map((b) => ({ error: b.is_error === true, text: String(b.content) }));
  return { model, requests, resultsFor };
}
