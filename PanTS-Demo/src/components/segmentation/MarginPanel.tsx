import { useEffect, useRef, useState } from "react";
import "./SegmentEffectPanel.css";
import NumberSliderField from "../NumberSliderField";
import { ActionButton, ActionList, EffectiveSizeNote, MenuDivider } from "../viewer/FlyoutPrimitives";
import "../viewer/FlyoutPrimitives.css";

export type MarginOperation = "grow" | "shrink";
export type EditableArea = "everywhere" | "insideAllSegments" | "insideVisibleSegments" | "insideSegment" | "outsideAllSegments" | "outsideVisibleSegments";

interface MarginPanelProps {
	/** Returns the edit's result when the caller has one. A null result or zero
	 *  changed voxels keeps the flyout open with a note; returning nothing
	 *  (undefined) is treated as applied. */
	onApply: (operation: MarginOperation, marginMm: number) => { changedVoxels: number } | null | void;
	/** Effective per-axis size of a margin of this many mm on the open scan,
	 *  shown under the slider. Omitted when no scan is loaded. */
	getActual?: (marginMm: number) => { mm: [number, number, number] } | null;
	/** Called right after Apply runs — tells the toolbar to close this
	 *  tool's settings and drop its "selected" highlight, since Margin is a
	 *  one-shot tool rather than an equip-and-use one. */
	onApplied?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while this
	 *  is in flight, instead of this panel owning its own separate spinner. */
	onBusyChange?: (busy: boolean) => void;
}

const MAX_MARGIN_MM = 3;
// A size of 0 would still move the edge by a whole voxel, so the smallest size is one step.
const MIN_MARGIN_MM = 0.1;
const STEP_MM = 0.1;
const DEFAULT_MARGIN_MM = 1.5;

// Same shape as other one-shot flyouts (Hollow, Smoothing, Islands): one
// slider shared by both directions, then Grow/Shrink as ActionButtons that
// apply immediately rather than picking a persistent mode.
export default function MarginPanel({ onApply, getActual, onApplied, onBusyChange }: MarginPanelProps) {
	const [marginMm, setMarginMm] = useState(DEFAULT_MARGIN_MM);
	const [runningOp, setRunningOp] = useState<MarginOperation | null>(null);
	// Which op just finished — held briefly to show its checkmark before
	// onApplied fires and the flyout closes.
	const [successOp, setSuccessOp] = useState<MarginOperation | null>(null);
	// Shown inline when the last Grow/Shrink changed nothing, so it never reads as done.
	const [note, setNote] = useState<string | null>(null);
	// Picking another tool mid-beat unmounts this panel. Its onApplied would
	// then deselect that new tool and close its flyout, so a beat that ends
	// after unmount only releases the busy state (same guard as RefineFlyout).
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const run = (operation: MarginOperation) => {
		if (runningOp || successOp) return;
		setRunningOp(operation);
		setNote(null);
		onBusyChange?.(true);
		// Two frames first, so the spinner paints before the synchronous edit
		// blocks the thread (same trick as ApplyButton).
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				let failed = false;
				let changed = false;
				try {
					const result = onApply(operation, marginMm);
					changed = result === undefined || !!result?.changedVoxels;
				} catch (err) {
					failed = true;
					console.error("Margin failed", err);
				}
				// Brief beat before deselecting so Apply doesn't feel instant.
				window.setTimeout(() => {
					setRunningOp(null);
					if (!changed) {
						// Stay open with a note, instead of a checkmark for an edit that never happened.
						onBusyChange?.(false);
						if (mounted.current) setNote(failed ? "The margin could not be changed. Try again." : "Nothing changed. The class may be empty, or the margin may be too small.");
						return;
					}
					setSuccessOp(operation);
					window.setTimeout(() => {
						onBusyChange?.(false);
						if (!mounted.current) return;
						setSuccessOp(null);
						onApplied?.();
					}, 650);
				}, 750);
			});
		});
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 220 }}>
			<NumberSliderField
				label="Margin size"
				value={marginMm}
				onChange={(v) => { setMarginMm(v); setNote(null); }}
				min={MIN_MARGIN_MM}
				max={MAX_MARGIN_MM}
				step={STEP_MM}
				unit="mm"
				decimals={1}
				ariaLabel="Margin size in millimeters"
			/>

			<EffectiveSizeNote requestedMm={marginMm} actual={getActual?.(marginMm) ?? null} />

			{note && (
				<p className="atb-flyout-note atb-flyout-note--error" role="alert">
					{note}
				</p>
			)}

			<MenuDivider />

			<ActionList>
				{/* Labels track the slider live ("Grow by 1.5mm"); tabular-nums
				    (see .atb-action-btn__label) keeps digits from jittering
				    the button width as the value changes. */}
				<ActionButton
					label={`Grow by ${marginMm.toFixed(1)}mm`}
					runningLabel="Growing…"
					busy={runningOp === "grow"}
					success={successOp === "grow"}
					successLabel="Grown"
					disabled={!!runningOp || !!successOp}
					onClick={() => run("grow")}
				/>
				<ActionButton
					label={`Shrink by ${marginMm.toFixed(1)}mm`}
					runningLabel="Shrinking…"
					busy={runningOp === "shrink"}
					success={successOp === "shrink"}
					successLabel="Shrunk"
					disabled={!!runningOp || !!successOp}
					onClick={() => run("shrink")}
				/>
			</ActionList>
		</div>
	);
}