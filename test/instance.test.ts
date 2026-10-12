import { describe, expect, it } from "vitest";
import { INSTANCE_KEY, getInstanceId } from "../src/client/instance";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data
  };
}

const throwing = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  }
};

describe("getInstanceId", () => {
  it("creates and saves a new id on first visit", () => {
    const storage = memoryStorage();
    expect(getInstanceId(storage, () => "new-id")).toBe("new-id");
    expect(storage.data.get(INSTANCE_KEY)).toBe("new-id");
  });

  it("reuses the saved id on later visits", () => {
    const storage = memoryStorage({ [INSTANCE_KEY]: "saved-id" });
    expect(getInstanceId(storage, () => "other")).toBe("saved-id");
  });

  it("gives different visitors different ids", () => {
    expect(getInstanceId(memoryStorage())).not.toBe(
      getInstanceId(memoryStorage())
    );
  });

  it("still returns an id when storage is blocked or missing", () => {
    expect(getInstanceId(throwing, () => "fallback")).toBe("fallback");
    expect(getInstanceId(undefined, () => "fallback")).toBe("fallback");
  });
});
