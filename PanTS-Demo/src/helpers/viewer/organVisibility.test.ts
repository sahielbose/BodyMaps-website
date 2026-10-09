import { describe, expect, it, vi } from "vitest";
import { applyOrganVisibility, type OrganRepresentation } from "./organVisibility";

// A fake of Cornerstone's per-pane representation state that mirrors what the real calls do.
function fakeApi(panes: string[], organs: number) {
  const reps = new Map<string, OrganRepresentation>(
    panes.map((vp) => [vp, {
      visible: true,
      segments: Object.fromEntries(Array.from({ length: organs }, (_, k) => [k + 1, { visible: true }])),
    }]),
  );
  const api = {
    representation: vi.fn((vp: string) => reps.get(vp)),
    setActiveSegmentIndex: vi.fn((i: number) => {
      for (const rep of reps.values()) {
        rep.segments ??= {};
        rep.segments[i] ??= { visible: true };
      }
    }),
    setSegmentIndexVisibility: vi.fn((vp: string, i: number, visible: boolean) => {
      const rep = reps.get(vp);
      if (!rep?.segments?.[i]) return;
      rep.visible ||= visible;
      rep.segments[i]!.visible = visible;
    }),
    requestRender: vi.fn(),
  };
  return { api, reps };
}

const PANES = ["ax", "sag", "cor"];

describe("applyOrganVisibility", () => {
  it("sets only the organs that change, on every pane that holds the mask", () => {
    const { api, reps } = fakeApi(PANES, 35);
    const state = [true, ...Array.from({ length: 35 }, () => true)];

    applyOrganVisibility(api, PANES, state);
    expect(api.setSegmentIndexVisibility).not.toHaveBeenCalled();
    expect(api.setActiveSegmentIndex).not.toHaveBeenCalled();
    // Nothing changed, but one render still repaints the panes.
    expect(api.requestRender).toHaveBeenCalledTimes(1);

    state[4] = false;
    state[12] = false;
    applyOrganVisibility(api, PANES, state);
    expect(api.setSegmentIndexVisibility.mock.calls).toEqual([
      ["ax", 4, false], ["sag", 4, false], ["cor", 4, false],
      ["ax", 12, false], ["sag", 12, false], ["cor", 12, false],
    ]);
    expect(api.setActiveSegmentIndex.mock.calls).toEqual([[4], [12]]);
    expect(api.requestRender).toHaveBeenCalledTimes(1);
    expect(reps.get("cor")?.segments?.[12]?.visible).toBe(false);

    api.setSegmentIndexVisibility.mockClear();
    state[4] = true;
    applyOrganVisibility(api, PANES, state);
    expect(api.setSegmentIndexVisibility.mock.calls).toEqual([["ax", 4, true], ["sag", 4, true], ["cor", 4, true]]);
  });

  it("touches only the panes it is given", () => {
    const { api } = fakeApi(PANES, 3);
    applyOrganVisibility(api, ["ax"], [true, true, false, true]);
    expect(api.setSegmentIndexVisibility.mock.calls).toEqual([["ax", 2, false]]);
  });

  it("adds a segment the panes do not know yet before setting it, as the old walk did", () => {
    const { api, reps } = fakeApi(PANES, 2);
    applyOrganVisibility(api, PANES, [true, true, true, false]);
    expect(api.setActiveSegmentIndex.mock.calls).toEqual([[3]]);
    expect(api.setSegmentIndexVisibility.mock.calls.map(([vp, i]) => [vp, i])).toEqual([["ax", 3], ["sag", 3], ["cor", 3]]);
    expect(reps.get("ax")?.segments?.[3]?.visible).toBe(false);
  });

  it("shows a pane's hidden labelmap again when one of its organs is turned on", () => {
    const { api, reps } = fakeApi(PANES, 2);
    reps.get("sag")!.visible = false;
    applyOrganVisibility(api, PANES, [true, true, true]);
    expect(api.setSegmentIndexVisibility.mock.calls).toEqual([["sag", 1, true]]);
    expect(reps.get("sag")?.visible).toBe(true);
  });
});
