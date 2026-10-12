import type { Session } from "@cloudflare/think";
import type { ContextConfig } from "agents/context";
import type { ModelMessage } from "ai";

// The one interface all three memory designs implement, so the agent, the
// tests and the experiment runner can swap designs without knowing which one
// they hold. Designs are stateless: everything they remember lives in the
// agent's session (messages, compactions, context blocks).

export type DesignName = "cutoff" | "builtin" | "search";

/** Services the agent gives a design. */
export interface DesignHooks {
  /** Calls the shared model to summarize, recording its token usage. */
  summarize(prompt: string): Promise<string>;
  /** Records a compaction failure that Sessions would otherwise swallow. */
  onCompactionError(error: unknown): void;
}

export interface TurnInput {
  /** The shared system prompt, refreshed so memory writes are current. */
  system: string;
  /** Full history as Think assembled it, newest last. */
  messages: ModelMessage[];
  session: Session;
}

export interface PreparedTurn {
  system: string;
  messages: ModelMessage[];
  /** Design-specific details shown by /inspect (e.g. retrieved snippets). */
  notes?: Record<string, unknown>;
}

export interface MemoryDesign {
  readonly name: DesignName;
  /** A wording or setting variant within a design ("main" unless noted). */
  readonly variant?: string;
  /** Tools the model may call. Workspace tools are never included. */
  readonly activeTools: string[];
  /** Extra prompt blocks, added after the shared system prompt block. */
  contextBlocks(): ContextConfig[];
  configureSession(session: Session, hooks: DesignHooks): Session;
  /** Decides what reaches the model. The agent then enforces the budget. */
  prepareTurn(input: TurnInput): Promise<PreparedTurn>;
  /** What this design currently remembers, for the memory panel. */
  inspect(session: Session): Promise<Record<string, unknown>>;
  /** The writable memory block's text, if the design has one. */
  memoryBlock?(session: Session): string;
}
