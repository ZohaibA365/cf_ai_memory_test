import {
  Think,
  type ChatResponseResult,
  type PrepareStepContext,
  type Session,
  type StepContext,
  type ThinkModel,
  type TurnConfig,
  type TurnContext
} from "@cloudflare/think";
import type { ContextConfig } from "agents/context";
import { generateText, type PrepareStepResult, type ToolSet, type UIMessage } from "ai";
import { createMockModel } from "../ai/mock-model";
import { createChatModel, withoutReasoning } from "../ai/model";
import { BUILTIN, CONTEXT_BUDGET_TOKENS, FAST_FORWARD, SYSTEM_PROMPT } from "../config";
import { offsetFor } from "../experiment/conversation";
import { loadFillerPool } from "../experiment/data";
import type { MemoryDesign } from "./design";
import { estimateToolTokens, fitToBudget } from "./tokens";

export type MetricKind = "step" | "turn" | "compaction" | "compaction_error" | "compaction_skipped";

/** Thrown when the retry guard skips a summary; recorded, never billed. */
const SKIPPED_PREFIX = "compaction skipped:";

export interface Metric {
  kind: MetricKind;
  request_id: string | null;
  step: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_tokens: number | null;
  latency_ms: number | null;
  detail: string | null;
  created_at: number;
}

export interface ScoredTurn {
  answer: string;
  /** Memory block after the turn (designs that have one), to track fact loss. */
  memoryBlock: string | null;
  status: string;
  historyMessages: number;
  latencyMs: number;
  modelLatencyMs: number | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedTokens: number | null;
  startedAt: number;
}

interface TurnState {
  system: string;
  toolTokens: number;
  estimatedTokens: number;
  startedAt: number;
}

/**
 * The one assistant. Each subclass plugs in a memory design; everything else
 * (model, prompt, tools, the equal context budget, metrics) is shared here so
 * the designs differ only in memory.
 */
export abstract class MemoryAgent extends Think<Env> {
  /** A getter, not a field, so it works while Think's constructor runs. */
  abstract get design(): MemoryDesign;

  /** Tests swap in a mock model before the first turn. */
  modelOverride: ThinkModel | undefined;

  // Older messages are never cut at read time; the shared budget decides.
  truncationStep = Infinity;

  #turns = new Map<string, TurnState>();

  /** History length at the last failed summary (in memory; see summarize). */
  #failedSummaryAt: number | undefined;

  getModel(): ThinkModel {
    if (this.modelOverride) return this.modelOverride;
    // Typed as the deployed value ("live"); tests override it to "mock".
    if ((this.env.MODEL_MODE as string) === "mock") return createMockModel();
    // Not the plain MODEL_ID string: that path uses the unwrapped binding,
    // which doubles streamed text (see src/ai/model.ts).
    return createChatModel(this.env.AI);
  }

  configureContext(): ContextConfig[] {
    return [
      { label: "instructions", provider: { get: async () => SYSTEM_PROMPT } },
      ...this.design.contextBlocks()
    ];
  }

  configureSession(session: Session): Session {
    return this.design.configureSession(session, {
      summarize: (prompt) => this.summarize(prompt),
      onCompactionError: (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.recordMetric({
          kind: detail.startsWith(SKIPPED_PREFIX) ? "compaction_skipped" : "compaction_error",
          detail
        });
      }
    });
  }

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    // set_context writes do not reach the frozen prompt on their own.
    let system = await this.session.refreshSystemPrompt();
    // Per-run reply setting (stage 4 pilot). Added before the budget step,
    // so it counts against the budget like everything else.
    if (this.thinking() === "off") system = `${system}\n\n/no_think`;
    const prepared = await this.design.prepareTurn({
      system,
      messages: withoutReasoning(ctx.messages),
      session: this.session
    });
    const activeTools = this.design.activeTools;
    const toolTokens = await estimateToolTokens(ctx.tools, activeTools);
    const fit = fitToBudget(
      { system: prepared.system, messages: prepared.messages, toolTokens },
      CONTEXT_BUDGET_TOKENS
    );

    const requestId = ctx.requestId ?? "unknown";
    this.#turns.set(requestId, {
      system: fit.system,
      toolTokens,
      estimatedTokens: fit.estimatedTokens,
      startedAt: Date.now()
    });
    this.saveLastTurn({
      requestId,
      estimatedTokens: fit.estimatedTokens,
      budget: CONTEXT_BUDGET_TOKENS,
      messagesSent: fit.messages.length,
      messagesDropped: fit.droppedMessages,
      system: fit.system,
      notes: prepared.notes ?? {}
    });

    return { system: fit.system, messages: fit.messages, activeTools };
  }

  // Later steps of a turn (after a tool call) carry the tool call and result
  // too, so the budget is enforced again on every model call. Typed with the
  // AI SDK's PrepareStepResult: Think's StepConfig type omits `messages` by
  // mistake (Omit over a union with undefined), though the runtime passes it.
  beforeStep(ctx: PrepareStepContext): PrepareStepResult<ToolSet> {
    if (ctx.stepNumber === 0) return;
    const turn = this.#turns.get(this.activeTurn?.requestId ?? "");
    if (!turn) return;
    const fit = fitToBudget(
      {
        system: turn.system,
        messages: withoutReasoning(ctx.messages),
        toolTokens: turn.toolTokens
      },
      CONTEXT_BUDGET_TOKENS
    );
    turn.estimatedTokens = Math.max(turn.estimatedTokens, fit.estimatedTokens);
    return { messages: fit.messages };
  }

  onStepFinish(ctx: StepContext) {
    const requestId = this.activeTurn?.requestId ?? null;
    this.recordMetric({
      kind: "step",
      request_id: requestId,
      step: ctx.stepNumber,
      input_tokens: ctx.usage.inputTokens ?? null,
      output_tokens: ctx.usage.outputTokens ?? null,
      estimated_tokens: this.#turns.get(requestId ?? "")?.estimatedTokens ?? null
    });
  }

  onChatResponse(result: ChatResponseResult) {
    const turn = this.#turns.get(result.requestId);
    this.#turns.delete(result.requestId);
    this.recordMetric({
      kind: "turn",
      request_id: result.requestId,
      latency_ms: turn ? Date.now() - turn.startedAt : null,
      estimated_tokens: turn?.estimatedTokens ?? null,
      detail: result.status
    });
  }

  /**
   * Compaction's model call. Runs outside a turn, so usage is logged here.
   *
   * The request asks for about 200 words so the summary fits under the
   * 400-token cap (without that, most summaries ran past it).
   *
   * Thinking is off for summaries (Qwen3's /no_think switch): with it on,
   * thinking used up the output cap, summaries came back cut off or empty,
   * and Sessions retried on nearly every appended message (186 paid calls in
   * one run). A cut-off or empty summary is treated as a failure and never
   * stored, and after a failure the next attempts are skipped, without a
   * model call, until enough new messages have arrived.
   */
  async summarize(prompt: string): Promise<string> {
    const length = this.messages.length;
    const failedAt = this.#failedSummaryAt;
    if (failedAt !== undefined && length - failedAt < BUILTIN.summaryRetryAfterMessages) {
      throw new Error(
        `${SKIPPED_PREFIX} ${length - failedAt} new messages since the last failed summary`
      );
    }
    let result;
    try {
      result = await generateText({
        model: this.resolveModel(),
        prompt: `${prompt}\n\nKeep the whole summary under about ${BUILTIN.summaryTargetWords} words.\n\n/no_think`,
        maxOutputTokens: BUILTIN.summaryMaxTokens
      });
    } catch (error) {
      this.#failedSummaryAt = length;
      throw error;
    }
    this.recordMetric({
      kind: "compaction",
      input_tokens: result.usage.inputTokens ?? null,
      output_tokens: result.usage.outputTokens ?? null
    });
    const text = result.text.trim();
    if (result.finishReason === "length" || text.length < 20) {
      this.#failedSummaryAt = length;
      throw new Error(`summary unusable (finish ${result.finishReason}, ${text.length} chars)`);
    }
    this.#failedSummaryAt = undefined;
    return text;
  }

  #ensureTables() {
    this.sql`CREATE TABLE IF NOT EXISTS memory_metrics (
      kind TEXT NOT NULL, request_id TEXT, step INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, estimated_tokens INTEGER,
      latency_ms INTEGER, detail TEXT, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS memory_last_turn (
      id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS scored_turns (
      key TEXT PRIMARY KEY, json TEXT NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS agent_options (
      key TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  }

  recordMetric(m: Partial<Metric> & { kind: MetricKind }) {
    this.#ensureTables();
    this.sql`INSERT INTO memory_metrics (kind, request_id, step, input_tokens,
      output_tokens, estimated_tokens, latency_ms, detail, created_at)
      VALUES (${m.kind}, ${m.request_id ?? null}, ${m.step ?? null},
      ${m.input_tokens ?? null}, ${m.output_tokens ?? null},
      ${m.estimated_tokens ?? null}, ${m.latency_ms ?? null},
      ${m.detail ?? null}, ${Date.now()})`;
  }

  metrics(): Metric[] {
    this.#ensureTables();
    return this.sql<Metric>`SELECT * FROM memory_metrics ORDER BY created_at`;
  }

  private saveLastTurn(snapshot: Record<string, unknown>) {
    this.#ensureTables();
    const json = JSON.stringify(snapshot);
    this.sql`INSERT INTO memory_last_turn (id, json) VALUES (1, ${json})
      ON CONFLICT (id) DO UPDATE SET json = excluded.json`;
  }

  /** What this assistant currently remembers, for the memory panel. */
  async inspect() {
    this.#ensureTables();
    const [row] = this.sql<{ json: string }>`SELECT json FROM memory_last_turn`;
    const totals = this.sql<{ kind: string; calls: number; input: number; output: number }>`
      SELECT kind, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input,
        COALESCE(SUM(output_tokens), 0) AS output
      FROM memory_metrics GROUP BY kind`;
    // Every paid summary call and every failure, in order (skips are only
    // counted: there can be many and they cost nothing).
    const compactionLog = this.sql<{
      kind: string; input_tokens: number | null; output_tokens: number | null; detail: string | null; created_at: number;
    }>`SELECT kind, input_tokens, output_tokens, detail, created_at FROM memory_metrics
       WHERE kind IN ('compaction', 'compaction_error') ORDER BY created_at, rowid`;
    return {
      design: this.design.name,
      variant: this.design.variant ?? "main",
      thinking: this.thinking(),
      budgetTokens: CONTEXT_BUDGET_TOKENS,
      memory: await this.design.inspect(this.session),
      lastTurn: row ? JSON.parse(row.json) : null,
      usage: totals,
      compactionLog
    };
  }

  // ---- Called by the experiment runner over RPC -------------------------

  /** Reply thinking for this agent ("on" unless a run turns it off). */
  thinking(): "on" | "off" {
    this.#ensureTables();
    const [row] = this.sql<{ value: string }>`SELECT value FROM agent_options WHERE key = 'thinking'`;
    return row?.value === "off" ? "off" : "on";
  }

  setThinking(mode: "on" | "off") {
    this.#ensureTables();
    this.sql`INSERT INTO agent_options (key, value) VALUES ('thinking', ${mode})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    return { thinking: mode };
  }

  /** Adds small talk without calling the model. Idempotent by message id. */
  async insertFiller(key: string, pairs: { user: string; assistant: string }[]) {
    const messages: UIMessage[] = pairs.flatMap((p, i) => [
      { id: `${key}:${i}:u`, role: "user" as const, parts: [{ type: "text" as const, text: p.user }] },
      { id: `${key}:${i}:a`, role: "assistant" as const, parts: [{ type: "text" as const, text: p.assistant }] }
    ]);
    await this.addMessages(messages);
    return { messages: messages.length };
  }

  /**
   * Sends one user message, waits for the reply, and returns the answer with
   * its cost and timing. Safe to call again with the same key (a Workflow
   * step retry): a finished turn returns its saved result, and a failed one
   * is rolled back first so the retry starts clean.
   */
  async scoredTurn(key: string, text: string): Promise<ScoredTurn> {
    this.#ensureTables();
    const [saved] = this.sql<{ json: string }>`SELECT json FROM scored_turns WHERE key = ${key}`;
    if (saved) return JSON.parse(saved.json) as ScoredTurn;

    const userId = `${key}:user`;
    await this.#rollBackFrom(userId);
    const historyMessages = this.messages.length;
    const since = Date.now();
    const started = performance.now();
    const result = await this.saveMessages([
      { id: userId, role: "user", parts: [{ type: "text", text }] }
    ]);
    const latencyMs = Math.round(performance.now() - started);

    if (result.status !== "completed") {
      await this.#rollBackFrom(userId);
      throw new Error(`turn ${key} ended with status ${result.status}: ${result.error ?? "no detail"}`);
    }

    const steps = this.sql<Metric>`SELECT * FROM memory_metrics
      WHERE request_id = ${result.requestId} AND kind = 'step'`;
    const [turn] = this.sql<Metric>`SELECT * FROM memory_metrics
      WHERE request_id = ${result.requestId} AND kind = 'turn'`;
    const scored: ScoredTurn = {
      answer: this.#replyAfter(userId),
      memoryBlock: this.design.memoryBlock?.(this.session) ?? null,
      status: result.status,
      historyMessages,
      latencyMs,
      modelLatencyMs: turn?.latency_ms ?? null,
      modelCalls: steps.length,
      inputTokens: steps.reduce((s, m) => s + (m.input_tokens ?? 0), 0),
      outputTokens: steps.reduce((s, m) => s + (m.output_tokens ?? 0), 0),
      estimatedTokens: turn?.estimated_tokens ?? null,
      startedAt: since
    };
    this.sql`INSERT INTO scored_turns (key, json) VALUES (${key}, ${JSON.stringify(scored)})`;
    return scored;
  }

  /** Compaction usage and errors for the whole run (built-in design). */
  runMetrics() {
    this.#ensureTables();
    const [row] = this.sql<{ calls: number; input: number; output: number; errors: number; skipped: number }>`
      SELECT
        COALESCE(SUM(kind = 'compaction'), 0) AS calls,
        COALESCE(SUM(CASE WHEN kind = 'compaction' THEN input_tokens END), 0) AS input,
        COALESCE(SUM(CASE WHEN kind = 'compaction' THEN output_tokens END), 0) AS output,
        COALESCE(SUM(kind = 'compaction_error'), 0) AS errors,
        COALESCE(SUM(kind = 'compaction_skipped'), 0) AS skipped
      FROM memory_metrics`;
    return {
      compactionCalls: row.calls,
      compactionInputTokens: row.input,
      compactionOutputTokens: row.output,
      compactionErrors: row.errors,
      compactionSkipped: row.skipped
    };
  }

  #replyAfter(userId: string): string {
    const all = this.messages;
    const at = all.findIndex((m) => m.id === userId);
    return all
      .slice(at + 1)
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])))
      .join("\n")
      .trim();
  }

  /** Deletes a user message and everything after it, if present. */
  async #rollBackFrom(userId: string) {
    const all = this.messages;
    const at = all.findIndex((m) => m.id === userId);
    if (at === -1) return;
    await this.session.deleteMessages(all.slice(at).map((m) => m.id));
  }

  /**
   * Demo fast-forward: adds `pairs` exchanges of small talk from the shared
   * filler pool (no model calls), continuing where the last fast-forward
   * stopped. Capped per call and per agent (see FAST_FORWARD).
   */
  async fastForward(pairs: number) {
    this.#ensureTables();
    const [row] = this.sql<{ value: string }>`SELECT value FROM agent_options WHERE key = 'ff_used'`;
    const used = Number(row?.value ?? 0);
    const count = Math.max(0, Math.min(Math.floor(pairs), FAST_FORWARD.maxPairsPerCall, FAST_FORWARD.maxPairsPerAgent - used));
    if (count === 0) return { added: 0, used, limit: FAST_FORWARD.maxPairsPerAgent };
    const pool = loadFillerPool();
    const start = offsetFor(this.name, pool.length) + used;
    const block = Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length]);
    await this.insertFiller(`ff-${used}`, block);
    this.sql`INSERT INTO agent_options (key, value) VALUES ('ff_used', ${String(used + count)})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`;
    return { added: count, used: used + count, limit: FAST_FORWARD.maxPairsPerAgent };
  }

  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/inspect")) {
      return Response.json(await this.inspect());
    }
    if (path.endsWith("/fast-forward")) {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      const body = (await request.json().catch(() => ({}))) as { pairs?: unknown };
      const pairs = Number(body.pairs ?? 12);
      if (!Number.isFinite(pairs) || pairs <= 0) return new Response("pairs must be a positive number", { status: 400 });
      return Response.json(await this.fastForward(pairs));
    }
    return super.onRequest(request);
  }
}
