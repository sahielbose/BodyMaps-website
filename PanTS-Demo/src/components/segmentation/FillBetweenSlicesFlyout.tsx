import { useEffect, useState } from "react";
import "./SegmentEffectPanel.css"
import { interpolateSegmentBetweenSlices, setPaneSliceIndex } from "../../helpers/CornerstoneNifti2";
import type { MaskFilter, CinePane } from "../../helpers/CornerstoneNifti2";
import { useSliceAnchorPicker } from "../../helpers/viewer/useSliceAnchorPicker";
import { GuidedStepModal, PickErrorHint, formatAnchor, type GuidedFlowControls } from "./SliceAnchorPickerUI";

interface Props {
	pane: CinePane;
	totalSlices: number;
	segmentIndex: number;
	maskFilter: MaskFilter;
	onLog?: (detail: string) => void;
	onApplied?: () => void;
	onCloseSettings?: () => void;
	onGuidedControlsChange?: (controls: GuidedFlowControls | null) => void;
}

export default function FillBetweenSlicesFlyout({ segmentIndex, maskFilter, onLog, onApplied, onCloseSettings, onGuidedControlsChange }: Props) {
	const [pickError, setPickError] = useState<string | null>(null);
	const [errorPos, setErrorPos] = useState<{ x: number; y: number } | null>(null);
	const [ackFirst, setAckFirst] = useState(false);
	const [ackLast, setAckLast] = useState(false);
	const [finishing, setFinishing] = useState(false);
	// Confirmation overlay shown once the fill commits.
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	const picker = useSliceAnchorPicker({
		segmentIndex,
		// Unlike Copy-across-slices (whose destination legitimately doesn't
		// need existing content), Fill needs a real segment on BOTH ends to
		// interpolate between — a blank second slice has nothing to fill
		// toward. Was `false` (copied from CopyAcrossSlicesFlyout without
		// updating for this), which let step 2 accept any slice with no
		// segment check at all.
		lastRequiresSegment: true,
		onError: (d) => { setPickError(d); onLog?.(d); },
	});
	const { phase, step, first, last } = picker;

	// Single source of truth for the ribbon's fixed guided-flow controls
	// (label, Exit/Start over, busy state) — keep this as one effect so a
	// commit's busy=true can't be clobbered by a second, later publish.
	useEffect(() => {
		onGuidedControlsChange?.({ label: "Fill between slices", onExit: exit, onStartOver: startOver, busy: finishing });
		return () => onGuidedControlsChange?.(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase, first, last, finishing]);

	useEffect(() => {
		if (phase === "idle") picker.startPicking();
		onCloseSettings?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const waitingForClick = !finishing && ((step === "first" && ackFirst && !first) || (step === "last" && ackLast && !last));

	useEffect(() => {
		if (!waitingForClick) return;
		const onDown = (e: PointerEvent) => setErrorPos({ x: e.clientX, y: e.clientY });
		window.addEventListener("pointerdown", onDown, true);
		return () => window.removeEventListener("pointerdown", onDown, true);
	}, [waitingForClick]);

	const run = () => {
		if (!first || !last) return;
		setFinishing(true);
		const result = interpolateSegmentBetweenSlices(first.pane, first.sliceIndex, last.sliceIndex, segmentIndex, maskFilter);
		if (result?.changedVoxels) {
			onLog?.(`Filled between slices (${result.slicesWritten} slices, ${result.changedVoxels.toLocaleString()} vox)`);
			setPaneSliceIndex(last.pane, last.sliceIndex);
			picker.reset();
			setAckFirst(false);
			setAckLast(false);
			setSuccessMessage("Operation completed successfully");
		} else {
			onLog?.("Fill failed — draw the shape fully on both slices first.");
			// Nothing committed — stay on the ready step so they can retry.
			setFinishing(false);
		}
	};

	const dismissSuccess = () => {
		setSuccessMessage(null);
		setFinishing(false);
		onApplied?.();
	};

	const exit = () => {
		picker.cancelPicking();
		picker.reset();
		setAckFirst(false);
		setAckLast(false);
		onApplied?.();
	};

	const startOver = () => {
		picker.reset();
		setAckFirst(false);
		setAckLast(false);
		setPickError(null);
		if (picker.phase !== "picking") picker.startPicking();
	};

	if (successMessage) {
		return (
			<GuidedStepModal
				title="Success"
				instruction={successMessage}
				primaryLabel="Got it"
				onPrimary={dismissSuccess}
			/>
		);
	}

	if (finishing) return null;

	return (
		<>
			{step === "first" && !ackFirst && (
				<GuidedStepModal
					title="Fill between slices"
					instruction="Click the FIRST slice with the shape drawn."
					onPrimary={() => setAckFirst(true)}
				/>
			)}
			{step === "last" && first && !ackLast && (
				<GuidedStepModal
					title="Fill between slices"
					instruction="Click the LAST slice with the shape drawn."
					onPrimary={() => setAckLast(true)}
				/>
			)}
			{phase === "ready" && first && last && (
				<GuidedStepModal
					title="Ready to fill"
					instruction={`Interpolating the shape between ${formatAnchor(first)} and ${formatAnchor(last)}.`}
					primaryLabel="Fill between slices"
					onPrimary={run}
				/>
			)}
			{pickError && errorPos && waitingForClick && (
				<PickErrorHint message={pickError} x={errorPos.x} y={errorPos.y} />
			)}
		</>
	);
}