/**
 * Escape in the viewer disarms the armed measure or prompt tool, but only
 * when nothing closer to the focus used it: a text field, a dialog, an open
 * toolbar flyout, a half-drawn measurement (cancelled first), or a listener
 * that marked it used (a half-drawn lasso clearing its points, a popover
 * closing). Cornerstone's preventDefault on a focused pane doesn't count.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "../helpers/viewer/useKeyboardShortcuts";
import { markEscapeUsed } from "../helpers/viewer/escapeUsed";

function setup(onEscape: () => boolean, disabled = false, cancelDrawing?: () => boolean) {
	return renderHook(() =>
		useKeyboardShortcuts({
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
			sliceInfoRef: { current: { axial: null, sagittal: null, coronal: null } },
			editMode: null,
			setZoomLevel: vi.fn(),
			diameterMm: 10,
			onDiameterChange: vi.fn(),
			onUndo: vi.fn(),
			disabled,
			onEscape,
			cancelDrawing,
		}),
	);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function pressEscape(target: EventTarget = document.body) {
	const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	target.dispatchEvent(e);
	return e;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("Escape disarms the armed tool", () => {
	it("calls onEscape for a bare Escape over the viewer", async () => {
		const onEscape = vi.fn(() => true);
		setup(onEscape);
		pressEscape();
		await settle();
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("leaves it alone when a later listener used the Escape", async () => {
		const onEscape = vi.fn(() => true);
		setup(onEscape);
		// Registered after the shortcuts hook, like the lasso's own
		// "clear the half-drawn points" handler.
		const clearPoints = (e: KeyboardEvent) => markEscapeUsed(e);
		window.addEventListener("keydown", clearPoints);
		pressEscape();
		await settle();
		window.removeEventListener("keydown", clearPoints);
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("still disarms on a focused pane, where Cornerstone prevents every key", async () => {
		const onEscape = vi.fn(() => true);
		setup(onEscape);
		const pane = document.createElement("div");
		pane.tabIndex = 0;
		pane.addEventListener("keydown", (e) => e.preventDefault());
		document.body.appendChild(pane);
		pressEscape(pane);
		await settle();
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("cancels a half-drawn measurement first and keeps the tool", async () => {
		const onEscape = vi.fn(() => true);
		let drawing = true;
		const cancelDrawing = vi.fn(() => {
			const was = drawing;
			drawing = false;
			return was;
		});
		setup(onEscape, false, cancelDrawing);
		// Cornerstone's own Freehand binding on the pane would cancel the
		// outline too; the hook has to see it half drawn before that runs.
		const pane = document.createElement("div");
		pane.addEventListener("keydown", () => { drawing = false; });
		document.body.appendChild(pane);

		pressEscape(pane);
		await settle();
		expect(onEscape).not.toHaveBeenCalled();

		pressEscape(pane);
		await settle();
		expect(onEscape).toHaveBeenCalledTimes(1);
	});

	it("leaves it alone inside a dialog or a toolbar flyout", async () => {
		const onEscape = vi.fn(() => true);
		setup(onEscape);
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		const btn = document.createElement("button");
		dialog.appendChild(btn);
		document.body.appendChild(dialog);
		pressEscape(btn);

		const flyout = document.createElement("div");
		flyout.className = "vp-flyout";
		const item = document.createElement("button");
		flyout.appendChild(item);
		document.body.appendChild(flyout);
		pressEscape(item);

		await settle();
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("leaves it alone while typing in a field", async () => {
		const onEscape = vi.fn(() => true);
		setup(onEscape);
		const input = document.createElement("input");
		document.body.appendChild(input);
		pressEscape(input);
		await settle();
		expect(onEscape).not.toHaveBeenCalled();
	});

	it("does nothing while the shortcuts are suspended", async () => {
		const onEscape = vi.fn(() => true);
		setup(onEscape, true);
		pressEscape();
		await settle();
		expect(onEscape).not.toHaveBeenCalled();
	});
});
