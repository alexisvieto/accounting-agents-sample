import Anthropic from "@anthropic-ai/sdk";
import type { AgentName } from "./agents.ts";

type Beta = Anthropic.Beta.Messages.BetaMessage;

export type ModelRequest = {
  agent: AgentName;
  system: string;
  tools: Anthropic.Beta.Messages.BetaTool[];
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
};
export type ModelReply = Pick<Beta, "content" | "stop_reason">;

/** One turn of the model. The harness doesn't care who answers: Claude, or a script in the tests. */
export type Model = (req: ModelRequest) => Promise<ModelReply>;

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function claude(effort: Effort = "medium"): Model {
  const client = new Anthropic(); // ANTHROPIC_API_KEY or an `ant auth login` profile
  return ({ system, tools, messages }) =>
    client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system,
      tools,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort },
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines a turn, the API retries it on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
}
