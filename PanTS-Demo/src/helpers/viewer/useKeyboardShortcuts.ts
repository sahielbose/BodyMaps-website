import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import {
	ANGLE_TOOL,
	ARROW_TOOL,
	BIDIRECTIONAL_TOOL,
	CINE_VIEWPORT_BY_PANE,
	ELLIPSE_TOOL,
	FREEHAND_ROI_TOOL,
	LENGTH_TOOL,
	MAGNIFY_TOOL,
	PROBE_TOOL,
	redoMaskEdit,
	ROI_TOOL,
	setPaneSliceIndex,
	zoomToCursor,
	zoomToFit,
	type CinePane,
	type PrimaryMouseToolName,
	type SliceInfo,
} from "../CornerstoneNifti2";
import type { MaskEditMode } from "../../routes/VisualizationPage";
import { MAX_DIAMETER_MM, MIN_DIAMETER_MM } from "./brushSize";
import { escapeWasUsed, markEscapeUsed, NON_TEXT_INPUT_TYPES } from "./escapeUsed";

const TOOL_BY_KEY: Record<string, PrimaryMouseToolName> = {
	l: LENGTH_TOOL,
	b: BIDIRECTIONAL_TOOL,
	a: ANGLE_TOOL,
	p: PROBE_TOOL,
	r: ROI_TOOL,
	e: ELLIPSE_TOOL,
	f: FREEHAND_ROI_TOOL,
	t: ARROW_TOOL,
	g: MAGNIFY_TOOL,
};

// Edit modes where Shift+[ / Shift+] should resize the brush instead of
// stepping 10 slices — anything that actually paints with a brush radius.
const BRUSH_SIZE_EDIT_MODES = new Set<MaskEditMode>(["brush", "eraser"]);

const BRUSH_STEP_MM = 2;


// What a focused range slider moves itself with.
const RANGE_NATIVE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

const ZOOM_STEP_FACTOR = 1.15; // per keypress, matches a moderate scroll-wheel zoom

interface UseKeyboardShortcutsArgs {
	takeSnapshot: () => void | Promise<void>;
	toggleCine: () => void;
	setEditMode: (mode: MaskEditMode) => void;
	setActiveMeasureTool: Dispatch<SetStateAction<PrimaryMouseToolName | null>>;
	setCrosshairToolActive: (active: boolean) => void;
	setShowStats: (v: boolean) => void;
	setShowMetadata: (v: boolean) => void;
	setShowAnnotationToolbar: (v: boolean) => void; // renamed from setShowEditPanel
	setShowMeasurePanel: Dispatch<SetStateAction<boolean>>;
	getFocusedPane: () => CinePane;
	sliceInfoRef: MutableRefObject<Record<CinePane, SliceInfo | null>>;
	editMode: MaskEditMode;
	setZoomLevel: Dispatch<SetStateAction<number>>;
	/** The brush diameter the ribbon's slider shows, and its setter (which
	 *  also resizes the Cornerstone brush). Shift+[ / Shift+] step from it. */
	diameterMm: number;
	onDiameterChange: (mm: number) => void;
	/** Live Rooms use server-ordered undo and lock edit shortcuts while disconnected. */
	collaborationConnected?: boolean;
	collaborationLocked?: boolean;
	onCollaborationUndo?: () => void;
	/** Called for the plain undo shortcut (⌘Z/Ctrl+Z, no Shift). Owned by
	 *  VisualizationPage so it can peel off a scissors/lasso in-progress
	 *  point before falling through to the global mask-edit undo — see
	 *  handleUndo there for why that ordering matters. Redo has no
	 *  equivalent per-tool concept, so Shift+⌘Z still calls redoMaskEdit()
	 *  directly below. */
	onUndo: () => void;
	/** Suspend every shortcut (e.g. while a full-screen overlay like the report
	 *  walkthrough owns the screen — snapshots, panel toggles, and slice
	 *  stepping must not fire invisibly underneath it). */
	disabled?: boolean;
	/** Retires the annotation ribbon when a shortcut switches to a measure
	 *  tool or crosshair mode, mirroring the main-toolbar buttons' wiring. */
	closeAnnotationToolbarIfOpen?: () => void;
	/** Escape that nothing else used: disarm whatever tool owns the mouse.
	 *  Returns whether there was anything to disarm. */
	onEscape?: () => boolean;
	/** Escape on a half-drawn measurement: cancel the drawing, keep the tool.
	 *  Returns whether there was one to cancel. */
	cancelDrawing?: () => boolean;
}

/**
 * Global keyboard shortcuts (skipped while typing in an input/textarea or
 * operating a select):
 *
 *   L/B/A/P/R/E/T        measurement tools
 *   G                    magnify loupe
 *   C                    crosshair / navigation mode
 *   S                    snapshot
 *   V                    cine play/pause
 *   M                    measurements panel
 *   Cmd/Ctrl+Z           undo (mask edits & measurements)
 *   Shift+Cmd/Ctrl+Z     redo
 *   Cmd/Ctrl+0           reset zoom to fit
 *   Cmd/Ctrl+←/→         jump the focused pane to its first / last slice
 *   +/-                  zoom toward the last-tracked mouse position
 *   [/]                  step the focused pane's slice by 1
 *   Shift+[/Shift+]      step slice by 10 — or, if a brush-based edit tool
 *                        (paint/erase) is active, shrink/grow the brush by 2mm
 *   PageUp/PageDown      step slice by 1 (same as [ / ])
 *   Home/End             jump the focused pane to its first / last slice
 *   Esc                  cancel a half-drawn measurement, else disarm the
 *                        armed measure or prompt tool (see onEscape)
 */
export function useKeyboardShortcuts({
	takeSnapshot,
	toggleCine,
	setEditMode,
	setActiveMeasureTool,
	setCrosshairToolActive,
	setShowStats,
	setShowMetadata,
	setShowAnnotationToolbar,
	setShowMeasurePanel,
	getFocusedPane,
	sliceInfoRef,
	editMode,
	setZoomLevel,
	diameterMm,
	onDiameterChange,
	collaborationConnected,
	collaborationLocked,
	onCollaborationUndo,
	onUndo,
	disabled,
	closeAnnotationToolbarIfOpen,
	onEscape,
	cancelDrawing,
}: UseKeyboardShortcutsArgs) {
	// Last-seen mouse position (viewport-relative clientX/Y), updated on every
	// mousemove so +/- can zoom toward "wherever the cursor last was" even
	// though a keydown event carries no pointer coordinates of its own.
	const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);
	// The slider's brush size, read at keypress time. A ref, so a slider drag
	// doesn't re-register the key listener on every step.
	const brushRef = useRef({ diameterMm, onDiameterChange });
	useEffect(() => {
		brushRef.current = { diameterMm, onDiameterChange };
	});

	useEffect(() => {
		const onMouseMove = (e: globalThis.MouseEvent) => {
			lastMousePosRef.current = { x: e.clientX, y: e.clientY };
		};
		window.addEventListener("mousemove", onMouseMove);
		return () => window.removeEventListener("mousemove", onMouseMove);
	}, []);

	useEffect(() => {
		// Resolves the Cornerstone viewportId + canvas-relative point for whichever
		// pane the cursor is currently over (via elementFromPoint + the pane's
		// data-label), falling back to the focused pane's viewport centered if the
		// cursor isn't over any pane (e.g. it's over the toolbar or a side panel).
		const resolveZoomTarget = (): { viewportId: string; canvasPos: [number, number] } | null => {
			const pos = lastMousePosRef.current;
			if (pos) {
				const el = document.elementFromPoint(pos.x, pos.y);
				const paneEl = el?.closest<HTMLElement>(".vp-pane");
				const label = paneEl?.dataset.label?.toLowerCase();
				if (label === "axial" || label === "sagittal" || label === "coronal") {
					const canvas = paneEl!.querySelector("canvas");
					if (canvas) {
						const rect = canvas.getBoundingClientRect();
						return {
							viewportId: CINE_VIEWPORT_BY_PANE[label as CinePane],
							canvasPos: [pos.x - rect.left, pos.y - rect.top],
						};
					}
				}
			}
			// Fallback: center of the focused pane's own canvas.
			const pane = getFocusedPane();
			const viewportId = CINE_VIEWPORT_BY_PANE[pane];
			const paneEl = document.querySelector<HTMLElement>(
				`.vp-pane[data-label="${pane.charAt(0).toUpperCase()}${pane.slice(1)}"]`
			);
			const canvas = paneEl?.querySelector("canvas");
			if (!canvas) return null;
			const rect = canvas.getBoundingClientRect();
			return { viewportId, canvasPos: [rect.width / 2, rect.height / 2] };
		};

		const stepSlice = (pane: CinePane, delta: number) => {
			const info = sliceInfoRef.current[pane];
			if (!info) return;
			const next = Math.max(0, Math.min(info.total - 1, info.current + delta));
			setPaneSliceIndex(pane, next);
		};

		const jumpSlice = (pane: CinePane, to: "first" | "last") => {
			const info = sliceInfoRef.current[pane];
			if (!info) return;
			setPaneSliceIndex(pane, to === "first" ? 0 : info.total - 1);
		};

		const zoom = (factor: number) => {
			const target = resolveZoomTarget();
			if (!target) return;
			// The readout follows the pane, which stops at the zoom limits.
			const next = zoomToCursor(target.viewportId, target.canvasPos, factor);
			if (next !== undefined) setZoomLevel(next);
		};

		// Through the slider's own setter, so the slider, the brush outline on
		// the panes and the Cornerstone brush all move together.
		const adjustBrush = (deltaMm: number) => {
			const { diameterMm: current, onDiameterChange: setDiameter } = brushRef.current;
			setDiameter(Math.max(MIN_DIAMETER_MM, Math.min(MAX_DIAMETER_MM, current + deltaMm)));
		};

		const onKey = (e: KeyboardEvent) => {
			if (disabled) return;
			const target = e.target as HTMLElement | null;
			// A focused select needs its letters (typeahead), Home/End and the
			// brackets for itself, same as a text field.
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
			if (target?.tagName === "INPUT") {
				const type = (target as HTMLInputElement).type;
				// Buttons, checkboxes, radios and sliders keep focus after a click
				// or drag, so their letters must still reach the viewer. A slider
				// keeps only the keys it moves itself.
				if (!NON_TEXT_INPUT_TYPES.has(type)) return;
				if (type === "range" && !e.metaKey && !e.ctrlKey && !e.altKey && RANGE_NATIVE_KEYS.has(e.key)) return;
			}
			// A button in the AI panel keeps focus after a model pick or Send, so
			// what the reader types next belongs to the panel, not the viewer.
			if (e.key !== "Escape" && target?.closest?.("#bodymaps-ai-sidebar")) return;
			// A modal dialog or a guided-step card owns the keyboard while it is
			// open: S would download a snapshot of the panes behind it, Home/End
			// on its audio scrubber would also move the slice. Escape has its own
			// dialog check below.
			if (e.key !== "Escape" && target?.closest?.('[role="dialog"][aria-modal="true"], [data-guided-overlay]')) return;
			// Clicking the dimmed backdrop drops focus to <body>, so the target
			// test above misses it. The step card (a dialog, or a status while
			// it applies) is still up, though, and M would tear the flow down.
			// The click-through hint and continue pill are not cards and stay out.
			if (e.key !== "Escape" && document.querySelector('[data-guided-overlay][role="dialog"], [data-guided-overlay][role="status"]')) return;

			const key = e.key.toLowerCase();
			// A Russian, Greek, Hebrew or Arabic layout types a non-Latin letter
			// on the Z key, so undo and redo are read by position there.
			const nonLatinLetter = /^\p{L}$/u.test(e.key) && !/^\p{Script=Latin}$/u.test(e.key);

			// ---- Escape: disarm the armed tool ---------------------------------
			// Only for an Escape nothing else wanted. An open toolbar flyout
			// or dialog stops it before it gets here; popovers close on it; a
			// half-drawn measurement, lasso or polygon clears first. Some of
			// those listeners run after this one, so whether anyone used it
			// (see escapeUsed) is checked once the event has finished.
			if (e.key === "Escape") {
				if (!onEscape || e.metaKey || e.ctrlKey || e.altKey || escapeWasUsed(e)) return;
				if (target?.closest?.('[role="dialog"], [aria-modal="true"], .vp-flyout')) return;
				window.setTimeout(() => {
					if (!escapeWasUsed(e)) onEscape();
				}, 0);
				return;
			}

			// ---- Undo / redo ---------------------------------------------------
			// Plain undo goes through onUndo (not undoMaskEdit directly) so a
			// pending scissors/lasso point gets peeled off first — see
			// handleUndo in VisualizationPage for why. Redo has no per-tool
			// equivalent, so it still calls redoMaskEdit() straight through.
			if ((e.metaKey || e.ctrlKey) && !e.altKey && (key === "z" || (nonLatinLetter && e.code === "KeyZ"))) {
				if (onCollaborationUndo) {
					if (!e.shiftKey && collaborationConnected && !collaborationLocked) onCollaborationUndo();
					e.preventDefault();
					return;
				}
				if (e.shiftKey) redoMaskEdit();
				else onUndo();
				e.preventDefault();
				return;
			}

			// ---- Cmd/Ctrl+0: reset zoom to fit ----------------------------------
			if ((e.metaKey || e.ctrlKey) && !e.altKey && e.code === "Digit0") {
				zoomToFit();
				setZoomLevel(1);
				e.preventDefault();
				return;
			}

			// ---- Cmd/Ctrl+←/→: jump focused pane to first/last slice -----------
			if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
				jumpSlice(getFocusedPane(), e.code === "ArrowLeft" ? "first" : "last");
				e.preventDefault();
				return;
			}

			// Zoom and slice keys are matched on the character the layout types
			// (e.key), with the physical key (e.code) only as the fallback for a
			// dead or unidentified key. On a German keyboard "+" sits on the
			// BracketRight key and "-" on Slash, and "[" / "]" are AltGr
			// characters, which browsers report with Ctrl and Alt both held.
			// Layouts that type a non-Latin letter (Russian, Greek, Hebrew,
			// Arabic) have no bracket characters, so their bracket keys are
			// read by position, as before.
			const bracketChar = e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}";

			// Any other modified combo (Cmd/Ctrl/Alt) — not one of ours, don't intercept.
			if ((e.metaKey || e.ctrlKey || e.altKey) && !(e.altKey && !e.metaKey && bracketChar)) return;

			// ---- +/-: zoom toward the last-tracked cursor position --------------
			if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") {
				zoom(ZOOM_STEP_FACTOR);
				e.preventDefault();
				return;
			}
			if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") {
				zoom(1 / ZOOM_STEP_FACTOR);
				e.preventDefault();
				return;
			}

			// ---- [ / ]: step slice by 1 ------------------------------------------
			// ---- Shift+[ / Shift+]: step by 10, or resize the brush while editing
			const bracketKey = nonLatinLetter && (e.code === "BracketLeft" || e.code === "BracketRight");
			if (bracketChar || bracketKey) {
				const dir = e.key === "[" || e.key === "{" || (bracketKey && e.code === "BracketLeft") ? -1 : 1;
				// The brace is the Shift form, though some layouts type it with AltGr alone.
				if (e.shiftKey || e.key === "{" || e.key === "}") {
					if (BRUSH_SIZE_EDIT_MODES.has(editMode)) {
						adjustBrush(dir * BRUSH_STEP_MM);
					} else {
						stepSlice(getFocusedPane(), dir * 10);
					}
				} else {
					stepSlice(getFocusedPane(), dir);
				}
				e.preventDefault();
				return;
			}

			// ---- PageUp/PageDown: step slice by 1 (same as [ / ]) ----------------
			if (e.code === "PageUp" || e.code === "PageDown") {
				stepSlice(getFocusedPane(), e.code === "PageUp" ? 1 : -1);
				e.preventDefault();
				return;
			}

			// ---- Home/End: jump focused pane to first/last slice -----------------
			// A focused radio in a flyout uses them to move between its choices.
			// Native radios (the challenge findings) have no Home/End of their own.
			if ((e.code === "Home" || e.code === "End") && !target?.closest?.('.atb-menu-col[role="radiogroup"]')) {
				jumpSlice(getFocusedPane(), e.code === "Home" ? "first" : "last");
				e.preventDefault();
				return;
			}

			// ---- Plain letter shortcuts -------------------------------------------
			// These are toggles and one-shot actions: a held key must not download
			// a snapshot per repeat or flip cine, the panel and the tools on and off.
			// The slice, zoom and brush keys above keep auto-repeating.
			if (e.repeat && (TOOL_BY_KEY[key] || key === "c" || key === "s" || key === "v" || key === "m")) {
				e.preventDefault();
				return;
			}
			if (TOOL_BY_KEY[key]) {
				if (onCollaborationUndo && (!collaborationConnected || collaborationLocked)) return;
				// Leaving annotation for a measure tool must retire the whole
				// ribbon, not just the brush — same as the Download/HD buttons.
				closeAnnotationToolbarIfOpen?.();
				setEditMode(null); // measurement keys take the mouse back from the brush
				setActiveMeasureTool((prev) => (prev === TOOL_BY_KEY[key] ? null : TOOL_BY_KEY[key]));
			} else if (key === "c") {
				closeAnnotationToolbarIfOpen?.();
				setEditMode(null);
				setActiveMeasureTool(null);
				setCrosshairToolActive(true);
			} else if (key === "s") {
				void takeSnapshot();
			} else if (key === "v") {
				toggleCine();
			} else if (key === "m") {
				setShowStats(false);
				setShowMetadata(false);
				// The full close also drops the target class, so its mask isolation ends.
				if (closeAnnotationToolbarIfOpen) closeAnnotationToolbarIfOpen();
				else setShowAnnotationToolbar(false);
				setEditMode(null);
				setShowMeasurePanel((v) => !v);
			} else {
				return;
			}
			e.preventDefault();
		};

		// A half-drawn measurement takes the Escape first. Capture phase, so
		// this runs before Cornerstone's own Freehand binding would cancel the
		// outline without the Escape being marked, and the tool disarm with it.
		const onEscapeCapture = (e: KeyboardEvent) => {
			if (disabled || e.key !== "Escape" || !cancelDrawing) return;
			if (cancelDrawing()) markEscapeUsed(e);
		};

		window.addEventListener("keydown", onKey);
		window.addEventListener("keydown", onEscapeCapture, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keydown", onEscapeCapture, true);
		};
	}, [
		takeSnapshot,
		toggleCine,
		setEditMode,
		setActiveMeasureTool,
		setCrosshairToolActive,
		setShowStats,
		setShowMetadata,
		setShowAnnotationToolbar,
		setShowMeasurePanel,
		getFocusedPane,
		sliceInfoRef,
		editMode,
		setZoomLevel,
		collaborationConnected,
		collaborationLocked,
		onCollaborationUndo,
		onUndo,
		disabled,
		closeAnnotationToolbarIfOpen,
		onEscape,
		cancelDrawing,
	]);
}
