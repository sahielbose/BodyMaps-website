import { useEffect, useRef, useState } from "react";
import NumberSliderField from "../NumberSliderField";
import { ActionButton, ActionList, MenuDivider } from "../viewer/FlyoutPrimitives";
import type { SmoothingMethod } from "../../helpers/CornerstoneNifti2";

interface Props {
	/** Returns the edit's result when the caller has one. A null result or zero
	 *  changed voxels keeps the flyout open with a note; returning nothing
	 *  (undefined) is treated as applied. */
	onApply: (method: SmoothingMethod, kernelMm: number) => { changedVoxels: number } | null | void;
	/** Called right after Apply runs — tells the toolbar to close this
	 *  tool's settings and drop its "selected" highlight. */
	onApplied?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while this
	 *  is in flight, instead of this panel owning its own separate spinner. */
	onBusyChange?: (busy: boolean) => void;
}

const MAX_KERNEL_MM = 3;
const MIN_KERNEL_MM = 0.5;
// Mid-range, so the thumb doesn't start pinned against the far end.
const DEFAULT_KERNEL_MM = 1.5;

// Same column layout as Scissors/Margin/Hollow: a slider, a divider, then
// the action. Smooth is a single ActionButton since it has only one method.
export default function SmoothingFlyout({ onApply, onApplied, onBusyChange }: Props) {
	const [kernelMm, setKernelMm] = useState(DEFAULT_KERNEL_MM);
	const [applying, setApplying] = useState(false);
	// Shows the checkmark beat before onApplied fires, so the confirmation
	// is seen rather than disappearing the instant it appears.
	const [success, setSuccess] = useState(false);
	// Shown inline when the last Smooth changed nothing, so it never reads as done.
	const [note, setNote] = useState<string | null>(null);
	// Same unmount guard as MarginPanel: a stale onApplied would deselect
	// whichever tool was picked during the beat.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const run = () => {
		if (applying || success) return;
		setApplying(true);
		setNote(null);
		onBusyChange?.(true);
		// Two frames first, so the spinner paints before the synchronous edit
		// blocks the thread (same trick as ApplyButton).
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				let failed = false;
				let changed = false;
				try {
					const result = onApply("median", kernelMm);
					changed = result === undefined || !!result?.changedVoxels;
				} catch (err) {
					failed = true;
					console.error("Smoothing failed", err);
				}
				// Keep the button "running" for a beat before the flyout collapses.
				window.setTimeout(() => {
					setApplying(false);
					if (!changed) {
						// Stay open with a note, instead of a checkmark for an edit that never happened.
						onBusyChange?.(false);
						if (mounted.current) setNote(failed ? "Smoothing failed. Try again." : "Nothing changed. The class may be empty or too thin to smooth.");
						return;
					}
					setSuccess(true);
					window.setTimeout(() => {
						onBusyChange?.(false);
						if (!mounted.current) return;
						setSuccess(false);
						onApplied?.();
					}, 650);
				}, 550);
			});
		});
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<NumberSliderField
				label="Kernel size"
				value={kernelMm}
				onChange={(v) => { setKernelMm(v); setNote(null); }}
				min={MIN_KERNEL_MM}
				max={MAX_KERNEL_MM}
				step={0.1}
				unit="mm"
				decimals={1}
				ariaLabel="Smoothing kernel size"
			/>
			{note && (
				<p className="atb-flyout-note atb-flyout-note--error" role="alert">
					{note}
				</p>
			)}
			<MenuDivider />
			<ActionList>
				{/* Label tracks the slider live, same as Margin's Grow/Shrink. */}
				<ActionButton
					label={`Smooth by ${kernelMm.toFixed(1)}mm`}
					runningLabel="Smoothing…"
					busy={applying}
					success={success}
					successLabel="Smoothed"
					disabled={applying || success}
					onClick={run}
				/>
			</ActionList>
		</div>
	);
}