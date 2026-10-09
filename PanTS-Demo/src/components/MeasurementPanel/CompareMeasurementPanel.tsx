import { useEffect, useRef, useState } from "react";
import {
	type CaseKey,
	type CompareHandle,
	type MeasurementSummary,
} from "../../helpers/compareViewer";
import { useKeepFocusInPanel } from "../../hooks/useKeepFocusInPanel";
import PanelHeader from "../PanelHeader";
import { ClearAllChips } from "./ClearMeasurementsConfirm";
import MeasurementItem from "./MeasurementItem";
import { duplicatePositions, measurementRowName } from "./measurementRowName";
import "./MeasurementPanel.css";

type Props = {
	handle: CompareHandle | null;
	idA: string;
	idB: string;
	onClose: () => void;
};

// Same inventory as the single viewer's MeasurementPanel (rename / jump / delete), but
// sourced from the compare viewer's handle and tagged with which case (A/B) each
// measurement belongs to, since jumping needs to move the right case's crosshair.
function CompareMeasurementPanel({ handle, idA, idB, onClose }: Props) {
	const [items, setItems] = useState<MeasurementSummary[]>(() => handle?.getMeasurementSummaries() ?? []);
	const rootRef = useRef<HTMLDivElement>(null);
	const noteFocus = useKeepFocusInPanel(rootRef, items);

	useEffect(() => {
		// No handle means the pair is loading or failed: the old pair's rows would have dead buttons.
		if (!handle) {
			setItems([]);
			return;
		}
		setItems(handle.getMeasurementSummaries());
		const unsubscribe = handle.subscribeToMeasurementChanges(() => {
			noteFocus();
			setItems(handle.getMeasurementSummaries());
		});
		return unsubscribe;
	}, [handle, noteFocus]);

	const commitLabel = (uid: string, label: string) => {
		handle?.renameMeasurement(uid, label.trim());
		setItems(handle?.getMeasurementSummaries() ?? []);
	};

	const caseLabel = (caseKey: CaseKey) => (caseKey === "a" ? idA : idB);
	const positions = duplicatePositions(
		items.map((m) => measurementRowName(m.tool, m.label, m.value, `Case ${caseLabel(m.caseKey)}`))
	);

	return (
		<div ref={rootRef} className="vp-measure" role="region" aria-label="Measurements">
			<PanelHeader title="Measurements" closeLabel="Close measurements" onClose={onClose}>
				{items.length > 0 && (
					<ClearAllChips
						onClear={() => {
							handle?.clearMeasurements();
							setItems([]);
						}}
					/>
				)}
			</PanelHeader>
			{items.length === 0 ? (
				<div className="vp-panel__empty">
					No measurements yet.
					<span className="vp-panel__hint">Pick a tool from the Measure menu and draw on either case.</span>
				</div>
			) : (
				<div className="vp-measure__list">
					{items.map((m, i) => (
						<MeasurementItem
							key={m.uid}
							tool={m.tool}
							label={m.label}
							value={m.value}
							metaPrefix={`Case ${caseLabel(m.caseKey)}`}
							position={positions[i]}
							canJump={!!m.center}
							onRename={(label) => commitLabel(m.uid, label)}
							onJump={() => handle?.jumpToMeasurement(m.uid, m.caseKey)}
							onDelete={() => handle?.removeMeasurement(m.uid)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

export default CompareMeasurementPanel;
