// Gives each visitor their own agent instance, so nobody sees anyone else's
// chat. The id is kept in localStorage so a page refresh returns to the same
// conversation. If storage is unavailable (private mode, blocked site data),
// the visitor still gets a fresh id; it just won't survive a refresh.

export const INSTANCE_KEY = "cf_ai_memory_test:instance";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function getInstanceId(
  storage: StorageLike | undefined,
  newId: () => string = () => crypto.randomUUID()
): string {
  try {
    const existing = storage?.getItem(INSTANCE_KEY);
    if (existing) return existing;
  } catch {
    // Storage blocked: fall through to a fresh id.
  }
  const id = newId();
  try {
    storage?.setItem(INSTANCE_KEY, id);
  } catch {
    // Storage blocked: the id lasts for this page load only.
  }
  return id;
}
