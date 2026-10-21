# SUMMARY: the token budget in Rust/WebAssembly

Written 2026-10-21, at the end of an unattended session. It covers what was built, every decision taken without asking, how to verify it, and what to double-check. Section 9 is a short state-of-the-repo note, including one unrelated fix (LinkedIn link previews) made in the same session.

## 1. What changed, in one paragraph

The token-budget step that runs before every model call moved from TypeScript to Rust, compiled to WebAssembly and loaded by the Worker. Rust (`rust/budget/src/lib.rs`) now holds the counting rules and makes the budget decision for all three memory designs:
- text tokens are `ceil(len / 4)`;
- each message adds 4 tokens;
- the window is the newest contiguous run of messages that fits;
- the newest message is always kept;
- a tool result is never left at the front of the window.

TypeScript (`src/memory/tokens.ts`) keeps its public API (`estimateTextTokens`, `estimateMessageTokens`, `estimateMessagesTokens`, `estimateToolTokens`, `fitToBudget`), so no caller changed. Those functions now measure each text's length and call into the module. The results are identical to the old code on every input tested. Section 5 has the evidence.

## 2. Files

| File | Role |
|---|---|
| `rust/budget/Cargo.toml` | Crate. `crate-type = ["cdylib", "rlib"]`: `cdylib` produces the `.wasm`, `rlib` lets `cargo test` link it natively. Release profile: `opt-level = "s"`, `lto = true`, `codegen-units = 1`, `panic = "abort"`, `strip = true`. |
| `rust/budget/src/lib.rs` | The logic (`text_tokens`, `message_tokens`, `fit_to_budget`), the `extern "C"` WebAssembly interface (`mod ffi`), and 13 unit tests. |
| `scripts/build-wasm.ts` | `npm run build:wasm`. Runs `cargo build --release --target wasm32-unknown-unknown` and copies the result to `src/memory/wasm/budget.wasm`. Finds `cargo` on PATH or in `~/.cargo/bin`. |
| `src/memory/budget-wasm-glue.ts` | `createBudgetEngine(module)`: instantiates the module and moves data in and out of its memory. No bundler-specific imports, so Node can use it (the benchmark does). |
| `src/memory/budget-wasm.ts` | Two lines. `import budgetModule from "./wasm/budget.wasm?module"` and the one engine instance the Worker uses. |
| `src/memory/message-text.ts` | `messageText` (moved here unchanged from `tokens.ts`) and the new `messageTextLength`. Re-exported from `tokens.ts`, so `builtin.ts` and `search.ts` still import from `./tokens`. |
| `src/memory/tokens.ts` | Same exports as before. The bodies now call the engine. |
| `src/wasm-modules.d.ts` | TypeScript type for `*.wasm?module` imports (`WebAssembly.Module`). |
| `test/reference/tokens-reference.ts` | The old `tokens.ts`, copied unchanged from commit `b915d9f`. The tests use it as the reference implementation. The Worker never imports it. |
| `test/budget-wasm.test.ts` | Integration and equivalence tests (Section 5). |
| `scripts/bench-budget.ts` | `npm run bench:budget`. Times the old and new budget step per call (Section 6). |
| `.github/workflows/ci.yml` | The `test` job installs Rust 1.99.1 with the wasm target. A new `rust` job runs `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test` and the wasm build. |
| `package.json` | `build:wasm`, `test:rust` and `bench:budget` added. `test`, `build`, `dev` and `deploy` run `build:wasm` first. |
| `.gitignore` | Ignores `rust/*/target/` and `src/memory/wasm/` (build output). |

## 3. How it works at runtime

1. **Loading.** The Cloudflare Vite plugin turns `import x from "./budget.wasm?module"` into a Worker module of type `CompiledWasm`. `wrangler deploy --dry-run` lists `assets/budget-*.wasm  compiled-wasm  17.46 KiB`. The runtime compiles it when the Worker is uploaded, and the import gives a `WebAssembly.Module`.
2. **Instantiation.** `new WebAssembly.Instance(module, {})` runs synchronously, once per isolate, when `budget-wasm.ts` is first loaded. That works because the module has **no imports**: no wasm-bindgen glue, no WASI, and no host functions. I checked this with `WebAssembly.Module.imports()`, which returns `[]`. The exports are `memory`, `budget_alloc`, `budget_free`, `budget_text_tokens`, `budget_message_tokens` and `budget_fit`.
3. **A budget call** (`fitToBudget`):
   - TypeScript computes the system prompt's length and each message's text length, in UTF-16 code units, plus a tool-result flag per message.
   - It writes them into one reusable scratch buffer in the module's linear memory, laid out as `[f64 result][u32 × n lengths][u8 × n flags]`. The buffer is 8-byte aligned, which also aligns the `f64` and `u32` slots.
   - It calls `budget_fit(systemLen, lensPtr, flagsPtr, n, toolTokens, budget, outPtr)`.
   - Rust returns the index of the first kept message and writes the estimated tokens to the `f64` slot.
   - TypeScript returns `messages.slice(start)`. It's the same array of message objects, not copies, so object identity is preserved, and the tests check this.
4. **Memory safety across the boundary.**
   - The scratch buffer grows by doubling (minimum 4 KiB). Growing frees the old block and allocates a new one, which can grow the module's memory. That detaches every existing `ArrayBuffer` view, so typed-array views are always created after `reserve()`.
   - `budget_fit` allocates nothing, so views stay valid across the call.
   - Calls are synchronous with no `await` between write and call, so concurrent requests in the same Durable Object can't interleave on the buffer.

## 4. Decisions made without asking

1. **Lengths cross the boundary, not text.** This is the most important decision.
   - **First version.** It passed each message's text as UTF-8 (via `TextEncoder.encodeInto` into wasm memory), and Rust counted UTF-16 units from the bytes: 1 unit per lead byte of a 1–3 byte character, 2 for a 4-byte character, 0 for continuation bytes. It was correct.
   - **Benchmark.** The first version measured **69 µs median per call against 8.6 µs for the old TypeScript**, 8× slower. A breakdown showed about 32 µs was UTF-8 encoding and about 9 µs was building every message's text.
   - **Why lengths are enough.** The old estimator was `Math.ceil(text.length / 4)`, so its only input is the UTF-16 length. JavaScript stores that with every string, and reading it is O(1). Passing the length is exact by construction: no transcoding, so nothing to diverge.
   - **What Rust still owns.** All the rules: rounding, overhead, the newest-first walk, the stop condition and the tool-result rule.
   - **What remains in TypeScript.** Producing a message's text length, which needs JavaScript's own `JSON.stringify` for tool-call and tool-result parts. Reproducing `JSON.stringify` exactly in Rust (key order, number formatting, escaping) would be a large, fragile surface for no gain.
2. **`messageTextLength`.** It computes `messageText(m).length` without building the string: the part lengths plus one per `"\n"` separator, with `null` and `undefined` parts counting as empty, like `Array.prototype.join`. This took the call from 14.5 µs to 9.0 µs. A test checks it against `messageText(m).length` on 3,000 random messages plus edge cases (empty part arrays, null and undefined parts, unknown part types, text parts with no text).
3. **No wasm-bindgen or wasm-pack.** The interface is a few numbers and two flat arrays, so plain `#[no_mangle] extern "C"` exports and about 60 lines of hand-written glue are enough. That gives no generated JavaScript to bundle, no wasm-bindgen CLI to keep version-matched with the crate, a 17.9 KB module, and a module with no imports, so it can be instantiated synchronously. The cost is that the glue is unsafe by hand: pointer, length and alignment discipline is manual. It's documented with `# Safety` sections and covered by the FFI tests.
4. **`f64` for all budget arithmetic.** JavaScript numbers are `f64`, so `used + cost > budget` must compare the same way for fractional, zero, negative, NaN and ±Infinity budgets. Two examples: NaN means nothing is ever dropped, and -Infinity still keeps the newest message. Token counts are integers far below 2^53, so the `f64` sums are exact. Lengths are `u32` at the boundary, since V8 strings are under 2^30 units, and `text_tokens` widens to `u64` before `div_ceil`, so `u32::MAX` doesn't overflow.
5. **One walk.** `fit_to_budget` (over `&[Message]`) and `budget_fit` (over raw arrays) both call one generic `fit()` that takes accessor closures. There is no duplicated algorithm.
6. **The old TypeScript stays as a test oracle** (`test/reference/`), copied byte for byte from git HEAD. Without it, equivalence couldn't be checked. It's not in the Worker bundle, because only tests import it.
7. **Build output isn't committed.** `src/memory/wasm/budget.wasm` is built by `npm run build:wasm`, which `test`, `build`, `dev` and `deploy` run first. That means anyone running the tests needs Rust installed. The README says so, and the build script fails with install instructions if `cargo` is missing. The alternative was committing the 18 KB binary; I rejected it because it can drift from the source unnoticed.
8. **Toolchain.**
   - I installed Rust 1.99.1 through rustup with `--no-modify-path`, so your shell profile wasn't touched. `~/.cargo/bin` isn't on your PATH, which is why `build-wasm.ts` falls back to it. If you want `cargo` in your shell, add `. "$HOME/.cargo/env"` to `~/.zshrc`.
   - The `clippy` and `rustfmt` components are installed.
   - CI pins 1.99.1, so a new stable release or clippy lint can't break CI unexpectedly. Bump it on purpose.
9. **CI layout.** The `test` job needs Rust because `npm test` builds the module. A separate `rust` job runs format, lint, unit tests and the wasm build, so a Rust failure shows up as its own red job. `Swatinem/rust-cache` caches `rust/budget/target`.
10. **The live demo was redeployed** with this change (Section 7) so the eval could run against it. The rollback target is listed there.
11. **No commit and no push.** You asked last session not to commit or push until you say so, and that instruction still covers the staged README and PROMPTS.md. Everything is in the working tree. The CI changes are therefore checked locally (Section 5) but haven't run on GitHub yet.
12. **The task says "149 tests".** The suite had 151 before this work, because the demo polish added two. It now has 161 (Section 5).

## 5. Verification

Every command below was run, and all passed.

| Check | Command | Result |
|---|---|---|
| Rust unit tests | `npm run test:rust` | 13 passed |
| Rust format and lint | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` | clean |
| Worker tests (workerd, mock model) | `npm test` | **161 passed**: the 151 that passed before, unchanged, plus 10 new |
| Typecheck | `npm run typecheck` | clean |
| Generated types | `npx wrangler types && git diff --exit-code worker-configuration.d.ts` | unchanged |
| Production build | `npm run build`, `wrangler deploy --dry-run` | builds; the wasm is attached as `compiled-wasm` |
| Analysis CI job | not affected (no Python or data changes in this task) | n/a |

The 10 new tests are in `test/budget-wasm.test.ts`:
- **The Worker calls the module (×3, one per design).** A real agent turn in a Durable Object runs: a long history, then a user message, plus a `set_context` tool call for built-in. The test asserts the engine's call counter went up during the turn. It then measures every prompt the mock model actually received with the **old TypeScript estimator** and asserts it's ≤ 2,000 and > 1,600 (the budget is used, not starved).
- **The public functions go through the module.** `estimateTextTokens`, `estimateMessageTokens` and `fitToBudget` each make exactly one call.
- **`messageTextLength` equals `messageText().length`.** 3,000 random messages plus edge cases.
- **Token estimates are identical.** 3,000 random texts and 3,000 random messages. The text pieces cover every UTF-8 width plus the JavaScript-specific cases: emoji, ZWJ sequences, flags, CJK, combining marks, a BOM, zero-width space, NUL, unpaired surrogates `\ud800` and `\udc00`, and `\u{10ffff}`.
- **`fitToBudget` is identical** on 1,500 random histories (0–59 messages; user, assistant, reasoning, tool-call, tool-result and system parts). Each is tested at 14 budgets: random, the exact total, total − 1, half, and the odd set 0, 1, 3, 9.5, −5, 2000, 2000.25, NaN, ±Infinity. The test compares `estimatedTokens`, `droppedMessages` and the identity of every kept message object.
- **A large history.** 5,000 messages and a 200,000-character system prompt, which grows the scratch buffer.
- **The real test conversations (×2, one per length).** All conversations in `data/conversations/`, built with the real committed small talk (`fillerFor`) at ×0.5 and ×1. At every point where the experiment calls the model, both implementations are compared with each design's kind of system prompt: the plain prompt, a prompt plus a memory block with built-in's tool tokens, and a prompt plus search snippets.

**Do the tests catch real bugs?** I broke the Rust code on purpose, rebuilt, and ran the tests:

| Deliberate bug | Tests that failed |
|---|---|
| Counting UTF-8 bytes instead of UTF-16 units (first, text-based design) | 5 of 9 in the new file. The real-conversation test failed with `main-02 ×0.5 q-changed: expected 2000 to be 1999`: the real data has non-ASCII text, so the obvious Rust `str::len()` would have changed actual budget decisions. |
| Rounding down instead of up (`/ 4`) | 8 of 17 across the budget test files |
| `>=` instead of `>` in the stop condition | 3 of 17. The Rust unit test also failed. |

Each mutation was reverted, and the reverts were checked with `diff` against a backup.

## 6. Latency and cost: does WebAssembly change the reported numbers?

**No.** The project's reported reply times (median 2.1–5.4 s per reply, in `analysis/report.md` and the README) were all measured with the TypeScript budget step, in the `full-1` run on 2026-10-13. This change doesn't touch that data, and nothing was re-measured into it.

The overhead the change adds, measured with `npm run bench:budget`:
- Node 22, the same V8 engine family as workerd. Timing is in Node because Workers freeze `performance.now()` during execution, a Spectre mitigation.
- 20 real histories of 292 messages each, as at the last question of a ×1 conversation.
- 6,000 timed calls each, after JIT warm-up.

| | Median per call | p99 |
|---|---|---|
| Old TypeScript `fitToBudget` | 6.7 µs | 11.0 µs |
| Rust/WebAssembly, lengths passed (shipped) | 9.0 µs | 13.4 µs |
| Rust/WebAssembly, text passed as UTF-8 (first version, not shipped) | 68.8 µs | 205.9 µs |

The shipped version adds about **2.3 µs per model call**. Against a 2.1 s median reply, that's about 1 part in 900,000, far below run-to-run noise on shared Workers AI hardware. The remaining gap is structural: the TypeScript stopped after measuring the ~50 newest messages, while the Rust path receives all of them in one call. Moving the early stop into Rust would need a callback per message from WebAssembly into JavaScript, which costs more than it saves.

Startup is a one-time cost per isolate:
- compiling the module takes 0.24 ms, but in Workers it happens at upload, not on a request;
- instantiating it takes 0.17 ms.

The Worker upload grew by 17.46 KiB for the compiled module.

**There was no performance reason to move this to Rust**, and it's worth being clear about that. The budget step is a small, pure, branchy function over integers, which is the best case for V8's JIT. Its value as a Rust exercise is elsewhere:
- an exact cross-language equivalence problem (UTF-16 vs UTF-8, `f64` comparison semantics);
- a hand-written FFI with memory-growth and alignment hazards;
- a build and CI integration;
- a clean place to measure boundary costs.

I kept the task's choice of hot path (token-budget enforcement) and didn't switch to another. Nothing else in the Worker is CPU-bound either. The time goes into waiting on Workers AI and Durable Object storage.

Cost isn't affected. The estimate decides what reaches the model, and it's identical, so token usage and neurons are unchanged.

## 7. Live check on the deployed Worker

Deployed as Worker version **`7d6c69ee-7f64-4949-b873-2882c7024392`** on 2026-10-21. **Rollback:** `npx wrangler rollback 2205e212-5dee-45b9-a5ad-19d9eb7ba711`, the version from the day before, which has the LinkedIn preview fix and the TypeScript budget.

Smoke test: `/demo`, `/api/results`, `/og-image.png` and `/agents/{cutoff,builtin,search}-agent/…/inspect` all return 200. The agent requests wake a Durable Object, which loads and instantiates the module.

**A slice of the real eval** ran through the deployed Rust/WebAssembly path. It used experiment `rust-check-1` (manifest in `results/experiments/rust-check-1.json`): conversation `main-01`, all three designs, ×0.5 and ×1, one repeat each. That's 6 runs and 84 model calls, costing **1,902.6 neurons ($0.021)**, logged in `results/model-costs.jsonl`. It isn't in the public results: `/api/results` and the analysis only read `full-1`.

Budget enforcement, per scored turn, compared with the same conversation in `full-1` (3 repeats, TypeScript budget, 2026-10-13):

| Design, length | Run | Turns | Max estimated tokens | Mean estimated | Turns over 2,000 | Mean history messages kept |
|---|---|---|---|---|---|---|
| Cut-off ×0.5 | full-1 / rust-check-1 | 42 / 14 | 2000 / 2000 | 1580 / 1584 | 0 / 0 | 85 / 85 |
| Cut-off ×1 | full-1 / rust-check-1 | 42 / 14 | 2000 / 1999 | 1726 / 1729 | 0 / 0 | 157 / 157 |
| Search ×0.5 | full-1 / rust-check-1 | 42 / 14 | 2000 / 1999 | 1597 / 1598 | 0 / 0 | 85 / 85 |
| Search ×1 | full-1 / rust-check-1 | 42 / 14 | 2000 / 1999 | 1751 / 1752 | 0 / 0 | 157 / 157 |
| Built-in ×0.5 | full-1 / rust-check-1 | 42 / 14 | 1529 / 1474 | 1221 / 1189 | 0 / 0 | 20.4 / 18.9 |
| Built-in ×1 | full-1 / rust-check-1 | 42 / 14 | 1994 / 1781 | 1509 / 1480 | 0 / 0 | 36 / 28.1 |

How to read the table:
- No turn exceeded the budget in either run.
- Cut-off and search fill the budget to within a token or two, as before.
- "History messages" is the number of messages the agent held, before the budget step.
- The estimates can't be identical turn for turn, because the model's earlier replies differ in length between runs, and those replies are part of the history being fitted.
- Built-in varies more because its history also depends on when compaction ran and what the model wrote into its memory block. Both are model output.
- The deterministic equivalence is what Section 5 proves. This table shows the deployed module behaves the same way in production.
- The `full-1` built-in rows show a model-reported `input_tokens` of up to 5,038 per turn, and `rust-check-1` up to 3,483. That isn't a budget breach: it's the sum over the two model calls in a turn where the model calls `set_context`. Each call is budgeted on its own, and this was the same before.

Answers right (7 questions per run, including the "never said" questions):

| | Cut-off ×0.5 | Cut-off ×1 | Built-in ×0.5 | Built-in ×1 | Search ×0.5 | Search ×1 |
|---|---|---|---|---|---|---|
| rust-check-1 (1 run) | 2/7 | 2/7 | 5/7 | 7/7 | 7/7 | 7/7 |
| full-1, same conversation (3 runs) | 9/21 | 6/21 | 18/21 | 14/21 | 21/21 | 20/21 |

These are single runs with sampled model output, so they can't prove the same pass/fail answer by answer. Even the old code didn't give that between its own repeats. The ordering is the same, and each count is within what the three `full-1` repeats produced on this conversation. **The deterministic part of pass/fail is the budget decision, and Section 5 shows it's identical.**

The median reply times of these runs (1.5–4.8 s by design and length) are close to the `full-1` figures. But 14 turns per cell on shared Workers AI hardware is far too few to detect anything near the 2.3 µs the change adds per call. The reported latency numbers stay the `full-1` ones, measured with TypeScript.

## 8. Limitations and things to double-check

- **The CI changes haven't run on GitHub** (no push, see 4.11). I ran every CI step locally. The first push will be the real test of the `dtolnay/rust-toolchain@master` pin to `1.99.1` and the cache action.
- **Rust is now required to run `npm test`** locally and in any fresh clone.
- **The equivalence proof is empirical, not formal.** It rests on random and real-data differential tests plus mutation checks. The argument for why it can't diverge: both versions compute the same function of UTF-16 lengths, now passed exactly, using the same `f64` comparisons, through a walk with identical control flow.
- **The remaining TypeScript share.** `messageTextLength` still calls `JSON.stringify` for tool-call and tool-result parts, as before. Equivalence there is by construction (the same helper code) and tested.
- **The repo is under `~/Documents`, which iCloud Drive syncs.** Earlier in this session iCloud had evicted files in `node_modules` ("dataless" placeholders). Reads timed out, the build failed, and a matplotlib run took 17 minutes. `npm ci` fixed it. The Rust `target/` folder can be evicted the same way. Moving the repo out of iCloud, or renaming the folder to end in `.nosync`, would prevent it.
- **`fitToBudget` now measures every message's length,** not just the newest ~50. That's O(n) in history length instead of O(kept), about 2 µs at 292 messages (Section 6).
- **Call counter.** The engine counts its calls so the integration test can prove the Worker uses it. It's one integer increment per call.

## 9. State of the repository (nothing committed)

- **Already staged from last session:** the README rewrite and PROMPTS.md.
- **Unstaged from last session:**
  - SPEC.md, `analysis/report.md` and `analysis/run_analysis.py` (the readability rewrite);
  - `index.html` and `public/` (the LinkedIn link-preview fix, deployed on 2026-10-20).
- **From this session:** everything in Section 2, plus `results/experiments/rust-check-1.json` and the cost-log line for the live check.
- **PROMPTS.md:** the LinkedIn fix and this task are logged as entries 35 and 36, in the working tree. The readability rewrite isn't logged, because you said it wasn't needed there.
