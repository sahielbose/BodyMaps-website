// helpers/viewer/useLevelTracing.ts
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToVoxel,
	canvasPointToWorld,
	isWorldPointInSegmentation,
	computeLevelTraceMask,
	commitLevelTraceMask,
	levelTraceMaskToCanvasPath,
	type LevelTraceMask,
	type LevelTraceOperation,
	type MaskFilter,
	type CinePane,
} from "../CornerstoneNifti2";
import { operationLog } from "./editLog";
import { commitOnRelease } from "./commitOnRelease";

interface UseLevelTracingArgs {
	enabled: boolean;
	/** Sensitivity in HU — how far from the cursor's own intensity a neighboring
	 *  pixel can be and still count as "the same region". Fed straight into
	 *  computeLevelTraceMask, so dragging the slider actually changes the traced
	 *  area (previously this was ignored in favor of a fixed internal constant). */
	toleranceHu: number;
	operation: LevelTraceOperation;
	activeSegmentIndex: number | null;
	maskFilter: MaskFilter;
	/** Bump this (e.g. pass the toolbar's zoom slider value) whenever the
	 *  pane's camera changes. The traced mask itself is voxel-space and
	 *  camera-independent, but its cached preview OUTLINE is a canvas-pixel
	 *  path computed the moment the mouse last moved — without this, zooming
	 *  without also moving the mouse leaves that outline drawn at the old
	 *  zoom level (visually detached from the anatomy) until the next
	 *  mousemove happens to refresh it. Re-deriving the outline from the
	 *  still-valid traced mask on every camera change keeps it pinned. */
	cameraVersion?: number;
	/** Changes whenever the slice under any pane changes (scroll, cine,
	 *  crosshair). The cached outline belongs to the old slice, so it is
	 *  dropped until the next mousemove traces the new one. */
	sliceKey?: string;
	onLog?: (detail: string) => void;
	/** Plain-sentence hint shown to the reader when a click changed nothing. */
	onNoop?: (message: string) => void;
}

/** Slicer-style level tracing: on hover, flood-fill the connected same-intensity
 *  region under the cursor on the current slice and preview its outline; on
 *  click, commit it into (or out of) the active segment per `operation`. */
export function useLevelTracing({
	enabled, toleranceHu, operation, activeSegmentIndex, maskFilter, cameraVersion, sliceKey, onLog, onNoop,
}: UseLevelTracingArgs) {
	const [previewPane, setPreviewPane] = useState<CinePane | null>(null);
	const [previewPath, setPreviewPath] = useState<Array<[number, number]> | null>(null);
	// Last computed trace, kept alongside the preview state so a click can reuse
	// it without recomputing when the click point maps to the same voxel.
	const tracedRef = useRef<{ pane: CinePane; mask: LevelTraceMask } | null>(null);

	const clearPreview = useCallback(() => {
		tracedRef.current = null;
		setPreviewPane(null);
		setPreviewPath(null);
	}, []);

	const computeAt = (pane: CinePane, canvasPos: [number, number]): LevelTraceMask | null => {
		// canvasPointToVoxel never bounds-checks, so a pointer in the black margin
		// beside the scan would seed the flood off the grid and wrap onto the
		// opposite edge of the slice.
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world || !isWorldPointInSegmentation(world)) return null;
		const seed = canvasPointToVoxel(pane, canvasPos);
		if (!seed) return null;
		return computeLevelTraceMask(pane, seed, toleranceHu);
	};

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const traced = computeAt(pane, canvasPos);
		if (!traced) { clearPreview(); return; }
		tracedRef.current = { pane, mask: traced };
		setPreviewPane(pane);
		setPreviewPath(levelTraceMaskToCanvasPath(pane, traced));
	};

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		// Runs from mousedown: a right or middle press must not commit a trace.
		if (e.button !== 0) return;
		if (activeSegmentIndex == null) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		// Pan stays on the left button, so the trace is only committed on release
		// and only if the pointer stayed put: a drag is a pan, not a click.
		commitOnRelease(e, () => {
			// Recompute fresh off the click point rather than trusting a possibly
			// stale hover preview (e.g. a click with no preceding mousemove). A click
			// beside the scan never falls back to that preview: it belongs to a spot
			// the pointer has since left.
			const world = canvasPointToWorld(pane, canvasPos);
			if (world && !isWorldPointInSegmentation(world)) {
				onNoop?.("That spot is outside the scan. Click on the image.");
				return;
			}
			const traced = computeAt(pane, canvasPos) ?? (tracedRef.current?.pane === pane ? tracedRef.current.mask : null);
			if (!traced) {
				onNoop?.("No region to trace here. Try a different spot.");
				return;
			}
			const result = commitLevelTraceMask(pane, traced, activeSegmentIndex, operation, maskFilter);
			if (result?.filledVoxels) onLog?.(operationLog("Level trace", operation, result.filledVoxels));
			else onNoop?.("Nothing changed. Try a different spot or a higher sensitivity.");
		});
	};

	// Re-derive the outline from the still-valid (voxel-space) traced mask
	// whenever the camera changes, instead of leaving it drawn at whatever
	// canvas pixels it happened to occupy at the last mousemove.
	useEffect(() => {
		const traced = tracedRef.current;
		if (!traced) return;
		setPreviewPath(levelTraceMaskToCanvasPath(traced.pane, traced.mask));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cameraVersion]);

	// The outline also goes stale when the tool is disarmed, the sensitivity
	// changes (the pointer is on the toolbar, so no mousemove follows) or the
	// slice changes under a still pointer; drop it and let the next hover
	// trace afresh.
	useEffect(() => {
		clearPreview();
	}, [enabled, toleranceHu, sliceKey, clearPreview]);

	return {
		handleClick,
		handleMouseMove,
		clearPreview,
		previewPane,
		previewPath,
	};
}