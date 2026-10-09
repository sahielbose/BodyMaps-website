import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { canvasPointToVoxel, type CinePane } from "../CornerstoneNifti2";
import { commitOnRelease } from "./commitOnRelease";

interface UseMorphPickerArgs {
	/** Reset the picker whenever the owning panel closes. */
	panelOpen: boolean;
}

/**
 * "Pick an island" targeting for morphological mask edits (dilate/erode).
 * `scope` selects whether the op applies to the whole segment or just the
 * connected island under the picked voxel; `seedVoxel` is that voxel once
 * a pick has been made.
 */
export function useMorphPicker({ panelOpen }: UseMorphPickerArgs) {
	const [scope, setScope] = useState<"segment" | "island">("segment");
	const [picking, setPicking] = useState(false);
	const [seedVoxel, setSeedVoxel] = useState<[number, number, number] | null>(null);

	// The edit panel is a shared right-side slot with other tools — closing it
	// (or switching away from it) should always cancel an in-progress pick.
	useEffect(() => {
		if (!panelOpen) {
			setPicking(false);
			setSeedVoxel(null);
		}
	}, [panelOpen]);

	const startPicking = () => {
		setSeedVoxel(null);
		setPicking(true);
	};

	// Disarms an armed pick without touching the seed voxel (Exit in the guided
	// flow, or a different ribbon tool taking over the panes).
	const stopPicking = useCallback(() => setPicking(false), []);

	const handlePaneClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!picking) return;
		// Armed from mousedown: only the left button picks.
		if (e.button !== 0) return;
		const target = e.currentTarget as HTMLElement;
		const rect = target.getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		// Pan stays on the left button, so the pick lands on release and only if
		// the pointer stayed put: a drag is a pan and must not use up the pick.
		commitOnRelease(e, () => {
			const voxel = canvasPointToVoxel(pane, canvasPos);
			if (!voxel) return;
			setSeedVoxel(voxel);
			setPicking(false);
		});
	};

	return { scope, setScope, picking, startPicking, stopPicking, seedVoxel, handlePaneClick };
}