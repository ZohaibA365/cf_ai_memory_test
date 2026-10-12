# Prompts

Every prompt given to the AI coding tool (Claude Code), in order, with the date and a one-line result.

---

## 1. 2026-10-12

```
Read SPEC.md and the current Cloudflare Agents SDK and Think docs.
Don't write code yet. Give me a staged build plan, your open
questions as well as the riskiest parts.
```

**Result:** Read SPEC.md and the current Agents SDK and Think docs. Proposed an 8-stage plan, 6 open questions and 8 risks. No code written.

---

## 2. 2026-10-12

```
This plan looks good, A few
changes before we start

First, I want every design to get the same context budget, meaning
the same max tokens reaching the model each turn. Otherwise whichever
one sends more text just wins, and the comparison doesn't tell us
anything about the memory strategy itself. Please add a test that
checks this.

Second, I'd like to keep costs down. Can we pre-write the filler as
user/assistant pairs and insert it with addMessages() so only the
turns that plant facts, change facts, or ask questions actually call
the model? Before relying on that, check whether compaction still
kicks in after addMessages and let me know what you find.

Third, for the grader, I'm going to hand-label around 100 answers
so we can measure how often it agrees with me. Set things up so that's
easy to do.

Answers to your questions:
- Budget: yes, let's use Workers Paid.
- "Combining two conversations" means two far-apart parts of the same
  long conversation, not separate sessions.
- Search: start with FTS5. We'll mention vector search in the README
  as the next design to try.
- Model: go with the cheapest one that reliably passes the tool-call
  test, and use that same model for all three designs.
- Filler: generate it once with an LLM and commit it so every run uses
  the same text.
- Live chat: give each visitor their own random instance.

Let's start with stage 0 only. And remember to log this in PROMPTS.md.
```

**Result:** Added an equal context budget with a test, a hand-labeling CSV workflow, and filler inserted with `addMessages()` to the plan. Confirmed in the Think 0.20.2 source that compaction still runs after `addMessages()`. Stage 0 scaffold built: a Think chat agent with a random instance per visitor, React page, Vitest (6 tests pass with a mock model) and CI. Typecheck and build pass. Not yet deployed: waiting on `wrangler login` and approval to deploy.

---

## 3. 2026-10-12

```
I'm logged in to Cloudflare. Go ahead with npm run deploy, then
test the live URL and check two browsers get separate chats.
After that, commit and push so CI can run.
```

**Result:** Deployed to https://cf-ai-memory-test.cf-ai-memory-test.workers.dev. The live check showed every streamed word doubled, caused by a known workers-ai-provider bug (cloudflare/ai#663). Fixed it with a wrapper around the AI binding (`src/ai/dedupe-binding.ts`) and a regression test, then redeployed. Two separate visitors get separate chats. Committed locally; the push is blocked until GitHub credentials are set up on this machine.

---

## 4. 2026-10-12

```
Pushed. Check the CI run. once it's green, start stage 1
```

**Result:** CI passed on c794bb5. Stage 1 built and deployed: three memory designs (cut-off, built-in, search) behind one `MemoryDesign` interface, an equal context budget enforced on every model call (with tests), `/inspect` memory snapshots, and per-step usage and latency metrics. The smoke test picked Qwen3-30B (15/15 facts saved, cheapest). Fixed Qwen3's inline `<think>` text leaking into replies. 33 tests pass.
