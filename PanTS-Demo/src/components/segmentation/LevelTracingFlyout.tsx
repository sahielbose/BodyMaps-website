import { useEffect, useRef } from "react";
import NumberSliderField from "../NumberSliderField";
import { MenuColumn, MenuRow, MenuDivider } from "../viewer/FlyoutPrimitives";
import type { LevelTraceOperation } from "../../helpers/CornerstoneNifti2";

interface Props {
	operation: LevelTraceOperation;
	onOperationChange: (op: LevelTraceOperation) => void;
	toleranceHu: number;
	onToleranceChange: (hu: number) => void;
	/** Closes just this settings flyout — level tracing stays equipped
	 *  (it's a live-commit "equip and use" tool, same family as the brush),
	 *  so picking a mode should collapse the settings panel and drop the
	 *  person straight back onto the canvas ready to trace, not deselect
	 *  the tool. */
	onCloseSettings?: () => void;
}

const MODE_OPTIONS: { value: LevelTraceOperation; label: string }[] = [
	{ value: "fillInside", label: "Fill inside" },
	{ value: "fillOutside", label: "Fill outside" },
	{ value: "eraseInside", label: "Erase inside" },
	{ value: "eraseOutside", label: "Erase outside" },
];

const MIN_SENSITIVITY_HU = 5;
// Past ~300 HU the trace is effectively grabbing half the intensity range in
// a typical CT — wide enough to cover "loosest useful setting" without the
// slider wasting resolution on values nobody wants.
const MAX_SENSITIVITY_HU = 300;

// Sensitivity applies to all 4 modes, so it lives once at the top. Below it,
// a plain Google-Docs-style text column (no icons/tooltips needed — the
// labels are already short and self-explanatory) picks which mode is
// active. Picking a mode is a direct action, not "open a grandchild" — the
// settings flyout collapses immediately after, the same way every other
// one-shot Apply does, except level tracing stays equipped so the very
// next click on the canvas traces with the picked mode.
export default function LevelTracingFlyout({ operation, onOperationChange, toleranceHu, onToleranceChange, onCloseSettings }: Props) {
	// Same brief "let the pick read as picked" beat Scissors' operation
	// rows use before their settings flyout collapses — closing instantly
	// made the mode change feel like it happened by accident rather than
	// as a deliberate result of the click. onCloseSettings closes whichever
	// tool's settings are open, so the pending close is dropped when this
	// unmounts (level tracing deselected, or another tool picked within the
	// beat) and a second pick replaces the first rather than stacking.
	const closeTimerRef = useRef<number | null>(null);
	useEffect(() => () => {
		if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
	}, []);
	const pick = (op: LevelTraceOperation) => {
		onOperationChange(op);
		if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			onCloseSettings?.();
		}, 260);
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 200 }}>
			<NumberSliderField
				label="Sensitivity"
				value={toleranceHu}
				onChange={onToleranceChange}
				min={MIN_SENSITIVITY_HU}
				max={MAX_SENSITIVITY_HU}
				step={5}
				unit="HU"
				ariaLabel="Level tracing sensitivity"
				ariaDescription="Higher traces a wider range of intensities around the cursor"
			/>
			<MenuDivider />
			<MenuColumn role="radiogroup" ariaLabel="Trace mode">
				{MODE_OPTIONS.map((o) => (
					<MenuRow
						key={o.value}
						label={o.label}
						open={o.value === operation}
						radio
						onClick={() => pick(o.value)}
					/>
				))}
			</MenuColumn>
		</div>
	);
}