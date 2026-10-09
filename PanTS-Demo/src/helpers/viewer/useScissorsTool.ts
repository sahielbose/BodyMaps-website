import { cutSegmentWithPolygon, computeLiveWirePath, type CinePane, type ScissorsOperation, type MaskFilter } from "../CornerstoneNifti2";
import { usePolygonDraw } from "./usePolygonDraw";
import { operationLog } from "./editLog";

interface UseScissorsToolArgs {
	enabled: boolean;
	operation: ScissorsOperation;
	applyToVisibleSegments: boolean;
	visibleSegmentIndices: number[];
	activeSegmentIndex: number | null;
	maskFilter: MaskFilter; // <-- was missing
	/** When true, every placed point (and the live preview point) snaps onto
	 *  the nearest strong intensity edge within a small radius — the "magnet"
	 *  helper, like Photoshop's magnetic lasso. */
	magnetEnabled?: boolean;
	onLog?: (detail: string) => void;
	/** Plain-sentence hint shown to the reader when a closed shape changed nothing. */
	onNoop?: (message: string) => void;
	/** The slice a pane is showing, so a shape left open across a slice change is cleared. */
	sliceKey?: (pane: CinePane) => string | number | null | undefined;
}

/** Draw a closed shape, cut with it: erase/fill inside or outside, on the drawn slice only. */
export function useScissorsTool({
	enabled, operation, applyToVisibleSegments, visibleSegmentIndices, activeSegmentIndex, maskFilter, magnetEnabled, onLog, onNoop, sliceKey,
}: UseScissorsToolArgs) {
	const draw = usePolygonDraw({
		enabled,
		sliceKey,
		onNoop,
		// Real Photoshop-style magnetic lasso behavior: between fastening
		// points, the path is the lowest-cost route (Mortensen & Barrett
		// "live wire", via Dijkstra over gradient/Laplacian/direction cost)
		// hugging nearby intensity edges, instead of snapping each raw click
		// onto the nearest edge pixel (which is what made it feel like it was
		// "going wherever it wants" — a single point snap has no notion of a
		// path between points, so it could jump to an unrelated nearby edge).
		computeLivePath: magnetEnabled
			? (pane, from, to) => computeLiveWirePath(pane, from, to)
			: undefined,
		onClose: (pane, points) => {
			if (activeSegmentIndex == null) return;
			const result = cutSegmentWithPolygon(
				pane,
				points,
				{ operation, sliceCut: "unlimited", sliceCutDepthMm: 0, applyToVisibleSegments, visibleSegmentIndices },
				activeSegmentIndex,
				maskFilter // <-- was missing, so it always defaulted to () => true ("everywhere")
			);
			if (result?.changedVoxels) onLog?.(operationLog("Scissors", operation, result.changedVoxels));
			else onNoop?.("Nothing changed. Try repositioning the shape.");
		},
	});

	return {
		pane: draw.pane,
		anchorsCanvas: draw.points,
		cornersCanvas: draw.corners,
		livePreview: draw.livePreview,
		livePreviewPath: draw.livePreviewPath,
		nearClose: draw.nearClose,
		handleClick: draw.handleClick,
		handleDoubleClick: draw.handleDoubleClick,
		handleMouseMove: draw.handleMouseMove,
		undo: draw.undo,
		cancel: draw.cancel,
		reset: draw.reset,
	};
}