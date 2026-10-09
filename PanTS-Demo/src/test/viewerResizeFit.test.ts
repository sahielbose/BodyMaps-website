/**
 * Opening a dock (Organs, Organ stats, the segments panel) narrows the stage.
 * A plain resize(true, true) kept each pane's camera scale, which is tied to
 * the pane's height, so a narrower pane cropped the anatomy at the sides
 * while the zoom readout still said 1.0x. resizeKeepingFit keeps every
 * pane's zoom relative to its (new) fit instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refitPanesUntilSettled, resizeKeepingFit } from "../helpers/CornerstoneNifti2";

// A pane whose fit changes on resize: Cornerstone re-derives the fit camera
// for the new size, so the same camera reads as a different zoom afterwards.
function pane(id: string, zoom: number, zoomAfterResize: number, size = { w: 400, h: 300 }) {
	let current = zoom;
	return {
		id,
		element: { clientWidth: size.w, clientHeight: size.h } as HTMLElement,
		getZoom: vi.fn(() => current),
		setZoom: vi.fn((z: number) => { current = z; }),
		afterResize() { current = zoomAfterResize; },
	};
}

function engineWith(panes: ReturnType<typeof pane>[]) {
	return {
		resize: vi.fn(() => panes.forEach((p) => p.afterResize())),
		render: vi.fn(),
		getViewports: () => panes,
	};
}

describe("resizeKeepingFit", () => {
	it("puts each pane back at the zoom it had relative to fit", () => {
		const axial = pane("axial", 1, 0.74); // narrower: the old camera now overflows
		const sagittal = pane("sagittal", 2, 1.48); // zoomed in 2x: stays 2x of the new fit
		const engine = engineWith([axial, sagittal]);

		resizeKeepingFit(engine);

		expect(engine.resize).toHaveBeenCalledWith(true, true);
		expect(axial.setZoom).toHaveBeenCalledWith(1);
		expect(sagittal.setZoom).toHaveBeenCalledWith(2);
		expect(engine.render).toHaveBeenCalledTimes(1);
	});

	it("leaves panes alone when the resize didn't change their fit", () => {
		const axial = pane("axial", 1.5, 1.5);
		const engine = engineWith([axial]);

		resizeKeepingFit(engine);

		expect(axial.setZoom).not.toHaveBeenCalled();
		expect(engine.render).not.toHaveBeenCalled();
	});

	it("skips panes with no size (hidden by a single-view layout)", () => {
		const hidden = pane("coronal", 1, 0.5, { w: 0, h: 0 });
		const engine = engineWith([hidden]);

		resizeKeepingFit(engine);

		expect(hidden.setZoom).not.toHaveBeenCalled();
	});
});

describe("resizeKeepingFit result", () => {
	it("reports whether a pane had to be put back", () => {
		expect(resizeKeepingFit(engineWith([pane("axial", 1, 0.74)]))).toBe(true);
		expect(resizeKeepingFit(engineWith([pane("axial", 1.5, 1.5)]))).toBe(false);
	});

	it("compares the fit scale, so a small change in fit still puts the zoom back", () => {
		// A 0.05 percent change in the fit is under the old 0.1 percent zoom threshold.
		let zoom = 1;
		let fit = 100;
		const axial = {
			id: "axial",
			element: { clientWidth: 400, clientHeight: 300 } as HTMLElement,
			getZoom: vi.fn(() => zoom),
			setZoom: vi.fn((z: number) => { zoom = z; }),
			getCamera: () => ({ parallelScale: fit / zoom }),
		};
		const engine = {
			resize: vi.fn(() => { fit = 100.05; }),
			render: vi.fn(),
			getViewports: () => [axial],
		};

		expect(resizeKeepingFit(engine)).toBe(true);
		expect(axial.setZoom).toHaveBeenCalledWith(1);
	});
});

describe("refitPanesUntilSettled", () => {
	let frames: FrameRequestCallback[] = [];
	const runFrame = () => {
		const queued = frames;
		frames = [];
		queued.forEach((cb) => cb(0));
	};
	beforeEach(() => {
		frames = [];
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
		vi.stubGlobal("cancelAnimationFrame", () => { frames = []; });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("refits a pane whose first resize was dropped while a render was queued", () => {
		// Cornerstone returns from resize without touching the cameras while a render
		// frame is pending; the coronal pane then kept its old, height-limited scale.
		const coronal = pane("coronal", 1, 0.74);
		let dropped = true;
		const engine = {
			resize: vi.fn(() => {
				if (dropped) { dropped = false; return; }
				coronal.afterResize();
			}),
			render: vi.fn(),
			getViewports: () => [coronal],
		};

		refitPanesUntilSettled(engine);
		expect(coronal.setZoom).not.toHaveBeenCalled();
		runFrame();

		expect(coronal.setZoom).toHaveBeenCalledWith(1);
	});

	it("stops once the panes stop changing, and leaves a pane that already fits alone", () => {
		const axial = pane("axial", 1.5, 1.5);
		const engine = engineWith([axial]);

		refitPanesUntilSettled(engine);
		for (let i = 0; i < 10; i++) runFrame();

		expect(axial.setZoom).not.toHaveBeenCalled();
		expect(engine.render).not.toHaveBeenCalled();
		// The first pass plus two quiet frames, then no more.
		expect(engine.resize).toHaveBeenCalledTimes(3);
		expect(frames).toHaveLength(0);
	});

	it("does not take a resize dropped for a queued frame as the panes having settled", () => {
		// Cornerstone flags a queued render frame and drops any resize meanwhile: the
		// panes then look unchanged, but only because nothing was done to them.
		const axial = pane("axial", 1.5, 1.5);
		let queued = true;
		const engine = {
			...engineWith([axial]),
			get _animationFrameSet() {
				return queued;
			},
		};

		refitPanesUntilSettled(engine);
		for (let i = 0; i < 5; i++) runFrame();
		expect(engine.resize).toHaveBeenCalledTimes(6);

		queued = false;
		for (let i = 0; i < 5; i++) runFrame();
		// Two quiet frames after the last dropped pass, then it stops.
		expect(engine.resize).toHaveBeenCalledTimes(8);
		expect(frames).toHaveLength(0);
	});

	it("waits while a layout refit owns the panes, then refits once it is done", () => {
		const coronal = pane("coronal", 1, 0.74);
		const engine = engineWith([coronal]);
		let blocked = true;

		refitPanesUntilSettled(engine, { isBlocked: () => blocked });
		runFrame();
		expect(engine.resize).not.toHaveBeenCalled();

		blocked = false;
		runFrame();
		expect(coronal.setZoom).toHaveBeenCalledWith(1);
	});

	it("can be cancelled", () => {
		const engine = engineWith([pane("axial", 1, 0.74)]);
		const cancel = refitPanesUntilSettled(engine);
		cancel();
		runFrame();
		expect(engine.resize).toHaveBeenCalledTimes(1);
	});
});
