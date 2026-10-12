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
import { generateText, type PrepareStepResult, type ToolSet } from "ai";
import { createChatModel, withoutReasoning } from "../ai/model";
import { BUILTIN, CONTEXT_BUDGET_TOKENS, SYSTEM_PROMPT } from "../config";
import type { MemoryDesign } from "./design";
import { estimateToolTokens, fitToBudget } from "./tokens";

export type MetricKind = "step" | "turn" | "compaction" | "compaction_error";

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

  getModel(): ThinkModel {
    if (this.modelOverride) return this.modelOverride;
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
      onCompactionError: (error) =>
        this.recordMetric({
          kind: "compaction_error",
          detail: error instanceof Error ? error.message : String(error)
        })
    });
  }

  async beforeTurn(ctx: TurnContext): Promise<TurnConfig> {
    // set_context writes do not reach the frozen prompt on their own.
    const system = await this.session.refreshSystemPrompt();
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

  /** Compaction's model call. Runs outside a turn, so usage is logged here. */
  async summarize(prompt: string): Promise<string> {
    const result = await generateText({
      model: this.resolveModel(),
      prompt,
      maxOutputTokens: BUILTIN.summaryMaxTokens
    });
    this.recordMetric({
      kind: "compaction",
      input_tokens: result.usage.inputTokens ?? null,
      output_tokens: result.usage.outputTokens ?? null
    });
    return result.text;
  }

  #ensureTables() {
    this.sql`CREATE TABLE IF NOT EXISTS memory_metrics (
      kind TEXT NOT NULL, request_id TEXT, step INTEGER,
      input_tokens INTEGER, output_tokens INTEGER, estimated_tokens INTEGER,
      latency_ms INTEGER, detail TEXT, created_at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS memory_last_turn (
      id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`;
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
    return {
      design: this.design.name,
      budgetTokens: CONTEXT_BUDGET_TOKENS,
      memory: await this.design.inspect(this.session),
      lastTurn: row ? JSON.parse(row.json) : null,
      usage: totals
    };
  }

  async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/inspect")) {
      return Response.json(await this.inspect());
    }
    return super.onRequest(request);
  }
}
