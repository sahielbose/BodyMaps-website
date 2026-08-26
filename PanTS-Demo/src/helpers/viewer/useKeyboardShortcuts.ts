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
	setMaskBrushSize,
	setPaneSliceIndex,
	zoomToCursor,
	zoomToFit,
	type CinePane,
	type PrimaryMouseToolName,
	type SliceInfo,
} from "../CornerstoneNifti2";
import type { MaskEditMode } from "../../routes/VisualizationPage";

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

const MIN_BRUSH_MM = 2;
const MAX_BRUSH_MM = 40;
const DEFAULT_BRUSH_MM = 10;
const BRUSH_STEP_MM = 2;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 8;
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
}

/**
 * Global keyboard shortcuts (skipped while typing in an input/textarea):
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
	collaborationConnected,
	collaborationLocked,
	onCollaborationUndo,
	onUndo,
	disabled,
}: UseKeyboardShortcutsArgs) {
	// Last-seen mouse position (viewport-relative clientX/Y), updated on every
	// mousemove so +/- can zoom toward "wherever the cursor last was" even
	// though a keydown event carries no pointer coordinates of its own.
	const lastMousePosRef = useRef<{ x: number; y: number } | null>(null);
	// Brush size isn't hoisted to VisualizationPage (it lives as local state in
	// MaskEditPanel), so the keyboard shortcut tracks its own last-set value.
	// Caveat: if the Edit panel's slider is dragged after a keyboard resize (or
	// vice versa), the two can drift until one of them is touched again — the
	// underlying Cornerstone brush radius (setMaskBrushSize) is always correct,
	// it's only the panel's displayed slider value that can lag.
	const brushMmRef = useRef(DEFAULT_BRUSH_MM);

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
			zoomToCursor(target.viewportId, target.canvasPos, factor);
			setZoomLevel((prev) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev * factor)));
		};

		const adjustBrush = (deltaMm: number) => {
			const next = Math.max(MIN_BRUSH_MM, Math.min(MAX_BRUSH_MM, brushMmRef.current + deltaMm));
			brushMmRef.current = next;
			setMaskBrushSize(next);
		};

		const onKey = (e: KeyboardEvent) => {
			if (disabled) return;
			const target = e.target as HTMLElement | null;
			if (
				target &&
				(target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
			)
				return;

			const key = e.key.toLowerCase();

			// ---- Undo / redo ---------------------------------------------------
			// Plain undo goes through onUndo (not undoMaskEdit directly) so a
			// pending scissors/lasso point gets peeled off first — see
			// handleUndo in VisualizationPage for why. Redo has no per-tool
			// equivalent, so it still calls redoMaskEdit() straight through.
			if ((e.metaKey || e.ctrlKey) && !e.altKey && key === "z") {
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

			// Any other modified combo (Cmd/Ctrl/Alt) — not one of ours, don't intercept.
			if (e.metaKey || e.ctrlKey || e.altKey) return;

			// ---- +/-: zoom toward the last-tracked cursor position --------------
			if (e.code === "Equal" || e.code === "NumpadAdd") {
				zoom(ZOOM_STEP_FACTOR);
				e.preventDefault();
				return;
			}
			if (e.code === "Minus" || e.code === "NumpadSubtract") {
				zoom(1 / ZOOM_STEP_FACTOR);
				e.preventDefault();
				return;
			}

			// ---- [ / ]: step slice by 1 ------------------------------------------
			// ---- Shift+[ / Shift+]: step by 10, or resize the brush while editing
			if (e.code === "BracketLeft" || e.code === "BracketRight") {
				const dir = e.code === "BracketLeft" ? -1 : 1;
				if (e.shiftKey) {
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
			if (e.code === "Home" || e.code === "End") {
				jumpSlice(getFocusedPane(), e.code === "Home" ? "first" : "last");
				e.preventDefault();
				return;
			}

			// ---- Plain letter shortcuts -------------------------------------------
			if (TOOL_BY_KEY[key]) {
				if (onCollaborationUndo && (!collaborationConnected || collaborationLocked)) return;
				setEditMode(null); // measurement keys take the mouse back from the brush
				setActiveMeasureTool((prev) => (prev === TOOL_BY_KEY[key] ? null : TOOL_BY_KEY[key]));
			} else if (key === "c") {
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
				setShowAnnotationToolbar(false);
				setEditMode(null);
				setShowMeasurePanel((v) => !v);
			} else {
				return;
			}
			e.preventDefault();
		};

		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
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
	]);
}
