import { Think, type ThinkModel } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { dedupeWorkersAI } from "./ai/dedupe-binding";
import { MODEL_ID, SYSTEM_PROMPT } from "./config";

// Stage 0: a plain Think chat agent with no memory design yet. Each browser
// visitor talks to their own instance (see src/client/instance.ts).
export class ChatAgent extends Think<Env> {
  // Tests swap in a mock model here before the first turn. Think resolves the
  // model on first use, so this must be set before any message is sent.
  modelOverride: ThinkModel | undefined;

  getModel(): ThinkModel {
    if (this.modelOverride) return this.modelOverride;
    // Not the plain MODEL_ID string: that path uses the unwrapped binding,
    // which doubles streamed text (see src/ai/dedupe-binding.ts).
    return createWorkersAI({ binding: dedupeWorkersAI(this.env.AI) })(MODEL_ID);
  }

  getSystemPrompt() {
    return SYSTEM_PROMPT;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
