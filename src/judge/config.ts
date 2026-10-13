// Judge constants shared by the Worker and the Node scripts (which cannot
// import the Worker-only modules next to this one).

/** Stronger than the assistant's Qwen3-30B; standard (300/min) rate limit. */
export const JUDGE_MODEL = "@cf/openai/gpt-oss-120b";

/** The blind hand-label sample the judge is measured against. */
export const BLIND_BATCH = "full-1-sample-001";
