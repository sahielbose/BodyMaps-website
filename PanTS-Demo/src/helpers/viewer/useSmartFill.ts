import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToVoxel,
	canvasPointToWorld,
	worldToCanvasPoint,
	runDualScribbleFill,
	pushEditHistory,
	isWorldPointInSegmentation,
	discardEditHistoryEntries,
	type CinePane,
	type SliceInfo,
	type MaskFilter,
} from "../CornerstoneNifti2";
import type { Point3 } from "@cornerstonejs/core/types";
import { voxelsLog } from "./editLog";

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
	/** Plain-sentence hint shown to the reader when a mark is refused. */
	onNoop?: (message: string) => void;
}

/**
 * Click-to-mark segmentation: mark foreground (cyan) and background (red)
 * voxels on any pane, then apply a dual-scribble fill that grows the
 * foreground region away from the background markers. Scope can be locked to
 * the pane/slice the foreground was first marked on, or applied across the
 * whole volume. A press that travels is a pan, not a mark.
 */
export function useSmartFill({ enabled, sliceInfoRef, maskFilter, onLog, onNoop }: UseSmartFillArgs) {
	const [markMode, setMarkMode] = useState<"fg" | "bg" | null>("fg");
	const [scope, setScope] = useState<"slice" | "volume">("slice");
	const [previewWorld, setPreviewWorld] = useState<Record<CinePane, PanePreview>>(EMPTY_PREVIEW);

	const fgVoxelsRef = useRef<[number, number, number][]>([]);
	const bgVoxelsRef = useRef<[number, number, number][]>([]);
	// The pane the region was first marked in. The slice lock follows this, not
	// whichever pane the last mark (often an exclusion point) landed on.
	const fgPaneRef = useRef<CinePane | null>(null);

	// Mirrors `previewWorld` so stroke bookkeeping can read the latest value
	// synchronously (state updates are async/batched, refs aren't).
	const previewRef = useRef(previewWorld);
	const updatePreview = (next: Record<CinePane, PanePreview>) => {
		previewRef.current = next;
		setPreviewWorld(next);
	};

	// Where the left button went down. Pan stays on the left button while this
	// tool is armed, so the mark is only committed on release, and only if the
	// pointer stayed put: a drag is a pan and must not drop a seed at its start.
	// Same 4px slack as the point prompt tool.
	const pressRef = useRef<{
		mode: "fg" | "bg";
		pane: CinePane;
		canvasPos: [number, number];
		client: [number, number];
		moved: boolean;
	} | null>(null);

	// The shared-history entry of every stroke still on screen. Once the marks
	// are cleared those entries only slice empty arrays, so they leave the
	// history with them instead of costing the reader dead Undo presses.
	const strokeEntriesRef = useRef<ReturnType<typeof pushEditHistory>[]>([]);

	const clearScribbles = () => {
		discardEditHistoryEntries(strokeEntriesRef.current.filter(Boolean));
		strokeEntriesRef.current = [];
		fgVoxelsRef.current = [];
		bgVoxelsRef.current = [];
		fgPaneRef.current = null;
		updatePreview(EMPTY_PREVIEW);
	};

	// Returns what was added so the caller can record it as one undo step.
	const addPoint = (mode: "fg" | "bg", pane: CinePane, canvasPos: [number, number]) => {
		const voxel = canvasPointToVoxel(pane, canvasPos);
		if (!voxel) return null;
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return null;
		// canvasPointToVoxel never bounds-checks, so a click in the black margin
		// around the scan would count as a mark the fill later throws away.
		if (!isWorldPointInSegmentation(world)) return null;

		const voxelsRef = mode === "fg" ? fgVoxelsRef : bgVoxelsRef;
		const firstForeground = mode === "fg" && voxelsRef.current.length === 0;
		if (firstForeground) fgPaneRef.current = pane;
		voxelsRef.current.push(voxel);

		const sliceIdx = sliceInfoRef.current[pane]?.current ?? -1;
		const dot = { posWorld: world, slice: sliceIdx };
		updatePreview({
			...previewRef.current,
			[pane]: { ...previewRef.current[pane], [mode]: [...previewRef.current[pane][mode], dot] },
		});
		return { voxel, dot, firstForeground };
	};

	// Returns how many voxels the fill wrote, so the caller can tell a real
	// fill from one that was refused (no background marks) or changed
	// nothing. The marks are kept in that case so the user can adjust them.
	const apply = (): number => {
		const fg = fgVoxelsRef.current;
		const bg = bgVoxelsRef.current;
		if (!fg.length || !bg.length) return 0;

		const sliceLock = scope === "slice" && fgPaneRef.current ? { pane: fgPaneRef.current } : null;
		const result = runDualScribbleFill(fg, bg, { sliceLock, maskFilter });
		if (!result || result.filledVoxels <= 0) return 0;
		const n = result.filledVoxels;
		onLog?.(`Grew a class from seeds (${voxelsLog(n)})`);
		clearScribbles();
		return result.filledVoxels;
	};

	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || !markMode) return;
		// A right press opens the context menu, which swallows its mouseup and
		// would leave the press pending with no button held.
		if (e.button !== 0) return;
		e.preventDefault();
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		pressRef.current = {
			mode: markMode,
			pane,
			canvasPos: [e.clientX - rect.left, e.clientY - rect.top],
			client: [e.clientX, e.clientY],
			moved: false,
		};
	};
	const handleMouseMove = (_pane: CinePane) => (e: MouseEvent) => {
		const press = pressRef.current;
		if (!enabled || !press || press.moved) return;
		if (Math.abs(e.clientX - press.client[0]) >= 4 || Math.abs(e.clientY - press.client[1]) >= 4) press.moved = true;
	};
	// A press released outside the pane never reaches the pane's own mouseup
	// handler, which would leave the press pending. The window always sees the
	// release, and the handler below reads only refs, so ending the press from
	// here is identical to ending it from the pane. A window blur has no
	// release, so it drops the press without marking anything.
	const handleMouseUpRef = useRef<() => void>(() => {});
	useEffect(() => {
		const end = () => handleMouseUpRef.current();
		const cancel = () => { pressRef.current = null; };
		window.addEventListener("mouseup", end);
		window.addEventListener("blur", cancel);
		return () => {
			window.removeEventListener("mouseup", end);
			window.removeEventListener("blur", cancel);
		};
	}, []);

	const handleMouseUp = () => {
		const press = pressRef.current;
		pressRef.current = null;
		if (!press || press.moved) return;

		const { mode, pane, canvasPos } = press;
		const voxelsRef = mode === "fg" ? fgVoxelsRef : bgVoxelsRef;
		const voxelStart = voxelsRef.current.length;
		const previewStart = previewRef.current[pane][mode].length;
		const added = addPoint(mode, pane, canvasPos);
		if (!added) {
			// clicked but no valid voxel under the cursor
			onNoop?.("That spot is outside the scan. Click on the image.");
			return;
		}
		const { voxel, dot, firstForeground } = added;

		const entry = pushEditHistory({
			undo: () => {
				voxelsRef.current = voxelsRef.current.slice(0, voxelStart);
				if (firstForeground) fgPaneRef.current = null;
				updatePreview({
					...previewRef.current,
					[pane]: { ...previewRef.current[pane], [mode]: previewRef.current[pane][mode].slice(0, previewStart) },
				});
			},
			redo: () => {
				voxelsRef.current = [...voxelsRef.current, voxel];
				if (firstForeground) fgPaneRef.current = pane;
				updatePreview({
					...previewRef.current,
					[pane]: { ...previewRef.current[pane], [mode]: [...previewRef.current[pane][mode], dot] },
				});
			},
		});
		strokeEntriesRef.current.push(entry);
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