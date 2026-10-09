import { useCallback, useEffect, useRef, useState } from "react";
import { getEditedSegments, subscribeToSegmentationEdits } from "../CornerstoneNifti2";

// How long edits must pause before the list is read again, the same wait LiveSegmentMesh
// gives edits before it rebuilds a mesh. A brush drag fires an edit on every step, so
// reading on each one would re-render the page, and mount a live mesh whose first
// surface extraction scans the whole labelmap, in the middle of the stroke.
export const EDITED_CATALOG_SETTLE_MS = 400;

const NONE: number[] = [];

// Catalog classes (ids 1..catalogSize) edited on this page for `caseId`, in id order, for the
// 3D pane: one the scan has no baked mesh for is drawn live there (see SegmentationMeshViewer).
// Local edits are picked up once they settle. `refresh` does the same for edits that arrive
// without a local edit event, such as live-room mask patches and their replay after a reload.
export function useEditedCatalogIds(caseId: string, catalogSize: number): { ids: number[]; refresh: () => void } {
	const [state, setState] = useState<{ caseId: string; ids: number[] }>({ caseId: "", ids: NONE });
	const current = useRef({ caseId, catalogSize });
	useEffect(() => {
		current.current = { caseId, catalogSize };
	}, [caseId, catalogSize]);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const refresh = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			const { caseId: id, catalogSize: size } = current.current;
			const ids = [...getEditedSegments()].filter((n) => n > 0 && n <= size).sort((a, b) => a - b);
			setState((prev) =>
				prev.caseId === id && ids.length === prev.ids.length && ids.every((n, i) => prev.ids[i] === n) ? prev : { caseId: id, ids }
			);
		}, EDITED_CATALOG_SETTLE_MS);
	}, []);
	useEffect(() => {
		const unsubscribe = subscribeToSegmentationEdits(() => refresh());
		return () => {
			unsubscribe();
			clearTimeout(timer.current);
		};
	}, [refresh]);
	return { ids: state.caseId === caseId ? state.ids : NONE, refresh };
}
