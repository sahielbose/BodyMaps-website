import { useEffect, useRef, useState } from "react";
import "./SegmentEffectPanel.css"
import NumberSliderField from "../NumberSliderField";
import { applyHollow } from "../../helpers/CornerstoneNifti2";
import type { HollowSurface, MaskFilter } from "../../helpers/CornerstoneNifti2";
import { ActionList, ActionButton, EffectiveSizeNote, MenuDivider } from "../viewer/FlyoutPrimitives";
import { voxelsLog } from "../../helpers/viewer/editLog";

interface Props {
	segmentIndex: number;
	maskFilter: MaskFilter;
	/** Effective per-axis size of a shell of this many mm on the open scan,
	 *  shown under the slider. Omitted when no scan is loaded. */
	getActual?: (thicknessMm: number) => { mm: [number, number, number] } | null;
	onLog?: (detail: string) => void;
	/** Called right after Apply runs — tells the toolbar to close this
	 *  tool's settings and drop its "selected" highlight. */
	onApplied?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while this
	 *  is in flight, instead of this panel owning its own separate spinner. */
	onBusyChange?: (busy: boolean) => void;
}

// Wording for the reading timeline, so each surface gives its own line.
const SURFACE_LOG_LABEL: Record<HollowSurface, string> = {
	inside: "from the inside",
	medial: "through the middle",
	outside: "from the outside",
};

// Thickness is baked into each label so it tracks the slider live, same
// pattern as Margin's `Grow by ${marginMm}mm`.
const HOLLOW_OPTIONS: {
	value: HollowSurface;
	label: (mm: number) => string;
	runningLabel: (mm: number) => string;
	tooltip: string;
}[] = [
	{
		value: "inside",
		label: (mm) => `Hollow from the inside by ${mm.toFixed(1)}mm`,
		runningLabel: (mm) => `Hollowing from the inside ${mm.toFixed(1)}mm…`,
		tooltip: "The current class becomes the outside of the shell: it's hollowed out from within.",
	},
	{
		value: "medial",
		label: (mm) => `Hollow through the middle by ${mm.toFixed(1)}mm`,
		runningLabel: (mm) => `Hollowing through the middle ${mm.toFixed(1)}mm…`,
		tooltip: "The current boundary runs through the middle of the shell: it grows half-in, half-out.",
	},
	{
		value: "outside",
		label: (mm) => `Hollow from the outside by ${mm.toFixed(1)}mm`,
		runningLabel: (mm) => `Hollowing from the outside ${mm.toFixed(1)}mm…`,
		tooltip: "The current class becomes the inside of the shell: it grows outward into a shell around it.",
	},
];

const MIN_THICKNESS_MM = 0.1;
// Most shell use-cases (organ/vessel walls, printable casings) fall well
// under this; capping here keeps the slider precise at realistic sizes.
const MAX_THICKNESS_MM = 20;
const DEFAULT_THICKNESS_MM = 3;

// Same shape as other one-shot flyouts (Margin, Smoothing, Islands): one
// global slider (thickness applies to any surface), then an ActionButton
// per surface. Clicking one applies immediately and deselects via onApplied.
export default function HollowFlyout({ segmentIndex: _segmentIndex, maskFilter, getActual, onLog, onApplied, onBusyChange }: Props) {
	const [thicknessMm, setThicknessMm] = useState(DEFAULT_THICKNESS_MM);
	const [runningSurface, setRunningSurface] = useState<HollowSurface | null>(null);
	// Which surface just finished — held briefly to show its checkmark
	// before onApplied fires and the flyout closes.
	const [successSurface, setSuccessSurface] = useState<HollowSurface | null>(null);
	// Shown inline when the last Hollow changed nothing, so it never reads as done.
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

	const run = (surface: HollowSurface) => {
		if (runningSurface || successSurface) return;
		setRunningSurface(surface);
		setNote(null);
		onBusyChange?.(true);
		// Two frames first, so the spinner paints before the synchronous edit
		// blocks the thread (same trick as ApplyButton).
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				let changed = false;
				let failed = false;
				let empty = false;
				try {
					const r = applyHollow(surface, thicknessMm, 6, maskFilter);
					// A null result means the class has no voxels at all, which
					// is a different cause from a shell too thick for a thin class.
					empty = r === null;
					if (r?.changedVoxels) {
						changed = true;
						onLog?.(`Hollowed the class ${SURFACE_LOG_LABEL[surface]} by ${thicknessMm} mm (${voxelsLog(r.changedVoxels)})`);
					}
				} catch (e) {
					failed = true;
					console.error("Hollow failed", e);
				}
				window.setTimeout(() => {
					setRunningSurface(null);
					if (!changed) {
						// Stay open with a note, instead of a checkmark for an edit that never happened.
						onBusyChange?.(false);
						if (mounted.current) setNote(failed ? "Hollow failed. Try again." : empty ? "Nothing changed. This class is empty." : "Nothing changed. The class may be too thin for this shell thickness.");
						return;
					}
					setSuccessSurface(surface);
					window.setTimeout(() => {
						onBusyChange?.(false);
						if (!mounted.current) return;
						setSuccessSurface(null);
						onApplied?.();
					}, 650);
				}, 750);
			});
		});
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 220 }}>
			<NumberSliderField
				label="Shell thickness"
				value={thicknessMm}
				onChange={(v) => { setThicknessMm(v); setNote(null); }}
				min={MIN_THICKNESS_MM}
				max={MAX_THICKNESS_MM}
				step={0.1}
				unit="mm"
				decimals={1}
				ariaLabel="Shell thickness"
			/>
			<EffectiveSizeNote requestedMm={thicknessMm} actual={getActual?.(thicknessMm) ?? null} />
			{note && (
				<p className="atb-flyout-note atb-flyout-note--error" role="alert">
					{note}
				</p>
			)}
			<MenuDivider />
			<ActionList>
				{HOLLOW_OPTIONS.map((def) => (
					<ActionButton
						key={def.value}
						label={def.label(thicknessMm)}
						runningLabel={def.runningLabel(thicknessMm)}
						busy={runningSurface === def.value}
						success={successSurface === def.value}
						successLabel="Hollowed"
						disabled={!!runningSurface || !!successSurface}
						title={def.tooltip}
						onClick={() => run(def.value)}
					/>
				))}
			</ActionList>
		</div>
	);
}