import { useEffect, useRef, useState } from "react";
import {
	clearMeasurements,
	getMeasurementSummaries,
	jumpToMeasurement,
	removeMeasurement,
	renameMeasurement,
	subscribeToMeasurementChanges,
	type MeasurementSummary,
} from "../../helpers/CornerstoneNifti2";
import { useKeepFocusInPanel } from "../../hooks/useKeepFocusInPanel";
import PanelHeader from "../PanelHeader";
import { ClearAllChips } from "./ClearMeasurementsConfirm";
import MeasurementItem from "./MeasurementItem";
import { duplicatePositions, measurementRowName } from "./measurementRowName";
import "./MeasurementPanel.css";

type Props = {
	onClose: () => void;
	/** Called with the world-mm target after a jump, so the page can sync its own crosshair state. */
	onJump?: (mm: [number, number, number]) => void;
	/** A locked or disconnected live room: edits would not reach the room, so renaming and deleting are off. */
	readOnly?: boolean;
};

// Right-side inventory of every measurement on the images: rename it (e.g.
// "lesion"), jump the crosshair to it, or delete it. Named labels flow into the
// reading-session report.
function MeasurementPanel({ onClose, onJump, readOnly }: Props) {
	const [items, setItems] = useState<MeasurementSummary[]>(() => getMeasurementSummaries());
	const rootRef = useRef<HTMLDivElement>(null);
	const noteFocus = useKeepFocusInPanel(rootRef, items);

	useEffect(() => {
		// Any change (draw / drag-edit / delete, or a live room peer's add / rename /
		// delete) refreshes the whole list, which is tiny.
		const unsubscribe = subscribeToMeasurementChanges(
			() => {
				noteFocus();
				setItems(getMeasurementSummaries());
			},
			{ includeRemote: true }
		);
		return unsubscribe;
	}, [noteFocus]);

	const commitLabel = (uid: string, label: string) => {
		renameMeasurement(uid, label.trim());
		setItems(getMeasurementSummaries());
	};

	const positions = duplicatePositions(items.map((m) => measurementRowName(m.tool, m.label, m.value)));

	return (
		<div ref={rootRef} className="vp-measure" role="region" aria-label="Measurements">
			<PanelHeader title="Measurements" closeLabel="Close measurements" onClose={onClose}>
				{items.length > 0 && (
					<ClearAllChips
						disabled={readOnly}
						onClear={() => {
							clearMeasurements();
							setItems([]);
						}}
					/>
				)}
			</PanelHeader>
			{items.length === 0 ? (
				<div className="vp-panel__empty">
					No measurements yet.
					<span className="vp-panel__hint">
						Pick a tool from the Measure menu (or <span className="vp-panel__nowrap">press L / A / P / R / E</span>) and draw on a slice.
					</span>
				</div>
			) : (
				<div className="vp-measure__list">
					{items.map((m, i) => (
						<MeasurementItem
							key={m.uid}
							tool={m.tool}
							label={m.label}
							value={m.value}
							position={positions[i]}
							canJump={!!m.center}
							readOnly={readOnly}
							onRename={(label) => commitLabel(m.uid, label)}
							onJump={() => {
								const mm = jumpToMeasurement(m.uid);
								if (mm) onJump?.(mm);
							}}
							onDelete={() => removeMeasurement(m.uid)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export default MeasurementPanel;
