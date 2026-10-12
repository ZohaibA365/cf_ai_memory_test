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

---

## 5. 2026-10-12

```
Pushed, check CI. Keep the "say so instead of guessing" line, and note it in the README later. Agreed on testing /no_think in the stage 4 pilot. Once CI is green, start stage 2.
```

**Result:** CI passed on adaac87. Stage 2 built: a validated conversation format, a rule-based grader (right/wrong/unclear), a 400-pair filler pool generated once with Qwen3-30B and committed, and 3 hand-written seed conversations covering all five question types. Data tests check the filler for personal details and answer leaks. 66 tests pass.

---

## 6. 2026-10-12

```
Pushed, check CI. From now on, record the neuron cost of every script that calls the model, including the filler generation if you can recover it. Once CI is green, start stage 3.
```

**Result:** CI passed on 8159d33. Added a cost log (results/model-costs.jsonl) for every model-calling script; the filler run cost was recovered as an estimate (about 1,529 neurons) by re-measuring 4 topics. Stage 3 built: D1 schema, a Workflow runner, experiment/status/labels scripts, 81 tests. Found and fixed numbers being doubled in model output (digit tokens arrive as JSON numbers). Clean check run stage3-check-2 (1 conversation × 3 designs) landed in D1; it showed built-in compaction calling the summarizer 186 times per run because thinking exhausts its 400-token cap (decision pending).

---

## 7. 2026-10-12

```
Go with A, and add the retry guard. Note in the README that summaries run with thinking off and why. Pushed, check CI. Once it's green, rerun the clean check on seed-01 so we can confirm built in's cost is back in line with the others
```

**Result:** CI passed on 982e2a1. Summaries now run with thinking off (/no_think); cut-off or empty summaries are rejected, and a retry guard waits for 8 new messages after a failure. Rerun stage3-check-3 (1,078 neurons): built-in fell from 4,074 to 750 neurons per run and its latency matches the others, but 21 of 26 summaries still failed, probably at the 400-token cap, so its cost is not yet in line (decision pending).

---

## 8. 2026-10-12

```
check CI. Before changing anything, show me the recorded failure reasons from the seed-01 run so we confirm the summaries are failing because they run past the cap. If that's the cause, go with 1: ask for a summary under about 200 words and keep the 400- oken cap. Then rerun seed-01 and show me how many summaries
succeeded.
```

**Result:** CI passed on e4f0d3c. Exposed the per-attempt compaction log on /inspect (read-only): all 21 failed summaries in stage3-check-3 were cut off at the 400-token cap. Summary requests now ask for about 200 words (cap unchanged). Rerun stage3-check-4 (762 neurons): 20 of 20 summaries succeeded, 0 failed, 0 skipped; built-in at 434 neurons per run vs about 163. Also found: built-in's memory block was overwritten down to one fact by set_context, and in-turn compaction raised its median latency to 3.7 s.

---

## 9. 2026-10-12

```
check CI. Reword the memory block description so it's
clear the block holds all facts and every write must keep the ones that still apply. For the main experiment, use the new wording. Keep the old wording as a variant, and in the stage 4 pilot measure how often each version loses facts, so we can report the difference. Agreed on latency: report it, don't hide it. Then rerun seed-01 once and show me the memory block at the end
```

**Result:** CI passed on a3ac0de. New memory-block wording (block holds all facts; every write keeps the ones that still apply) is the main version; the original wording is kept as the BuiltinShippedAgent variant (`--builtin-variants main,shipped`), and built-in turns now record the memory block after each turn for the pilot's fact-loss measurement. Rerun stage3-check-5 (760 neurons): final memory block "my dog is called Biscuit, and I live in Austin". The new wording did not prevent the loss in this run: the move turn rewrote the block and dropped the flight and sister facts. 86 tests pass.
