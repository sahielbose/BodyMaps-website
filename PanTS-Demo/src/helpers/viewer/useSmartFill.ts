import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToVoxel,
	canvasPointToWorld,
	worldToCanvasPoint,
	runDualScribbleFill,
	pushEditHistory,
	type CinePane,
	type SliceInfo,
	type MaskFilter,
} from "../CornerstoneNifti2";
import type { Point3 } from "@cornerstonejs/core/types";

// World-space, not canvas-pixel — a canvas position only means what it means
// for the camera active the instant it was clicked, so a dot stored that way
// visually drifts off the marked anatomy the moment the user zooms/pans.
// Storing world coordinates and reprojecting to canvas pixels on every
// render keeps the preview pinned to the same spot on the slice regardless
// of zoom. (The actual fill algorithm below already works in voxel space via
// fgVoxelsRef/bgVoxelsRef, so it was never affected — only the preview dots
// were drifting.)
type ScribblePoint = { posWorld: Point3; slice: number };
type PanePreview = { fg: ScribblePoint[]; bg: ScribblePoint[] };

const EMPTY_PREVIEW: Record<CinePane, PanePreview> = {
	axial: { fg: [], bg: [] },
	sagittal: { fg: [], bg: [] },
	coronal: { fg: [], bg: [] },
};

interface UseSmartFillArgs {
	/** Only active while the caller's edit mode is "smartfill". */
	enabled: boolean;
	/** Read the current slice index per pane (kept as a ref by the caller so
	 *  this hook doesn't need to re-render on every slice change). */
	sliceInfoRef: React.MutableRefObject<Record<CinePane, SliceInfo | null>>;
	/** Global "applies to" masking predicate — same one every other tool uses. */
	maskFilter: MaskFilter;
	/** Optional reading-session logger. */
	onLog?: (detail: string) => void;
}

/**
 * Click-and-drag scribble segmentation: mark foreground (cyan) and background
 * (red) voxels on any pane, then apply a dual-scribble fill that grows the
 * foreground region away from the background markers. Scope can be locked to
 * the pane/slice the scribbles started on, or applied across the whole volume.
 */
export function useSmartFill({ enabled, sliceInfoRef, maskFilter, onLog }: UseSmartFillArgs) {
	const [markMode, setMarkMode] = useState<"fg" | "bg">("fg");
	const [scope, setScope] = useState<"slice" | "volume">("slice");
	const [previewWorld, setPreviewWorld] = useState<Record<CinePane, PanePreview>>(EMPTY_PREVIEW);

	const scribbleActiveRef = useRef(false);
	const fgVoxelsRef = useRef<[number, number, number][]>([]);
	const bgVoxelsRef = useRef<[number, number, number][]>([]);
	const paneRef = useRef<CinePane | null>(null);

	// Mirrors `previewWorld` so stroke bookkeeping can read the latest value
	// synchronously (state updates are async/batched, refs aren't).
	const previewRef = useRef(previewWorld);
	const updatePreview = (next: Record<CinePane, PanePreview>) => {
		previewRef.current = next;
		setPreviewWorld(next);
	};

	// Captures everything needed to undo/redo one whole click-and-drag
	// stroke as a single step — not one undo per pixel, the same way a
	// brush stroke undoes as one action rather than one per sampled point.
	const strokeRef = useRef<{
		mode: "fg" | "bg";
		pane: CinePane;
		voxelStart: number;
		previewStart: number;
	} | null>(null);

	const clearScribbles = () => {
		fgVoxelsRef.current = [];
		bgVoxelsRef.current = [];
		paneRef.current = null;
		updatePreview(EMPTY_PREVIEW);
	};

	const addPoint = (pane: CinePane, e: MouseEvent) => {
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const voxel = canvasPointToVoxel(pane, canvasPos);
		if (!voxel) return;
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return;

		paneRef.current = pane;
		(markMode === "fg" ? fgVoxelsRef : bgVoxelsRef).current.push(voxel);

		const sliceIdx = sliceInfoRef.current[pane]?.current ?? -1;
		updatePreview({
			...previewRef.current,
			[pane]: {
				...previewRef.current[pane],
				[markMode]: [...previewRef.current[pane][markMode], { posWorld: world, slice: sliceIdx }],
			},
		});
	};

	const apply = () => {
		const fg = fgVoxelsRef.current;
		const bg = bgVoxelsRef.current;
		if (!fg.length || !bg.length) return;

		const sliceLock = scope === "slice" && paneRef.current ? { pane: paneRef.current } : null;
		const result = runDualScribbleFill(fg, bg, { sliceLock, maskFilter });
		if (result) onLog?.(`Smart fill: ${result.filledVoxels.toLocaleString()} voxels`);
		clearScribbles();
	};

	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		e.preventDefault();
		scribbleActiveRef.current = true;
		strokeRef.current = {
			mode: markMode,
			pane,
			voxelStart: (markMode === "fg" ? fgVoxelsRef : bgVoxelsRef).current.length,
			previewStart: previewRef.current[pane][markMode].length,
		};
		addPoint(pane, e);
	};
	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || !scribbleActiveRef.current) return;
		addPoint(pane, e);
	};
	// A stroke released outside the pane never reaches the pane's own mouseup
	// handler, which used to leave scribbleActiveRef stuck true — moving the
	// mouse back over the pane kept painting with no button held. The window
	// always sees the release, and the handler below reads only refs, so
	// ending the stroke from here is identical to ending it from the pane.
	const handleMouseUpRef = useRef<() => void>(() => {});
	useEffect(() => {
		const end = () => handleMouseUpRef.current();
		window.addEventListener("mouseup", end);
		window.addEventListener("blur", end);
		return () => {
			window.removeEventListener("mouseup", end);
			window.removeEventListener("blur", end);
		};
	}, []);

	const handleMouseUp = () => {
		scribbleActiveRef.current = false;
		const stroke = strokeRef.current;
		strokeRef.current = null;
		if (!stroke) return;

		const { mode, pane, voxelStart, previewStart } = stroke;
		const voxelsRef = mode === "fg" ? fgVoxelsRef : bgVoxelsRef;
		const addedVoxels = voxelsRef.current.slice(voxelStart);
		const addedPreview = previewRef.current[pane][mode].slice(previewStart);
		if (!addedVoxels.length) return; // clicked but no valid voxel under the cursor

		pushEditHistory({
			undo: () => {
				voxelsRef.current = voxelsRef.current.slice(0, voxelStart);
				updatePreview({
					...previewRef.current,
					[pane]: { ...previewRef.current[pane], [mode]: previewRef.current[pane][mode].slice(0, previewStart) },
				});
			},
			redo: () => {
				voxelsRef.current = [...voxelsRef.current, ...addedVoxels];
				updatePreview({
					...previewRef.current,
					[pane]: { ...previewRef.current[pane], [mode]: [...previewRef.current[pane][mode], ...addedPreview] },
				});
			},
		});
	};

	// Canvas-pixel view of the world-space preview dots, reprojected against
	// whatever camera (zoom/pan) is active on THIS render — this is what the
	// overlay should actually draw from, so the dots track the marked
	// anatomy through zoom instead of staying pinned to old pixel positions.
	const preview: Record<CinePane, { fg: Array<{ pos: [number, number]; slice: number }>; bg: Array<{ pos: [number, number]; slice: number }> }> = {
		axial: { fg: [], bg: [] },
		sagittal: { fg: [], bg: [] },
		coronal: { fg: [], bg: [] },
	};
	(Object.keys(previewWorld) as CinePane[]).forEach((pane) => {
		(["fg", "bg"] as const).forEach((mode) => {
			for (const pt of previewWorld[pane][mode]) {
				const pos = worldToCanvasPoint(pane, pt.posWorld);
				if (pos) preview[pane][mode].push({ pos, slice: pt.slice });
			}
		});
	});

	handleMouseUpRef.current = handleMouseUp;

	return {
		markMode,
		setMarkMode,
		scope,
		setScope,
		preview,
		handleMouseDown,
		handleMouseMove,
		handleMouseUp,
		apply,
		clearScribbles,
		hasForegroundMarks: fgVoxelsRef.current.length > 0,
		hasBackgroundMarks: bgVoxelsRef.current.length > 0,
	};
}