import { env, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { MemoryAgent } from "../src/memory/agent";
import { keywords } from "../src/memory/search";
import { callText, filler, scriptedModel, userMessage } from "./helpers";

const FACT = "By the way, my dog is called Biscuit.";
const QUESTION = "What's my dog's name?";

/** Plants a fact, buries it under small talk, then asks about it. */
async function plantAndAsk(agent: MemoryAgent, fillerPairs = 120) {
  await agent.addMessages([userMessage(FACT), ...filler(fillerPairs)]);
  await agent.saveMessages([userMessage(QUESTION)]);
}

describe("cut-off design", () => {
  it("forgets a fact buried under enough small talk", async () => {
    const stub = await getAgentByName(env.CutoffAgent, "cutoff-forgets");
    const seen = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const model = scriptedModel();
      agent.modelOverride = model;
      await plantAndAsk(agent);
      return callText(model.doStreamCalls[0] as never);
    });
    expect(seen).not.toContain("Biscuit");
    expect(seen).toContain("dog's name");
  });

  it("still sees a fact that is recent", async () => {
    const stub = await getAgentByName(env.CutoffAgent, "cutoff-recent");
    const seen = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const model = scriptedModel();
      agent.modelOverride = model;
      await plantAndAsk(agent, 2);
      return callText(model.doStreamCalls[0] as never);
    });
    expect(seen).toContain("Biscuit");
  });
});

describe("search design", () => {
  it("extracts content words from a question", () => {
    expect(keywords("What's my dog's name?")).toEqual(["dog", "name"]);
    expect(keywords("Where do I live now?")).toEqual(["live"]);
    expect(keywords("I moved to Austin in 2024")).toEqual(["moved", "austin", "2024"]);
  });

  it("retrieves a buried fact into the prompt", async () => {
    const stub = await getAgentByName(env.SearchAgent, "search-finds");
    const { seen, snapshot } = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const model = scriptedModel();
      agent.modelOverride = model;
      await plantAndAsk(agent);
      return {
        seen: callText(model.doStreamCalls[0] as never),
        snapshot: await agent.inspect()
      };
    });
    expect(seen).toContain("Biscuit");
    expect(JSON.stringify(snapshot.lastTurn)).toContain("Biscuit");
  });

  it("orders retrieved messages oldest first so changes read as changes", async () => {
    const stub = await getAgentByName(env.SearchAgent, "search-order");
    const seen = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const model = scriptedModel();
      agent.modelOverride = model;
      await agent.addMessages([userMessage("I live in Toronto.")]);
      await agent.addMessages(filler(60, "a"));
      await agent.addMessages([userMessage("Big news: I moved and now live in Austin.")]);
      await agent.addMessages(filler(60, "b"));
      await agent.saveMessages([userMessage("Where do I live?")]);
      return callText(model.doStreamCalls[0] as never);
    });
    expect(seen.indexOf("Toronto")).toBeGreaterThan(-1);
    expect(seen.indexOf("Toronto")).toBeLessThan(seen.indexOf("Austin"));
  });
});

describe("built-in design", () => {
  it("shows what the model saved with set_context on later turns", async () => {
    const stub = await getAgentByName(env.BuiltinAgent, "builtin-memory");
    const { seen, memory } = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const model = scriptedModel([
        { toolCall: { toolName: "set_context", input: { label: "memory", content: "Dog: Biscuit" } } },
        { text: "Lovely name!" }
      ]);
      agent.modelOverride = model;
      await agent.saveMessages([userMessage(FACT)]);
      await agent.addMessages(filler(120));
      await agent.saveMessages([userMessage(QUESTION)]);
      return {
        seen: callText(model.doStreamCalls.at(-1) as never),
        memory: (await agent.inspect()).memory
      };
    });
    expect(memory.memoryBlock).toContain("Biscuit");
    expect(seen).toContain("Dog: Biscuit");
  });

  it("compacts after addMessages and keeps the summary in the prompt", async () => {
    const stub = await getAgentByName(env.BuiltinAgent, "builtin-compacts");
    const out = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      const model = scriptedModel([], "SUMMARY-MARKER: user mentioned a dog called Biscuit.");
      agent.modelOverride = model;
      await agent.addMessages([userMessage(FACT), ...filler(120)]);
      const compactions = await agent.session.getCompactions();
      await agent.saveMessages([userMessage(QUESTION)]);
      return {
        compactions: compactions.length,
        summarizerCalls: model.doGenerateCalls.length,
        metrics: agent.metrics().map((m) => m.kind),
        system: String((model.doStreamCalls[0].prompt[0] as { content: unknown }).content)
      };
    });
    expect(out.compactions).toBeGreaterThan(0);
    expect(out.summarizerCalls).toBeGreaterThan(0);
    // Summarizer usage is cost too, and runs outside any turn.
    expect(out.metrics).toContain("compaction");
    expect(out.system).toContain("SUMMARY-MARKER");
  });

  it("records a compaction failure instead of hiding it", async () => {
    const stub = await getAgentByName(env.BuiltinAgent, "builtin-compaction-error");
    const kinds = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      agent.modelOverride = scriptedModel([], new Error("model unavailable"));
      await agent.addMessages(filler(120));
      return agent.metrics().map((m) => m.kind);
    });
    expect(kinds).toContain("compaction_error");
  });
});

describe("metrics and inspect", () => {
  it("records usage per step and latency per turn", async () => {
    const stub = await getAgentByName(env.CutoffAgent, "metrics");
    const metrics = await runInDurableObject(stub, async (agent: MemoryAgent) => {
      agent.modelOverride = scriptedModel();
      await agent.saveMessages([userMessage("Hi")]);
      return agent.metrics();
    });
    const step = metrics.find((m) => m.kind === "step");
    const turn = metrics.find((m) => m.kind === "turn");
    expect(step?.input_tokens).toBe(100);
    expect(step?.output_tokens).toBe(10);
    expect(turn?.latency_ms).toBeGreaterThanOrEqual(0);
    expect(turn?.detail).toBe("completed");
  });

  it("serves the memory snapshot at /inspect", async () => {
    const res = await exports.default.fetch(
      "http://example.com/agents/builtin-agent/inspect-route/inspect"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { design: string; budgetTokens: number };
    expect(body.design).toBe("builtin");
    expect(body.budgetTokens).toBeGreaterThan(0);
  });
});
