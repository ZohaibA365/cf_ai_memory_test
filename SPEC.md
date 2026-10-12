# SPEC: Agent Memory Comparison on Cloudflare

## Goal

Build a chat assistant on Cloudflare's Agents SDK with long-term memory, and run an experiment that compares three memory designs on recall, response time and cost.

The question the experiment answers: **which memory design remembers best, what does it fail at, and what does it cost in speed and money?**

## The three memory designs

All three are the same assistant. Only the memory differs.

1. **Cut-off:** keeps only the most recent messages.
2. **Built-in memory:** uses Think's memory (summaries and memory blocks the model can read and write).
3. **Search:** keeps everything and looks up relevant past messages when a question comes in.

The designs must sit behind one shared interface so the test can swap them.

## The test

Each test conversation plants facts, continues for a long time with unrelated talk, then asks questions about the facts.

Five question types:

1. Simple facts ("What's my dog's name?")
2. Changed facts ("I live in Toronto" then later "I moved to Austin")
3. Exact details (numbers, dates)
4. Combining two separate conversations
5. Things never said (correct answer: "you never told me")

Every question has a known correct answer. A grader marks each answer right or wrong.

## What gets measured

For each design, on the same test conversations:

- **Recall accuracy**, overall and per question type
- **Response time** per reply, as the conversation grows
- **Cost**: model usage per conversation

## Fairness rules

- All three designs use the same model, the same prompts and the same test conversations.
- Each test conversation runs 3 times per design, because model answers vary.
- Grading: a rule-based check first (does the answer contain the correct fact and not the outdated one). Anything unclear gets flagged for manual review.
- Decide conversation length from a small pilot: long enough that the cut-off design starts failing.

## Deliverables

1. A deployed chat assistant anyone can talk to
2. A test runner (a Workflow) that plays every test conversation through each design and records results
3. A results database (D1)
4. A demo page: three assistants side by side, a "fast-forward" button, a panel showing what each one currently remembers, and charts
5. Python analysis of the results (charts, significance test)
6. A README: the question, the numbers, a design that was rejected, and the limits

## Constraints

- TypeScript on Cloudflare Workers, using the Agents SDK and Think
- Workers AI for the model
- Free tier wherever possible; start with short conversations and scale up
- Repo name starts with `cf_ai_`
- `PROMPTS.md` records every prompt given to the AI coding tool
- Tests for every module, and CI
- No secrets in code

## Version 1 is done when

- The assistant is deployed and chat works at a live URL
- All three memory designs work
- 20 test conversations have run through all three designs
- There is a results table with recall, response time and cost per design

## Out of scope for version 1

- Voice
- User accounts or login
- More than three memory designs
- Anything not needed to produce the first results table

## Working rules for the AI coding tool

- Read the current Cloudflare Agents SDK and Think docs before writing code. Never guess an API.
- Plan first: propose a staged plan, open questions and the riskiest parts before coding.
- Build one stage at a time. Each stage must work before the next starts.
- After each request, append the exact prompt to `PROMPTS.md` with the date and a one-line result.
- Explain each new file in plain language when it is finished.
