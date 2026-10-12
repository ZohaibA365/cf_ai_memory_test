// Shared settings for every agent in this project.

// Chosen by the tool-call smoke test (scripts/model-smoke.ts, results in
// results/model-smoke.json): the cheapest candidate that saved 15/15 planted
// facts with set_context. All three memory designs use this one model.
export const MODEL_ID = "@cf/qwen/qwen3-30b-a3b-fp8";

export const SYSTEM_PROMPT =
  "You are a friendly, concise assistant. Answer in a few sentences. " +
  "If the user asks about something they never told you, say so plainly " +
  "instead of guessing.";

// The equal context budget: the most estimated tokens any design may send to
// the model in one call, counting the system prompt, memory, summaries,
// retrieved snippets, history and tool definitions. The pilot (stage 4) sets
// the final value; it is kept small so the cut-off design fails early.
export const CONTEXT_BUDGET_TOKENS = 2_000;

// How the built-in design uses the budget. Compaction triggers once history
// passes the whole budget, keeps half of it verbatim, and caps the summary,
// so right after a compaction it still uses most of the budget (summary +
// tail stay under the trigger, or it would compact on every append). Between
// compactions the shared budget step trims the oldest messages, as for the
// other designs.
export const BUILTIN = {
  memoryBlockTokens: Math.round(CONTEXT_BUDGET_TOKENS * 0.15),
  compactAfterTokens: CONTEXT_BUDGET_TOKENS,
  keepRecentTokens: Math.round(CONTEXT_BUDGET_TOKENS * 0.5),
  summaryMaxTokens: Math.round(CONTEXT_BUDGET_TOKENS * 0.2),
  // Asked for in the summary request so summaries fit under the cap. Before
  // this, 21 of 26 summaries ran past 400 tokens and were rejected.
  summaryTargetWords: 200,
  // After a failed summary, wait for this many new messages before trying
  // again, so a failure cannot trigger a paid call on every append.
  summaryRetryAfterMessages: 8
};

// How the search design splits the budget: retrieved snippets get a fixed
// slice, and recent messages fill the rest.
export const SEARCH = {
  snippetTokens: Math.round(CONTEXT_BUDGET_TOKENS * 0.35),
  maxResults: 8
};
