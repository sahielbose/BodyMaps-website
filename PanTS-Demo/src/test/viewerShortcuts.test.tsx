/**
 * The viewer's keyboard shortcuts leave form controls alone (a focused
 * select keeps its typeahead, Home/End and brackets), Shift+[ / Shift+]
 * resize the brush from the size the ribbon's slider shows, through the
 * slider's own setter, and +/- stop at the same zoom limits as the slider.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// One fake pane, standing in for Cornerstone's rendering engine.
const engine = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@cornerstonejs/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cornerstonejs/core")>()),
	getRenderingEngine: () => engine.current,
}));

import { useKeyboardShortcuts } from "../helpers/viewer/useKeyboardShortcuts";
import { MAX_ZOOM, MIN_ZOOM } from "../helpers/CornerstoneNifti2";

type Args = Parameters<typeof useKeyboardShortcuts>[0];

function setup(overrides: Partial<Args> = {}) {
	const args: Args = {
		takeSnapshot: vi.fn(),
		toggleCine: vi.fn(),
		setEditMode: vi.fn(),
		setActiveMeasureTool: vi.fn(),
		setCrosshairToolActive: vi.fn(),
		setShowStats: vi.fn(),
		setShowMetadata: vi.fn(),
		setShowAnnotationToolbar: vi.fn(),
		setShowMeasurePanel: vi.fn(),
		getFocusedPane: () => "axial",
		sliceInfoRef: { current: { axial: { current: 5, total: 20 }, sagittal: null, coronal: null } },
		editMode: null,
		setZoomLevel: vi.fn(),
		diameterMm: 10,
		onDiameterChange: vi.fn(),
		onUndo: vi.fn(),
		closeAnnotationToolbarIfOpen: vi.fn(),
		...overrides,
	};
	const hook = renderHook((props: Args) => useKeyboardShortcuts(props), { initialProps: args });
	return { ...args, rerender: (next: Partial<Args>) => hook.rerender({ ...args, ...next }) };
}

function press(target: EventTarget, key: string, code: string, init: KeyboardEventInit = {}) {
	const e = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(e);
	return e;
}

afterEach(() => {
	document.body.innerHTML = "";
	engine.current = undefined;
});

describe("shortcuts on a focused select", () => {
	it("leave typeahead, Home/End and the brackets to the select", () => {
		const args = setup();
		const select = document.createElement("select");
		document.body.appendChild(select);

		const letter = press(select, "l", "KeyL");
		const home = press(select, "Home", "Home");
		const bracket = press(select, "]", "BracketRight");
		press(select, "m", "KeyM");

		expect(letter.defaultPrevented).toBe(false);
		expect(home.defaultPrevented).toBe(false);
		expect(bracket.defaultPrevented).toBe(false);
		expect(args.setActiveMeasureTool).not.toHaveBeenCalled();
		expect(args.closeAnnotationToolbarIfOpen).not.toHaveBeenCalled();
		expect(args.setShowAnnotationToolbar).not.toHaveBeenCalled();
	});

	it("still run everywhere else", () => {
		const args = setup();
		const letter = press(document.body, "l", "KeyL");
		expect(letter.defaultPrevented).toBe(true);
		expect(args.closeAnnotationToolbarIfOpen).toHaveBeenCalledTimes(1);
		expect(args.setActiveMeasureTool).toHaveBeenCalledTimes(1);
	});
});

describe("Shift+[ / Shift+] while painting", () => {
	const grow = () => press(document.body, "}", "BracketRight", { shiftKey: true });
	const shrink = () => press(document.body, "{", "BracketLeft", { shiftKey: true });

	it("steps 2mm from the slider's size and sets it through the slider", () => {
		const onDiameterChange = vi.fn();
		const hook = setup({ editMode: "brush", diameterMm: 30, onDiameterChange });

		grow();
		expect(onDiameterChange).toHaveBeenLastCalledWith(32);

		// The slider now reads 32, and a later drag to 12 is where the next
		// step starts from.
		hook.rerender({ diameterMm: 12 });
		shrink();
		expect(onDiameterChange).toHaveBeenLastCalledWith(10);
	});

	it("stops at the slider's range", () => {
		const onDiameterChange = vi.fn();
		const hook = setup({ editMode: "eraser", diameterMm: 39.5, onDiameterChange });
		grow();
		expect(onDiameterChange).toHaveBeenLastCalledWith(40);

		hook.rerender({ diameterMm: 3 });
		shrink();
		expect(onDiameterChange).toHaveBeenLastCalledWith(2);
	});

	it("steps slices instead when no brush is out", () => {
		const onDiameterChange = vi.fn();
		setup({ editMode: null, onDiameterChange });
		grow();
		expect(onDiameterChange).not.toHaveBeenCalled();
	});
});

describe("+ / - at the zoom limits", () => {
	function paneAt(zoom: number) {
		const viewport = {
			zoom,
			getZoom: () => viewport.zoom,
			setZoom: vi.fn((z: number) => { viewport.zoom = z; }),
			canvasToWorld: () => [0, 0, 0],
			getCamera: () => ({ focalPoint: [0, 0, 0], position: [0, 0, 1] }),
			setCamera: vi.fn(),
			render: vi.fn(),
		};
		engine.current = { getViewport: () => viewport };
		// The focused pane the keys fall back to when the cursor isn't over one.
		const pane = document.createElement("div");
		pane.className = "vp-pane";
		pane.dataset.label = "Axial";
		pane.appendChild(document.createElement("canvas"));
		document.body.appendChild(pane);
		return viewport;
	}
	const zoomIn = () => press(document.body, "=", "Equal");
	const zoomOut = () => press(document.body, "-", "Minus");

	it("stop the pane at the top limit, and the readout with it", () => {
		const viewport = paneAt(7.5);
		const setZoomLevel = vi.fn();
		setup({ setZoomLevel });

		zoomIn();
		zoomIn();
		zoomIn();

		expect(viewport.zoom).toBe(MAX_ZOOM);
		expect(viewport.setZoom).toHaveBeenCalledTimes(1);
		expect(setZoomLevel).toHaveBeenLastCalledWith(MAX_ZOOM);
	});

	it("stop the pane at the bottom limit, and the readout with it", () => {
		const viewport = paneAt(0.25);
		const setZoomLevel = vi.fn();
		setup({ setZoomLevel });

		zoomOut();
		zoomOut();

		expect(viewport.zoom).toBe(MIN_ZOOM);
		expect(setZoomLevel).toHaveBeenLastCalledWith(MIN_ZOOM);
	});

	it("report the pane's own zoom between the limits", () => {
		const viewport = paneAt(2);
		const setZoomLevel = vi.fn();
		setup({ setZoomLevel });

		zoomIn();

		expect(viewport.zoom).toBeCloseTo(2.3);
		expect(setZoomLevel).toHaveBeenLastCalledWith(viewport.zoom);
	});
});
