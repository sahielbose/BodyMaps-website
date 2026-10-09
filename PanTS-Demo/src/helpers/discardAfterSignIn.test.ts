import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetQueuedDiscard, queuedDiscards, queueDiscardAfterSignIn } from "./discardAfterSignIn";

describe("discardAfterSignIn", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("lists what was queued, without repeats, until each is forgotten", () => {
    queueDiscardAfterSignIn("a");
    queueDiscardAfterSignIn("b");
    queueDiscardAfterSignIn("a");

    expect(queuedDiscards()).toEqual(["a", "b"]);
    expect(queuedDiscards()).toEqual(["a", "b"]);
    forgetQueuedDiscard("a");
    expect(queuedDiscards()).toEqual(["b"]);
    forgetQueuedDiscard("a");
    forgetQueuedDiscard("b");
    expect(queuedDiscards()).toEqual([]);
    expect(localStorage.getItem("bodymaps-discard-after-sign-in")).toBeNull();
  });

  it("keeps the newest fifty", () => {
    for (let i = 0; i < 60; i++) queueDiscardAfterSignIn(`s${i}`);

    const taken = queuedDiscards();

    expect(taken).toHaveLength(50);
    expect(taken[0]).toBe("s10");
    expect(taken[49]).toBe("s59");
  });

  it("ignores what storage holds that is not a list of ids", () => {
    localStorage.setItem("bodymaps-discard-after-sign-in", JSON.stringify({ a: 1 }));
    expect(queuedDiscards()).toEqual([]);
    localStorage.setItem("bodymaps-discard-after-sign-in", "not json");
    expect(queuedDiscards()).toEqual([]);
    localStorage.setItem("bodymaps-discard-after-sign-in", JSON.stringify(["a", 3, null, "b"]));
    expect(queuedDiscards()).toEqual(["a", "b"]);
  });

  it("does nothing, and does not throw, when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => queueDiscardAfterSignIn("a")).not.toThrow();
    expect(queuedDiscards()).toEqual([]);
  });
});
