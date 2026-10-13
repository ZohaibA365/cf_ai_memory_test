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

---

## 10. 2026-10-12

```
Reviewed seed-01. The answers are right, but two fixes:
1. In sister-job, change "Priya just started" to "My sister just started" As written, one message answers the whole combine question, so it doesn't test combining.
2. Remove "Can you note this?" from the flight message so no fact gets an explicit save request the others don't.
Check seed-02 and seed-03 for the same two problems, then give me the stage 4 pilot plan with an estimated neuron cost and make sure to wait for my confirmation before running it.
```

**Result:** seed-01: sister-job now says "My sister just started…" and the flight message no longer asks to be noted. Same check on seed-02/03: removed the explicit save requests ("Please remember…" door code, "Note for later:" bike lock); no other combine question is answerable from one message. Stage 4 pilot plan proposed with an estimated cost of about 20,500 neurons; not run, waiting for confirmation.

---

## 11. 2026-10-12

```
Approved. Build the three pieces, then run both phase A and B and check in with me before C and D.
Answers:
1. Yes, change seed-02 to "My best friend is coming to visit me
   on June 3", as long as an earlier message says Tomasz is my
   best friend.
2. "At most half right" for cut-off is fine, but don't pick a
   length where every design collapses.
One addition: the pilot only sets parameters. The 3 seeds must not be part of the full-run results. The 20 full-run conversations should be new, so we don't tune and report on the same data.
```

**Result:** seed-02 visit message changed; seeds marked split "pilot" (excluded from full runs). Built the reply-thinking setting, smoke-test options and pilot report. Phase A: thinking off saved 15/15 facts (125 neurons). Phase B (11,157 neurons): 33 of 36 runs done; 3 built-in runs at scale 2 failed on the daily free Workers AI limit, so the account is not on Workers Paid. Length rule picks scale 0.5 (cut-off 23%, search 100%). New memory wording lost 16-47% of saved facts vs 64-83% for the original. Waiting for the user before C and D.

---

## 12. 2026-10-12

```
Upgraded to Workers Paid as well as pushed, check CI
- Confirm x0.5 as the main length, and add x1 as a second length in the full run so we get a forgetting curve.
- Rerun the 3 failed runs.
- Go ahead with phases C and D at x0.5.
- Agreed on harder "never said" questions for the 20 new conversations.
Send me the 15 unclear answers in a simple list so that I can review them
```

**Result:** CI passed on 0fc8849. x0.5 confirmed as the main length, x1 added for the full run; harder never-said questions planned for the 20 new conversations. Reruns now clear old errors and log only new cost. Restarted the 3 failed phase B runs (one needed a second try after an expired Wrangler token). Phase C (thinking off, 1,325 neurons): replies ~0.45 s and 91-130 neurons/run, but search made up answers to never-said questions and built-in saved only 14-29% of facts. Phase D ran with thinking on (6,578 neurons). Sent the 12 unclear answers (not 15, a counting error) for review.

---

## 13. 2026-10-12

```
My labels: 1 wrong, 2-11 are right and 12 wrong.
Update the grader:
- never-said: right if it clearly says never told; mentioning the other item as context is fine. Wrong only if it gives the confusable value as the answer.
- "X, not Y" negation counts as right.
- combine questions missing a part: wrong, not unclear.
- answering with both old and new values, or asking which is current: wrong
Re-grade the pilot with the new rules. Note these 12 were used to tune the grader, so measure grader agreement later on separate hand-labelled answers, not these.
```

**Result:** Imported the user's 12 labels (batch pilot-b-review-001, marked as the grader tuning set). Grader v2: never-said is right when it says never told even with context; "X, not Y" is right; missing combine parts and old+new answers are wrong; answers record their grader version. Re-graded 480 pilot answers: 14 unclear became right, 6 became wrong, no right/wrong flips; v2 matches all 12 labels. Combined pilot (B+D, 9 runs per cell at x0.5): length rule still picks x0.5.

---

## 14. 2026-10-12

```
Keep thinking on for the full run. Yes, add the rule that flags hedged answers (such as "maybe", "I think") as unclear so we keep a review queue. Go ahead and write the 20 new conversations with harder "never said" questions and make sure to send them to me to review before anything runs.
```

**Result:** Full run keeps reply thinking on. Grader v3: hedged answers ("maybe", "I think", "probably"...) are unclear and go to review; more past-tense words for changed facts. Re-graded the pilot: 3 of 480 answers flagged as hedged. Wrote the 20 main conversations (split "main") with harder never-said questions (an unmentioned detail of something mentioned); fixed answer leaks into filler; no combine question answerable from one message, no save requests. Sent to the user for review; nothing run.

---

## 15. 2026-10-12

```
I have Reviewed all 20, answers are correct. Three fixes, all questions that can be answered by guessing:
1. main-09: replace "How long have I been playing piano?" with a never said question that isn't hinted at, since "I've started lessons" implies "just started".
2. main-12: change what the coordinator asked me to run to something not mentioned elsewhere in the conversation (not the adoption fair).
3. main-19: replace Fontainebleau with a place not known for climbing.
Re-run your leak checks after the changes. Then go ahead with the full run: 360 runs
```

**Result:** Fixed the 3 guessable questions (main-09 never-said is now Clementine's last name; main-12 coordinator asks me to lead the volunteer orientation; main-19 trip is to Rotterdam); leak, combine and save checks clean. Added auth retry and --resume to the trigger script. Full run full-1: 360/360 runs done in ~17 min, 0 failures, 116,128 neurons ($1.28). Fact accuracy x0.5/x1: search 95%/94%, built-in 88%/79%, cut-off 39%/7%; 12 answers flagged unclear for review.

---

## 16. 2026-10-13

```
check CI. Before anything else: built in went from 55% in the pilot to 88% here, while the other designs barely changed. Explain why and show me evidence so i can take a look before we trust that number. Then do the labelling in chat. Send the 12 unclear answers first,
then the 100 blind answers in batches of 20. Number each one and show the question, the correct answer and the assistant's reply, but not the grader's verdict. Load my labels into the database after each batch after I have approved. After that, start stage 6, the demo page.
```

**Result:** CI passed on 2279bff. Built-in's pilot-to-full jump (55% to 88%) traced to the conversations, not code or grading: same agent code and grader v3; built-in is right ~100% when the fact is in its memory block and 15-35% when not; the block held the asked fact 52% of the time in the pilot vs 81% in the full run (fewer losses per run, fewer multi-fact messages); pilot CI ~40-69% from 3 conversations. Sent the 12 unclear answers.

---

## 17. 2026-10-13

```
all wrong except 1, 5, 8, 12
```

**Result:** Read back the 12 labels for approval (right: 1, 5, 8, 12). Exported the 100-answer blind sample (flagged answers excluded) and sent batch 1.

---

## 18. 2026-10-13

```
Confirmed, load the 12. Batch 1: all right except 3, 4, 6, 14, 15, 17
```

**Result:** Loaded the 12 unclear labels (4 right, 8 wrong). Read back batch 1, sent batch 2.

---

## 19. 2026-10-13

```
Batch 1 confirmed. Batch 2: all right except 23, 24, 28, 29, 31, 33
```

**Result:** Loaded batch 1 (14 right, 6 wrong). Read back batch 2, sent batch 3.

---

## 20. 2026-10-13

```
Batch 2 confirmed. Batch 3: all right except 52, 56
```

**Result:** Loaded batch 2. Read back batch 3, sent batch 4.

---

## 21. 2026-10-13

```
Batch 3 confirmed. Batch 4: all right except 61, 62, 66, 68, 69, 70, 75, 78, 79
```

**Result:** Loaded batch 3. Read back batch 4, sent batch 5.

---

## 22. 2026-10-13

```
Batch 4 confirmed. Batch 5: all right except 92, 98
```

**Result:** Loaded batch 4. Read back batch 5; provisional grader agreement 96/100, kappa 0.90, with the four disagreements listed.

---

## 23. 2026-10-13

```
Batch 5 confirmed, load it. don't tune the grader on these 100, and report the four disagreements in the README. Also note in the README that where my labels exist, they override the grader. Push when ready, then start stage 6, the demo page.
```

**Result:** Loaded batch 5: 100 blind labels, grader agreement 96/100 (kappa 0.90). README notes recorded (no tuning on these 100, four disagreements, labels override the grader). Pushed. Stage 6 built and deployed: /demo shows the three designs side by side with one shared message box, a capped fast-forward (24 exchanges, no model calls), per-design memory panels, and results charts from /api/results (hand labels override the grader; pilot data not served). Found and fixed a crash on send (an effect returned scrollIntoView's Promise), with a guard test. End-to-end check in headless Chrome: 46 neurons, logged. 132 tests pass.
