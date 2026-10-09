/**
 * Pins an upstream Cornerstone behaviour (@cornerstonejs/tools 4.22.13) that both viewers work
 * around. Segmentation renders requested while a frame is pending wait in one shared queue, one
 * batch per frame, and the next frame is only scheduled when the batch just taken has viewports
 * in it. So an empty batch (a render for a segmentation no pane holds yet) strands everything
 * queued behind it until some later request arrives while the queue is idle. The compare viewer
 * lost case B's organ colours to this on a reopen, which is why addSegmentations is called with
 * suppressEvents and visibility changes skip panes without the mask.
 *
 * If a Cornerstone upgrade fixes the queue, the first test fails: update it on purpose then.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	segmentationRenderingEngine,
	triggerSegmentationRender,
	triggerSegmentationRenderBySegmentationId,
} from "@cornerstonejs/tools/segmentation/SegmentationRenderingEngine";

type Internals = {
	_needsRender: Set<string>;
	_pendingRenderQueue: string[][];
	_animationFrameSet: boolean;
	_animationFrameHandle: number | null;
	_triggerRender: (viewportId: string) => void;
};
const engine = segmentationRenderingEngine as unknown as Internals;

let frames: FrameRequestCallback[];
let rendered: string[];
const runFrames = (n: number) => {
	for (let i = 0; i < n; i++) frames.splice(0).forEach((cb) => cb(0));
};
// With no rendering engine registered, a render for a segmentation names no viewports.
const requestEmpty = () => triggerSegmentationRenderBySegmentationId("no_pane_holds_this");

beforeEach(() => {
	frames = [];
	rendered = [];
	engine._needsRender.clear();
	engine._pendingRenderQueue = [];
	engine._animationFrameSet = false;
	engine._animationFrameHandle = null;
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
	vi.spyOn(engine, "_triggerRender").mockImplementation((viewportId: string) => {
		rendered.push(viewportId);
	});
});
afterEach(() => {
	engine._pendingRenderQueue = [];
	engine._animationFrameSet = false;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Cornerstone segmentation render queue (upstream bug, documented)", () => {
	it("strands the renders queued behind an empty batch while a frame is pending", () => {
		triggerSegmentationRender("cmp_a_ax"); // starts a frame
		requestEmpty(); // queued while that frame is pending
		triggerSegmentationRender("cmp_b_ax");
		triggerSegmentationRender("cmp_b_sag");
		runFrames(20);

		expect(rendered).toEqual(["cmp_a_ax"]);
		expect(engine._pendingRenderQueue).toEqual([["cmp_b_ax"], ["cmp_b_sag"]]);
		expect(engine._animationFrameSet).toBe(false);
	});

	it("drains every queued render when no empty batch is among them", () => {
		triggerSegmentationRender("cmp_a_ax");
		triggerSegmentationRender("cmp_b_ax");
		triggerSegmentationRender("cmp_b_sag");
		runFrames(20);

		expect(rendered).toEqual(["cmp_a_ax", "cmp_b_ax", "cmp_b_sag"]);
		expect(engine._pendingRenderQueue).toEqual([]);
	});

	it("an empty request while the queue is idle schedules nothing and strands nothing", () => {
		requestEmpty();
		expect(frames).toHaveLength(0);
		triggerSegmentationRender("cmp_b_ax");
		runFrames(5);
		expect(rendered).toEqual(["cmp_b_ax"]);
	});

	it("a later request made while idle restarts the drain, so stranded renders run then", () => {
		triggerSegmentationRender("cmp_a_ax");
		requestEmpty();
		triggerSegmentationRender("cmp_b_ax");
		runFrames(20);
		expect(rendered).toEqual(["cmp_a_ax"]);

		// For example an organ toggle: it renders first, then the stranded batch follows.
		triggerSegmentationRender("cmp_b_sag");
		runFrames(20);
		expect(rendered).toEqual(["cmp_a_ax", "cmp_b_sag", "cmp_b_ax"]);
		expect(engine._pendingRenderQueue).toEqual([]);
	});
});
