# SPEC: Agent Memory Comparison on Cloudflare

## Goal

Build a chat assistant with long-term memory on Cloudflare's Agents SDK. Then run an experiment that compares three memory designs on recall, response time and cost.

The experiment answers one question. Which memory design remembers best, what does it fail at, and what does it cost in speed and money?

## The three memory designs

All three are the same assistant. Only the memory is different.

1. Cut-off. It keeps only the most recent messages.
2. Built-in memory. It uses Think's memory, which means summaries plus memory blocks the model can read and write.
3. Search. It keeps everything and looks up relevant past messages when a question comes in.

The designs sit behind one shared interface, so the test can swap them.

## The test

Each test conversation plants some facts. Then it goes on for a long time with unrelated talk. At the end it asks questions about the facts.

There are five question types.

1. Simple facts ("What's my dog's name?")
2. Changed facts ("I live in Toronto", then later "I moved to Austin")
3. Exact details, like numbers and dates
4. Combining two separate conversations
5. Things never said, where the correct answer is "you never told me"

Every question has a known correct answer. A grader marks each answer right or wrong.

## What gets measured

Each design runs on the same test conversations. For each one I measure:

- Recall accuracy, overall and per question type
- Response time per reply, as the conversation grows
- Cost, as model usage per conversation

## Fairness rules

- All three designs use the same model, the same prompts and the same test conversations.
- Each test conversation runs 3 times per design, because model answers vary.
- Grading starts with a rule-based check. Does the answer contain the correct fact and not the outdated one? Anything unclear gets flagged for manual review.
- A small pilot decides the conversation length. It should be long enough that the cut-off design starts failing.

## Deliverables

1. A deployed chat assistant anyone can talk to
2. A test runner (a Workflow) that plays every test conversation through each design and records the results
3. A results database (D1)
4. A demo page with three assistants side by side, a "fast-forward" button, a panel showing what each one remembers right now, and charts
5. Python analysis of the results, with charts and a significance test
6. A README with the question, the numbers, a design that was rejected, and the limits

## Constraints

- TypeScript on Cloudflare Workers, using the Agents SDK and Think
- Workers AI for the model
- Free tier wherever possible. Start with short conversations and scale up.
- The repo name starts with `cf_ai_`
- `PROMPTS.md` records every prompt given to the AI coding tool
- Tests for every module, and CI
- No secrets in code

## Version 1 is done when

- The assistant is deployed and chat works at a live URL
- All three memory designs work
- 20 test conversations have run through all three designs
- There's a results table with recall, response time and cost per design

## Out of scope for version 1

- Voice
- User accounts or login
- More than three memory designs
- Anything not needed for the first results table

## Working rules for the AI coding tool

- Read the current Cloudflare Agents SDK and Think docs before writing code. Never guess an API.
- Plan first. Propose a staged plan, open questions and the riskiest parts before coding.
- Build one stage at a time. Each stage must work before the next one starts.
- After each request, add the exact prompt to `PROMPTS.md` with the date and a one-line result.
- When a new file is finished, explain it in plain language.
