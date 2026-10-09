import { useEffect, useRef, useState } from "react";
import "./SegmentEffectPanel.css"
import { copySegmentAcrossSlices, setPaneSliceIndex, pickSliceAnchorAtClientPoint } from "../../helpers/CornerstoneNifti2";
import type { MaskFilter, CinePane } from "../../helpers/CornerstoneNifti2";
import { isSliceAnchorControl, onSliceAnchorRelease, useSliceAnchorPicker } from "../../helpers/viewer/useSliceAnchorPicker";
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

export default function CopyAcrossSlicesFlyout({ segmentIndex, maskFilter, onLog, onApplied, onCloseSettings, onGuidedControlsChange }: Props) {
	const [pickError, setPickError] = useState<string | null>(null);
	const [errorPos, setErrorPos] = useState<{ x: number; y: number } | null>(null);
	const [ackFirst, setAckFirst] = useState(false);
	const [ackLast, setAckLast] = useState(false);
	// True while a commit is in flight, so the step-1 modal can't briefly
	// re-render between picker.reset() and the success overlay showing.
	const [finishing, setFinishing] = useState(false);
	// Why the last Copy press wrote nothing, shown on the Ready card.
	const [copyError, setCopyError] = useState<string | null>(null);
	// Confirmation overlay shown once the copy commits, instead of the
	// tool silently closing after Apply.
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	const picker = useSliceAnchorPicker({
		segmentIndex,
		lastRequiresSegment: false,
		onError: setPickError,
	});
	const { phase, step, first, last } = picker;

	useEffect(() => {
		setPickError(null);
		setErrorPos(null);
	}, [phase, step, first, last]);

	useEffect(() => {
		if (phase === "idle") picker.startPicking();
		onCloseSettings?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const waitingForClick = !finishing && ((step === "first" && ackFirst && !first) || (step === "last" && ackLast && !last));

	useEffect(() => {
		if (!waitingForClick) return;
		let stopPending: (() => void) | null = null;
		const onDown = (e: PointerEvent) => {
			if (e.button > 0) return; // right and middle presses are not picks
			if (e.isPrimary === false) return; // a second finger is a pinch
			// Only show/reposition the error hint for clicks that land on a
			// pane; a click outside every viewport, or on a control over one
			// (slice slider, slice chip), dismisses any stale hint. Read on
			// release, with the picker, so a pan drag leaves the hint alone.
			stopPending = onSliceAnchorRelease(e, () => {
				const hit = isSliceAnchorControl(e.target) ? null : pickSliceAnchorAtClientPoint(e.clientX, e.clientY);
				if (!hit) {
					setPickError(null);
					setErrorPos(null);
					return;
				}
				setErrorPos({ x: e.clientX, y: e.clientY });
			});
		};
		window.addEventListener("pointerdown", onDown, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			stopPending?.();
		};
	}, [waitingForClick]);

	// The copy waits two frames to start, and must not run (or set state) if
	// the flyout was closed in the meantime.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const run = () => {
		if (!first || !last || finishing) return;
		setCopyError(null);
		setFinishing(true);
		// Two frames first, so the busy state paints before the synchronous
		// edit blocks the thread (same trick as MarginPanel).
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (!mounted.current) return;
				commit(first, last);
			});
		});
	};

	const commit = (from: NonNullable<typeof first>, to: NonNullable<typeof last>) => {
		const result = copySegmentAcrossSlices(from.pane, from.sliceIndex, to.sliceIndex, segmentIndex, maskFilter);
		if (result?.changedVoxels) {
			onLog?.(`Copied across ${result.slicesWritten} ${result.slicesWritten === 1 ? "slice" : "slices"} (${result.changedVoxels.toLocaleString()} ${result.changedVoxels === 1 ? "voxel" : "voxels"})`);
			setPaneSliceIndex(to.pane, to.sliceIndex);
			picker.reset();
			setAckFirst(false);
			setAckLast(false);
			setSuccessMessage("Operation completed successfully");
		} else {
			setCopyError(result === null
				? "Could not read those slices. Make sure the first slice has a shape of this class drawn, then try again."
				: "Nothing was copied. The slices in between already hold this class. Pick other slices or start over, then try again.");
			// Nothing committed — stay on the "ready to copy" step so they
			// can retry without re-picking the range.
			setFinishing(false);
		}
	};

	const dismissSuccess = () => {
		setSuccessMessage(null);
		setFinishing(false);
		onApplied?.();
	};

	const exit = () => {
		setCopyError(null);
		picker.cancelPicking();
		picker.reset();
		setAckFirst(false);
		setAckLast(false);
		onApplied?.();
	};

	const startOver = () => {
		setAckFirst(false);
		setAckLast(false);
		setPickError(null);
		setErrorPos(null);
		setCopyError(null);
		picker.restart();
	};
	useEffect(() => {
		// The Success card is up: the ribbon has nothing to offer, and the
		// busy flag is still set until "Got it" (same as Grow from seeds).
		if (successMessage) {
			onGuidedControlsChange?.(null);
			return;
		}
		onGuidedControlsChange?.({ label: "Copy across slices", onExit: exit, onStartOver: startOver, busy: finishing });
		return () => onGuidedControlsChange?.(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [phase, first, last, finishing, successMessage]);

	if (successMessage) {
		return (
			<GuidedStepModal
				title="Success"
				instruction={successMessage}
				primaryLabel="Got it"
				onPrimary={dismissSuccess}
				onEscape={dismissSuccess}
			/>
		);
	}

	if (finishing) return null;

	return (
		<>
			{step === "first" && !ackFirst && (
				<GuidedStepModal
					title="Copy across slices"
					instruction="Click the shape to copy from."
					onPrimary={() => setAckFirst(true)}
					onEscape={() => setAckFirst(true)}
				/>
			)}
			{step === "last" && first && !ackLast && (
				<GuidedStepModal
					title="Copy across slices"
					instruction="Click the slice to copy up to."
					onPrimary={() => setAckLast(true)}
					onEscape={() => setAckLast(true)}
				/>
			)}
			{phase === "ready" && first && last && (
				<GuidedStepModal
					title="Ready to copy"
					instruction={`Copying the shape from ${formatAnchor(first)} across to ${formatAnchor(last, first)}.`}
					note={copyError}
					primaryLabel="Copy across slices"
					onPrimary={run}
					// The backdrop covers the ribbon, so a run that wrote nothing needs its own way out.
					secondaryLabel="Start over"
					onSecondary={startOver}
					onEscape={startOver}
				/>
			)}
			{pickError && errorPos && waitingForClick && (
				<PickErrorHint message={pickError} x={errorPos.x} y={errorPos.y} />
			)}
		</>
	);
}