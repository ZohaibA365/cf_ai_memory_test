# cf_ai_memory_test

**Should a chat assistant keep only its recent messages, write itself notes and summaries, or search everything it was told? What does each design get wrong, and what does it cost?**

I built one chat assistant on Cloudflare's [Agents SDK](https://developers.cloudflare.com/agents/) and [Think](https://developers.cloudflare.com/agents/harnesses/think/). It has three interchangeable memory designs, and I tested all three on the same conversations.

**Search remembered best.** It got 94–95% of facts right and barely forgot anything as conversations got longer, at the same cost and speed as keeping only recent messages. Built-in memory came second (79–87%) at 2.5–3.3× the cost and twice the reply time. Keeping only recent messages forgot most facts (39%, then 7%).

- Live chat at https://cf-ai-memory-test.cf-ai-memory-test.workers.dev
- Side-by-side demo with a fast-forward button and the result charts at https://cf-ai-memory-test.cf-ai-memory-test.workers.dev/demo
- The full statistical report is in [analysis/report.md](analysis/report.md)

## The three designs

All three are the same Think agent. They use the same model (`@cf/qwen/qwen3-30b-a3b-fp8` on Workers AI), the same system prompt and the same tools. Only the memory is different ([src/memory/](src/memory/)).

| Design | What reaches the model on each turn |
|---|---|
| Cut-off | The newest messages that fit the budget. Nothing older. |
| Built-in memory | Think's own memory. The model rewrites a memory block with the `set_context` tool, and Sessions compaction replaces older messages with a summary. The newest messages come after that. |
| Search | The newest messages, plus past messages that full-text (FTS5) search finds using the words of the user's latest message. |

I gave every design the same context budget. Every model call from every design gets at most the same 2,000 estimated tokens. That covers the system prompt, memory block, summary, search results, history and tool definitions. Built-in carries the `set_context` tool definition, and that counts too. The budget is enforced on every model step, including the step after a tool call, and [test/budget.test.ts](test/budget.test.ts) checks it. So a design can only win by choosing *what* to keep. It can't win by sending more.

The system prompt is shared as well. One line in it matters for one question type. It says *"If the user asks about something they never told you, say so plainly instead of guessing."* The line applies to all three designs equally, and it's part of why "never said" questions score high for everyone.

## The test

- 20 test conversations ([data/conversations/main-*.json](data/conversations/)), written for this experiment. Each one plants 7 facts and then asks 7 questions, with small talk in between.
- The small talk comes from a pool of 400 exchanges ([data/filler.json](data/filler.json)). I generated it once with the same model and committed it, so every run uses the same text. Checks reject small talk that contains personal details or mentions any answer.
- Five question types. Simple facts. Changed facts ("I live in Toronto", later "I moved to Austin"). Exact details, like numbers and dates. Combining two separate messages, where the second refers to the person only indirectly ("my running buddy"). And things never said. A "never said" question asks about an unmentioned detail of something that *was* mentioned, such as the breed of a puppy whose name was given.
- Two lengths. ×0.5 is the main length, with 66 small-talk exchanges per conversation. ×1 has 132, to show forgetting.
- 3 repeats of every conversation per design and length. That makes 20 × 3 × 3 × 2 = **360 runs** and 2,520 graded answers.
- Every run is a Cloudflare Workflow ([src/experiment/runner.ts](src/experiment/runner.ts)). It plays the conversation into a fresh agent and inserts the small talk without calling the model. Then it grades each answer and writes everything to D1. A run ID never reaches the labeler, so labelling stays blind to the design.
- The pilot and test sets don't overlap. Three pilot conversations (`seed-01`–`03`) set the parameters, and none of them appear in any reported result.

A rule-based grader ([src/experiment/grader.ts](src/experiment/grader.ts)) marks each answer right, wrong or unclear. Unclear answers go to manual review, and that includes hedged ones ("maybe", "I think"). **Where I hand-labelled an answer, my label overrides the grader in every result.** 112 full-run answers have one.

## Results

Fact questions here exclude the "never said" questions. Intervals are 95% and resample whole conversations, because answers within a conversation are correlated. The numbers come from [analysis/report.md](analysis/report.md). The one exception is the memory-block hit rate further down. It comes from the memory blocks saved after each turn ([results/full-1/](results/full-1/)) and isn't in the report.

| Design | Facts right, ×0.5 | Facts right, ×1 | "Never said" right (×0.5 / ×1) | Median reply (p90), ×0.5 | Neurons per run, ×0.5 / ×1 |
|---|---|---|---|---|---|
| Search | **94.7%** (91.3–97.7) | **94.0%** (90.7–97.3) | 95.8% / 93.3% | 2.1 s (3.4 s) | 191 / 200 |
| Built-in memory | 87.3% (81.7–92.7) | 79.3% (74.0–84.3) | 99.2% / 99.2% | 4.8 s (9.9 s) | 472 / 677 |
| Cut-off | 38.7% (32.7–45.7) | 6.7% (3.0–10.7) | 99.2% / 98.3% | 2.2 s (3.5 s) | 192 / 203 |

![Forgetting curve](analysis/figures/forgetting_curve.png)

Every pair of designs differs at both lengths. I used Cochran's Q, then exact McNemar with Holm correction, and every p was ≤ 0.003. At ×1, search beats built-in by 14.7 points (9.0–20.7). Built-in beats cut-off by 72.7 points.

Doubling the small talk cost cut-off 32 points (p < 0.001) and built-in 8 points (p = 0.002). It changed nothing for search (0.7 points, p = 0.73).

Built-in takes about twice as long to reply. Its median is 4.8–5.4 s, and its p90 is about 10 s. Compaction runs while the user's message is being saved, so the user sits waiting for the summary. Search is marginally faster than cut-off (2.25 s vs 2.37 s median of run medians, p = 0.013).

Search costs the same as cut-off (p = 0.15). Built-in costs 2.5× as much at ×0.5 and 3.3× at ×1. At ×1, **its summaries alone cost more than any other design's whole run** (387 of its 677 neurons). The whole 360-run experiment cost 116,128 neurons, or **$1.28**.

![Accuracy by question type](analysis/figures/accuracy_by_type.png)

## What each design gets wrong

| Question type (×1) | Cut-off | Built-in | Search |
|---|---|---|---|
| Simple | 5% | 100% | 100% |
| Exact (numbers, dates) | 1% | 66% | 98% |
| Changed facts | 27% | 95% | 73% |
| Combining two messages | 0% | 70% | 100% |
| Never said | 98% | 99% | 93% |

Cut-off forgets anything older than the budget. Its high "never said" score is the cheapest kind there is. It doesn't remember enough to be tempted.

Built-in is the best at changed facts (95%), because the model rewrites its memory block when a fact changes. It's weaker at exact details and at combining. Those depend on the memory block, and the block loses facts. The model rewrites the whole block with `set_context`, and sometimes it drops older facts while saving a new one. **14.5% of saved facts were later lost at ×0.5, and 20.5% at ×1.** At ×0.5, when the asked fact was in the block, built-in was right 242 out of 243 times. When it wasn't, it was right 20 out of 57 times.

Search finds almost anything it was told. But it's the weakest at changed facts (73%), because a keyword lookup returns the old value as readily as the new one. It also invents answers more often on "never said" questions (93–96%).

![Reply time](analysis/figures/reply_time.png)
![Cost per run](analysis/figures/cost.png)

## How far to trust the grading

I checked the grader against **100 blind hand labels**. The answers were sampled evenly across design and question type, and I labelled them without seeing the design or the grader's verdict. **Agreement was 96/100, Cohen's κ = 0.90.** I didn't tune the grader on these 100. Its rules were tuned on 12 earlier pilot answers, which I kept separate and left out here.

These are all four disagreements.

| Question | Design | Grader | Human | Why they differ |
|---|---|---|---|---|
| How long is my whole trip? | Search | wrong | right | "Your trip duration wasn't specified in our conversation" isn't one of the grader's "never told" phrasings |
| Which book are we reading this month? | Built-in | wrong | right | The reply says "…after dropping *Middlemarch*". The grader knows "dropped" but not "dropping" |
| Which repair shop has my car? | Cut-off | wrong | right | "…sent to Kesler Auto after Duffy's couldn't fix it" isn't recognized as making the old value past |
| Where do I volunteer on weekends? | Cut-off | right | wrong | "If you're referring to the shelter, confirm with the coordinator…" mentions the answer without giving it |

In three of the four, the grader was stricter than I was. So if anything, the accuracy figures slightly understate the designs. Separately, I hand-labelled all 12 answers the grader flagged as unclear in the full run, and those labels count in the results.

## A second, AI grader

As a second opinion, I had an AI judge grade every answer too. It changes no result above. The rule grader stays the main grader, and hand labels override both.

The setup is a coordinator agent with a judge sub-agent. A Workflow ([src/judge/runner.ts](src/judge/runner.ts)) does nothing but feed answers to the coordinator ([src/judge/coordinator.ts](src/judge/coordinator.ts)), 20 at a time. For each answer, the coordinator runs the rule grader itself. Then it hands the answer to its judge sub-agent and records both verdicts in `judge_verdicts`. The judge ([src/judge/agent.ts](src/judge/agent.ts)) is created with the Agents SDK's sub-agent mechanism (`this.dynamicAgents.get(Judge, "judge")`). It has no binding of its own, so only the coordinator can reach it. Sub-agents run on their parent's machine and don't scale out. That doesn't matter here. One coordinator handles all 2,520 answers, because the time goes into waiting on Workers AI. As a consistency check, the coordinator's own rule grades matched the stored ones on 2,520 of 2,520.

The judge runs on `@cf/openai/gpt-oss-120b`. It's stronger than the assistant's Qwen3-30B, which is a mixture-of-experts model that uses about 3B parameters per token. It also has the standard 300-requests-per-minute limit. Its instructions ([src/judge/prompt.ts](src/judge/prompt.ts)) are the grading rules plus the 12 pilot labels as the only examples. It never saw the 100 blind labels, and the tests check that. It replies "VERDICT: right|wrong" plus a one-line reason. Malformed output gets one retry, and after that no verdict.

In the first blind run, 1 of 100 needed one retry. None did in the rerun through the coordinator. In the full run, 73 of 2,420 needed one, and 9 still gave no verdict because they hit the reasoning-token cap.

Here's how both graders did on the 100 blind hand labels.

| Grader | Agreement | Cohen's κ |
|---|---|---|
| Rule grader | 96/100 | 0.90 |
| AI judge | **100/100** | **1.00** |

The judge got all four of the rule grader's disagreements right. Rerunning it through the coordinator gave the same verdict on all 100. There's a caveat, though. With only 100 answers, 100% just shows that the true agreement is probably above about 96%. The judge beat the grader on 4 answers and lost on 0, and that isn't significant (exact McNemar p = 0.125).

On all 2,520 answers, the judge and the rule grader differ on 73 of 2,508 (2.9%). The 12 answers the grader left as unclear aren't counted. [analysis/report.md](analysis/report.md) has the breakdown by design and question type. Most of the differences are on search, and they come from two kinds of question. On exact values (17 of search's 240), the judge is stricter and sometimes wrong. It rejects "552-019" because the accepted answer is written "552019" or "552 019". A person would accept it. On never-said questions (16 of search's 240), the judge is more lenient, and it's mostly right. It counts "Your trip duration wasn't specified" as saying so.

As a robustness check, I recomputed the headline results with the judge's verdicts in place of the rule grader's. Hand labels still override both.

| Fact questions | Rule grader | AI judge | Same conclusion? |
|---|---|---|---|
| ×0.5, cut-off / built-in / search right | 38.7% / 87.3% / 94.7% | 38.7% / 86.0% / 90.0% | – |
| ×1, cut-off / built-in / search right | 6.7% / 79.3% / 94.0% | 6.0% / 78.0% / 90.0% | – |
| Built-in and search beat cut-off (both lengths) | yes, p < 0.001 | yes, p < 0.001 | yes |
| Search beats built-in, ×1 | yes, p < 0.001 | yes, p < 0.001 | yes |
| Search beats built-in, ×0.5 | yes, p = 0.003 | no, p = 0.141 | no |
| Cut-off and built-in get worse when longer, but search doesn't | yes | yes | yes |

**One conclusion changes.** With the judge, search's lead over built-in at the shorter length isn't significant. Mostly that's down to the judge's own errors. Of the 15 search answers the judge marks down at that length, 9 are the hyphen rejections and 3 got no verdict. Across all answers there are 29 judge verdicts like that. When I score them the way the rule grader does, search beats built-in at ×0.5 again (p = 0.008), and no conclusion differs. So the headline holds. Search's lead at ×0.5 is the result that depends most on how strictly exact values are graded.

The judge cost 163,991 neurons ($1.80) for both blind runs plus the full run. That's about 61 per answer, and it's logged in [results/model-costs.jsonl](results/model-costs.jsonl). To reproduce it, run `npm run judge -- run --scope blind|all` and then `npm run judge -- status --job <id>`.

## Rejected designs

The main thing I rejected was replies with thinking off. Qwen3 can be told not to "think" before answering (`/no_think`). I tested this in the pilot on all three designs. It was faster and cheaper, with a median reply of 0.45 s against 1.5–3.8 s, and 91–130 neurons per run against 163–420. But search started making up answers to "never said" questions ("Your blood type is O positive", "Your cat's name is Whiskers"). It got 3 of 6 right instead of 5 of 5. And built-in stopped using its memory. It saved only 14–29% of facts to the memory block, against 79–86% with thinking on.

So the full run kept thinking on. Built-in's *summaries* do run with thinking off, for a different reason (see the limits below).

I also rejected these along the way.

- Built-in with Think's original memory-block wording. In the pilot, that wording lost 68% of saved facts, against 30% for the reworded block ("ALL the facts … every write must include all the facts that still apply"). The full run uses the reworded block. I kept the original as `BuiltinShippedAgent` so the comparison can be repeated.
- Search through Sessions' own `search()`. It treats the whole query as one exact phrase. So a question like "What's my dog's name?" never matches the message that planted the fact. My search design looks up each keyword separately instead, and ranks messages by how many keywords they match.
- The next design I'd try is vector search, with Vectorize embeddings instead of FTS5 keywords. It's the obvious answer to search's weakness on changed facts and paraphrases. I didn't build it for this version.

## Limits

- One model, one budget, synthetic conversations. The results are for Qwen3-30B with a 2,000-token budget. The 20 conversations are fact-dense and hand-written, padded with impersonal small talk from the same model. Real chats are messier, and a larger budget would help cut-off.
- **Built-in keeps the opening messages word for word, so old facts never leave its context.** A manual demo test showed this. I documented it here and didn't fix it, and the designs were not changed. The sequence was "I live in Toronto", small talk, "I just moved to Austin", small talk, then "Where do I live now?". Built-in had Austin in both its memory block and its summary, yet it still asked the user to clarify. The cause is that Sessions compaction always keeps the first 3 messages verbatim. So "I live in Toronto" stays in context forever.
- **Search answered that same test correctly, but only from recent messages.** Its keyword lookup ("live") retrieved the old Toronto messages. Keyword search has no notion of which value is current. That's where the 73% on changed facts comes from.
- Built-in's summaries run with thinking off. With thinking on, Qwen3's reasoning used up the 400-token summary allowance, so summaries came back cut off or empty. Compaction then retried on almost every new message. One test run made 186 summary calls, about 24× the other designs' cost. Summaries now use `/no_think` and ask for about 200 words. After a failed summary, a guard waits for 8 new messages before it tries again. Even so, the summaries are built-in's biggest cost.
- "Never said" questions barely separate the designs. I made them harder after the pilot, where every design scored 100%. They still score 93–99%. The system-prompt line above helps all designs equally here.
- Earlier answers stay in history. Questions come in sequence. Small talk separates them, but search can still retrieve one of the assistant's earlier answers and reuse it.
- The grader is rule-based. It agrees with a human 96% of the time (κ 0.90), and the four disagreements are listed above. "Unclear" answers depend on the hedge-word list.
- The pilot score for built-in (55%) was much lower than the full run's (87%), with the same code and the same grader. Built-in's accuracy tracks whether the fact is still in its memory block. The three pilot conversations packed more facts into each message, and they lost twice as many facts per run. A sample of 3 conversations also gives a wide interval (about 40–69%).
- Reply times are wall-clock times on shared Workers AI hardware, and they include built-in's in-turn summaries. I report medians and p90 rather than means.
- Fact loss is measured by matching expected answers against the memory-block text. So a fact reworded beyond recognition counts as lost.
- 3 repeats per cell. The intervals and tests account for clustering by conversation. They don't account for drift in Workers AI over the 17 minutes of the run.

## Engineering notes

- `workers-ai-provider` (3.1.14–4.0.0) emits every streamed token twice for models that send both the native and the OpenAI-format fields ([cloudflare/ai#663](https://github.com/cloudflare/ai/pull/663)). That also breaks tool-call arguments. [src/ai/dedupe-binding.ts](src/ai/dedupe-binding.ts) removes the duplicate copy. I found one extra case here. Digit tokens arrive with `response` as a JSON *number*, so a text-only fix still doubled numbers ("UA 2291" became "UA 22229911"). I threw away an early check run that had this bug.
- I picked the model with a tool-call smoke test ([scripts/model-smoke.ts](scripts/model-smoke.ts)). Qwen3-30B saved 15 of 15 planted facts with `set_context` and was the cheapest candidate. Llama 4 Scout saved 0 of 15, because it writes tool calls as plain text.
- Every script that calls the model logs its cost to [results/model-costs.jsonl](results/model-costs.jsonl). The whole project cost about 151,000 neurons ($1.66), counting the pilots, checks and the full run. The AI judge added 164,000 neurons ($1.80), so the total is **315,000 neurons, $3.46**. The 1,529 neurons for generating the small talk are an estimate. That run didn't record usage, so I re-measured it on 4 topics.

## Repository

| Path | What it is |
|---|---|
| [src/memory/](src/memory/) | The shared agent ([agent.ts](src/memory/agent.ts)), the equal budget ([tokens.ts](src/memory/tokens.ts)) and the three designs |
| [src/experiment/](src/experiment/) | Conversation format, grader, Workflow runner, pilot analysis helpers |
| [src/judge/](src/judge/) | The AI judge, with its grading coordinator, judge sub-agent and feeding Workflow |
| [src/client/](src/client/) | Chat page and the side-by-side demo with charts |
| [migrations/](migrations/) | D1 schema for runs, turns, answers, hand labels and judge verdicts |
| [data/](data/) | Test conversations (pilot and main) and the small-talk pool |
| [scripts/](scripts/) | Run experiments, check status and cost, export results, hand-labelling round trip, diagnostics |
| [results/](results/) | Exported full-run data, pilot summaries, experiment manifests, cost log |
| [analysis/](analysis/) | Python statistics ([memstats.py](analysis/memstats.py)), report and figures |
| [labels/](labels/) | Hand-labelled answers (CSV) |
| [PROMPTS.md](PROMPTS.md) | Every prompt given to the AI coding tool, with what it did |

## Reproduce

```sh
npm ci && npm test                       # 149 tests (Workers runtime, mock model)
npm run deploy                           # needs `wrangler login` and Workers Paid
npm run db:migrate
npm run experiment -- --id my-run --scale 0.5,1 --repeats 3
npm run experiment:status -- my-run      # progress, results, cost (logged once done)
npm run export:results -- my-run

python3 -m venv analysis/.venv && analysis/.venv/bin/pip install -r analysis/requirements.txt
analysis/.venv/bin/python analysis/run_analysis.py results/my-run
```

To rerun the analysis of the committed full run offline, use `analysis/.venv/bin/python analysis/run_analysis.py`. CI checks that [analysis/report.md](analysis/report.md) matches the committed data.
