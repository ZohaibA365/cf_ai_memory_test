import type { MemoryDesign } from "./design";

// Cut-off: no memory beyond the recent messages. It passes the full history
// through, and the agent's shared budget step keeps only the newest messages
// that fit. That trimming is the whole design.
export const cutoffDesign: MemoryDesign = {
  name: "cutoff",
  activeTools: [],
  contextBlocks: () => [],
  configureSession: (session) => session,
  prepareTurn: async ({ system, messages }) => ({ system, messages }),
  inspect: async () => ({
    note: "Remembers only the most recent messages that fit the budget."
  })
};
