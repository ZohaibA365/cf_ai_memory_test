import {
  conversationSchema,
  fillerPoolSchema,
  type Conversation,
  type FillerPair
} from "./conversation";

// The committed test data, bundled into the Worker at build time and
// validated on load so a malformed file fails loudly instead of skewing a run.

const conversationFiles = import.meta.glob("../../data/conversations/*.json", {
  eager: true,
  import: "default"
});
const fillerFiles = import.meta.glob("../../data/filler.json", {
  eager: true,
  import: "default"
});

export function loadConversations(): Conversation[] {
  return Object.entries(conversationFiles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, raw]) => {
      const parsed = conversationSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      }
      return parsed.data;
    });
}

export function loadFillerPool(): FillerPair[] {
  const raw = Object.values(fillerFiles)[0];
  if (!raw) throw new Error("data/filler.json is missing; run npm run generate:filler");
  return fillerPoolSchema.parse(raw).pairs;
}
