import { lassoCommitPolygon, type CinePane, type MaskFilter } from "../CornerstoneNifti2";
import { usePolygonDraw } from "./usePolygonDraw";
import { voxelsLog } from "./editLog";

interface UseLassoToolArgs {
	enabled: boolean;
	maskFilter: MaskFilter;
	onLog?: (detail: string) => void;
	/** Plain-sentence hint shown to the reader when a closed loop changed nothing. */
	onNoop?: (message: string) => void;
	/** The slice a pane is showing, so a loop left open across a slice change is cleared. */
	sliceKey?: (pane: CinePane) => string | number | null | undefined;
}

export function useLassoTool({ enabled, maskFilter, onLog, onNoop, sliceKey }: UseLassoToolArgs) {
	const draw = usePolygonDraw({
		enabled,
		sliceKey,
		onNoop,
		onClose: (pane, points) => {
			const result = lassoCommitPolygon(pane, points, undefined, maskFilter);
			if (result?.filledVoxels) onLog?.(`Lasso fill (${voxelsLog(result.filledVoxels)})`);
			else onNoop?.("Nothing was filled. Try a larger loop.");
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