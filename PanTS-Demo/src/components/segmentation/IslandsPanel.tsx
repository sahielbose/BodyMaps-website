import { useEffect, useRef, useState } from "react";
import ApplyButton from "../ApplyButton";
import { ActionButton, ActionList, GrandchildRow, MenuColumn, MenuDivider } from "../viewer/FlyoutPrimitives";
import NumberSliderField from "../NumberSliderField";
import { pickSliceAnchorAtClientPoint, type IslandsOperation } from "../../helpers/CornerstoneNifti2";
import { isSliceAnchorControl, onSliceAnchorRelease } from "../../helpers/viewer/useSliceAnchorPicker";
import { GuidedStepModal, PickErrorHint, type GuidedFlowControls } from "../segmentation/SliceAnchorPickerUI";
import "../viewer/FlyoutPrimitives.css";
import { prefersReducedMotion } from "../../helpers/motion";

interface IslandsPanelProps {
	/** Returns the edit's result when the caller has one. A null result or zero
	 *  changed voxels keeps the flyout open with a note; returning nothing
	 *  (undefined) is treated as applied. */
	onApply: (operation: IslandsOperation, minimumSize: number) => { changedVoxels: number } | null | void;
	pickingSelectedIsland: boolean;
	onPickSelectedIsland: () => void;
	/** Forgets whatever voxel was previously picked. Called whenever the operation
	 * changes or the target segment/organ changes, since a pick made for one
	 * doesn't carry any guaranteed meaning for another. */
	onResetPick: () => void;
	hasSelectedIsland: boolean;
	/** A voxel was clicked, but it isn't part of the segment this operation runs on. */
	pickedInvalid: boolean;
	/** Identifies the current target segment/organ — watched only to trigger a reset when it changes. */
	targetKey: number | null;
	/** Called right after an operation commits — tells the toolbar to close
	 *  this tool's settings and drop its "selected" highlight. */
	onApplied?: () => void;
	/** Closes just the small settings flyout (without deselecting the
	 *  Islands tool) the instant a pick-dependent operation starts, so it
	 *  doesn't linger empty behind the full-screen picking overlay. */
	onCloseSettings?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while a
	 *  direct (non-picking) operation is in flight. */
	onBusyChange?: (busy: boolean) => void;
	/** Publishes Exit / Start over for the "keep/remove picked island" flow
	 *  up to the annotation toolbar, exactly like Copy/Fill-across-slices
	 *  and Grow-from-seeds — so all four guided flows share one fixed
	 *  control location in the ribbon instead of each floating its own
	 *  Exit button over the canvas. Publish `null` when not picking. */
	onGuidedControlsChange?: (controls: GuidedFlowControls | null) => void;
}

const MIN_SIZE_VOXELS = 1;
const MAX_SIZE_VOXELS = 20000;

const DIRECT_OPS: { value: IslandsOperation; label: string }[] = [
	{ value: "keepLargest", label: "Keep largest" },
	{ value: "splitToSegments", label: "Split to classes" },
];

const PICK_OPS: { value: IslandsOperation; label: string }[] = [
	{ value: "keepSelected", label: "Keep only picked" },
	{ value: "removeSelected", label: "Remove picked" },
];

const PICK_INSTRUCTION: Record<string, string> = {
	keepSelected: "Click the island to keep. Everything else in this class is removed.",
	removeSelected: "Click the island to remove.",
};

// Shown when an operation ran but left the class exactly as it was, so a
// success check never appears for an edit that never happened.
const NOTHING_CHANGED: Record<string, string> = {
	keepLargest: "Nothing changed. This class may be empty, or it has only one island.",
	splitToSegments: "Nothing changed. This class may be empty, or it has only one island to split.",
	removeSmall: "Nothing changed. This class may be empty, or no island is that small.",
	keepSelected: "Nothing changed. This class may be empty, or that is its only island.",
	removeSelected: "Nothing changed. This class may be empty.",
};
const isNoop = (r: { changedVoxels: number } | null | void) => r !== undefined && !r?.changedVoxels;

const PICK_STEP_LABEL: Record<string, string> = {
	keepSelected: "Keep only picked island",
	removeSelected: "Remove picked island",
};

export default function IslandsPanel({
	onApply,
	pickingSelectedIsland: _pickingSelectedIsland,
	onPickSelectedIsland,
	onResetPick,
	hasSelectedIsland,
	pickedInvalid,
	targetKey,
	onApplied,
	onCloseSettings,
	onBusyChange,
	onGuidedControlsChange,
}: IslandsPanelProps) {
	const [minimumSize, setMinimumSize] = useState(1000);

	// The Apply button's label shows this instead of `minimumSize` directly,
	// so scrubbing the slider doesn't make the number jump around in the
	// button on every pixel of drag — it eases toward the real value over a
	// few frames instead, and only stops chasing once it's essentially
	// there, so it always settles on the exact number.
	const [displayedSize, setDisplayedSize] = useState(minimumSize);
	// The number on screen, mirrored in a ref so the frame loop below can
	// read it and schedule the next frame itself. Scheduling from inside a
	// state updater multiplied the loop, because updaters must be pure and
	// StrictMode runs them twice.
	const displayedSizeRef = useRef(minimumSize);
	useEffect(() => {
		// With reduced motion the label jumps straight to the new value.
		const reduce = prefersReducedMotion();
		let raf = 0;
		const tick = () => {
			const prev = displayedSizeRef.current;
			const delta = minimumSize - prev;
			// Ease by a fixed fraction of the remaining distance each
			// frame — fast when far off, gentle as it converges, and
			// never so slow it feels laggy behind a fast slider drag.
			const next = reduce || Math.abs(delta) < 1 ? minimumSize : prev + delta * 0.25;
			displayedSizeRef.current = next;
			setDisplayedSize(next);
			if (next !== minimumSize) raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [minimumSize]);

	// Which pick-dependent operation is being picked for (keep vs. remove).
	const [pickingFor, setPickingFor] = useState<IslandsOperation | null>(null);

	// Whether the current pick's instruction modal has been dismissed yet.
	// The picker (onPickSelectedIsland) is only armed once acked, so
	// nothing can be picked before "Got it" is pressed.
	const [acked, setAcked] = useState(false);

	// True for the brief window between a valid pick landing and
	// onApplied() firing, so the ribbon doesn't flash back to "waiting for
	// a click" while the tool is mid-deselect.
	const [committing, setCommitting] = useState(false);

	// Position of the most recent click while a pick is live, so an
	// invalid pick's error hint can be pinned right next to it.
	const [errorPos, setErrorPos] = useState<{ x: number; y: number } | null>(null);

	// Confirmation overlay shown once a keep/remove-picked commit lands.
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	// Shown on the same overlay when a keep/remove-picked commit changed nothing.
	const [pickNote, setPickNote] = useState<{ op: IslandsOperation; text: string } | null>(null);
	// Shown inline in the flyout when a direct operation changed nothing.
	const [note, setNote] = useState<string | null>(null);
	// Same, but for Remove small, which lives in its own popover row and so
	// needs its note next to its own button rather than in the flyout column.
	const [smallNote, setSmallNote] = useState<string | null>(null);

	// Which direct (non-picking) operation is running — drives each
	// ActionButton's own spinner, independent of the ribbon's busy dot.
	const [runningOp, setRunningOp] = useState<IslandsOperation | null>(null);
	const [removingSmall, setRemovingSmall] = useState(false);
	// Remove small's own success beat, from the commit until ApplyButton fires
	// onDone, when the other island buttons must stay off.
	const [smallSuccess, setSmallSuccess] = useState(false);
	// Which direct op just finished — held briefly to show its checkmark
	// before onApplied fires and the flyout closes.
	const [successOp, setSuccessOp] = useState<IslandsOperation | null>(null);
	// Same unmount guard as MarginPanel: a stale onApplied would deselect
	// whichever tool was picked during a direct op's beat.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	// Collapsing the Remove small row mid-beat unmounts ApplyButton before it
	// fires onDone, so the beat clears itself rather than leaving the buttons off.
	useEffect(() => {
		if (!smallSuccess) return;
		const t = window.setTimeout(() => setSmallSuccess(false), 1500);
		return () => window.clearTimeout(t);
	}, [smallSuccess]);

	// A pick only makes sense for the operation + target segment it was
	// made for — switching either forces a fresh pick.
	const prevTargetRef = useRef(targetKey);
	useEffect(() => {
		if (prevTargetRef.current !== targetKey) {
			onResetPick();
			setPickingFor(null);
			setAcked(false);
			// A note about the last class would read as true of this one.
			setNote(null);
			setSmallNote(null);
			setPickNote(null);
		}
		prevTargetRef.current = targetKey;
	}, [targetKey, onResetPick]);

	// Once a valid pick lands mid-flow, commit immediately — the click
	// itself is the commit, there's no separate Apply step. Deliberately
	// doesn't call onBusyChange: `committing` is already published as
	// `busy` via onGuidedControlsChange, and calling both would light up
	// two "something is happening" indicators for one commit. Direct
	// (non-picking) ops below have no guided-flow label, so they're the
	// only ones that still use onBusyChange.
	useEffect(() => {
		if (!pickingFor || !acked) return;
		if (hasSelectedIsland) {
			setCommitting(true);
			const r = onApply(pickingFor, minimumSize);
			const noop = isNoop(r);
			const op = pickingFor;
			onResetPick();
			window.setTimeout(() => {
				setPickingFor(null);
				setAcked(false);
				setCommitting(false);
				if (noop) setPickNote({ op, text: NOTHING_CHANGED[op] ?? "Nothing changed." });
				else setSuccessMessage("Operation completed successfully");
			}, 750);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hasSelectedIsland, pickingFor, acked]);

	// Track click position only while genuinely waiting on a pick, to
	// place the inline error hint next to the rejected click.
	const waitingForClick = !!pickingFor && acked && !committing && !hasSelectedIsland;
	useEffect(() => {
		if (!waitingForClick) return;
		let stopPending: (() => void) | null = null;
		const onDown = (e: PointerEvent) => {
			if (e.button > 0) return; // right and middle presses are not picks
			if (e.isPrimary === false) return; // a second finger is a pinch
			// Only a press on a pane can be a (rejected) pick. One on a control
			// over a pane (slice slider, slice chip) or off the panes dismisses
			// any stale hint right away instead of moving it there. A pane press
			// moves the hint on release, with the picker, so a pan drag or a
			// pinch leaves it alone.
			const hit = isSliceAnchorControl(e.target) ? null : pickSliceAnchorAtClientPoint(e.clientX, e.clientY);
			if (!hit) {
				setErrorPos(null);
				setPickRejected(false);
				return;
			}
			stopPending?.();
			stopPending = onSliceAnchorRelease(e, () => setErrorPos({ x: e.clientX, y: e.clientY }));
		};
		window.addEventListener("pointerdown", onDown, true);
		return () => {
			window.removeEventListener("pointerdown", onDown, true);
			stopPending?.();
		};
	}, [waitingForClick]);

	useEffect(() => {
		if (!waitingForClick) setErrorPos(null);
	}, [waitingForClick]);

	// A pick outside the class's own island is rejected, but the picker disarms
	// itself after every click. Arm it again so the next click can land, and
	// keep the hint in local state because re-arming clears the invalid seed.
	const [pickRejected, setPickRejected] = useState(false);
	useEffect(() => {
		if (pickingFor && acked && pickedInvalid) {
			setPickRejected(true);
			onPickSelectedIsland();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pickedInvalid, pickingFor, acked]);
	useEffect(() => {
		if (!waitingForClick) setPickRejected(false);
	}, [waitingForClick]);

	const startPicking = (op: IslandsOperation) => {
		if (runningOp || removingSmall || successOp || smallSuccess) return;
		onResetPick();
		setPickingFor(op);
		setAcked(false);
		setErrorPos(null);
		setNote(null);
		setSmallNote(null);
		// Close the settings flyout so it doesn't linger empty behind the
		// full-screen guided modal.
		onCloseSettings?.();
	};

	const acknowledgeStep = () => {
		setAcked(true);
		onPickSelectedIsland();
	};

	// Cancels the pick and fully deselects the tool. Published to the
	// toolbar's fixed Exit button rather than rendered here.
	const exitPicking = () => {
		onResetPick();
		setPickingFor(null);
		setAcked(false);
		setErrorPos(null);
		onApplied?.();
	};

	// Clears whatever's been picked and drops back into "waiting for a
	// click" — this flow has only one step, so there's no modal to re-show.
	const startOver = () => {
		onResetPick();
		onPickSelectedIsland();
		setErrorPos(null);
		setPickRejected(false);
	};

	const dismissSuccess = () => {
		setSuccessMessage(null);
		onApplied?.();
	};

	// Dismissing the "Nothing changed" card leaves the tool selected and drops
	// back into waiting for a click, so another island can be picked.
	const dismissPickNote = () => {
		const op = pickNote?.op;
		setPickNote(null);
		if (!op) return;
		setPickingFor(op);
		setAcked(true);
		onPickSelectedIsland();
	};

	useEffect(() => {
		if (!pickingFor || successMessage || pickNote) {
			onGuidedControlsChange?.(null);
			return;
		}
		onGuidedControlsChange?.({
			label: PICK_STEP_LABEL[pickingFor] ?? "Pick an island",
			onExit: exitPicking,
			onStartOver: startOver,
			busy: committing,
		});
		return () => onGuidedControlsChange?.(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pickingFor, committing, successMessage, pickNote]);

	const runDirect = (op: IslandsOperation) => {
		if (runningOp || removingSmall || successOp || smallSuccess) return;
		setRunningOp(op);
		setNote(null);
		onBusyChange?.(true);
		// Two frames first, so the spinner paints before the synchronous edit
		// blocks the thread (same trick as ApplyButton).
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				let failed = false;
				let r: ReturnType<typeof onApply>;
				try {
					r = onApply(op, minimumSize);
				} catch (err) {
					failed = true;
					console.error("Islands failed", err);
				}
				window.setTimeout(() => {
					setRunningOp(null);
					if (failed || isNoop(r)) {
						// Stay open with a note, instead of a checkmark for an edit that never happened.
						onBusyChange?.(false);
						if (mounted.current) setNote(failed ? "The islands could not be changed. Try again." : NOTHING_CHANGED[op]);
						return;
					}
					setSuccessOp(op);
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

	// Returns false when nothing changed, so ApplyButton skips its success beat
	// and the flyout stays open.
	const runRemoveSmall = () => {
		if (runningOp || successOp || removingSmall || smallSuccess) return false;
		setRemovingSmall(true);
		setNote(null);
		setSmallNote(null);
		onBusyChange?.(true);
		const r = onApply("removeSmall", minimumSize);
		setRemovingSmall(false);
		if (isNoop(r)) {
			onBusyChange?.(false);
			setSmallNote(NOTHING_CHANGED.removeSmall);
			return false;
		}
		setSmallSuccess(true);
	};

	// Fires once ApplyButton's success checkmark has had its beat on
	// screen — clears the ribbon's busy dot and deselects.
	const finishRemoveSmall = () => {
		setSmallSuccess(false);
		onBusyChange?.(false);
		onApplied?.();
	};

	const DIRECT_LABELS: Record<string, string> = { keepLargest: "Keeping largest…", splitToSegments: "Splitting…" };
	const DIRECT_SUCCESS_LABELS: Record<string, string> = { keepLargest: "Kept largest", splitToSegments: "Split" };
	const PICK_LABELS: Record<string, string> = { keepSelected: "Keep only picked", removeSelected: "Remove picked" };

	if (pickNote) {
		return (
			<GuidedStepModal
				title="Nothing changed"
				instruction="The class was left as it was."
				note={pickNote.text}
				primaryLabel="Got it"
				onPrimary={dismissPickNote}
				onEscape={dismissPickNote}
			/>
		);
	}

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

	return (
		<>
			<MenuColumn>
				{/* Pick-dependent operations start the shared guided-flow modal
				    rather than applying instantly — still one-shot actions
				    (ActionButton), just with the actual edit deferred until a
				    valid island is clicked on the canvas. One list, so every
				    button in the flyout is the same 8px apart. */}
				<ActionList>
					{DIRECT_OPS.map((o) => (
						<ActionButton
							key={o.value}
							label={o.label}
							runningLabel={DIRECT_LABELS[o.value]}
							busy={runningOp === o.value}
							success={successOp === o.value}
							successLabel={DIRECT_SUCCESS_LABELS[o.value]}
							disabled={!!runningOp || removingSmall || smallSuccess || !!successOp}
							onClick={() => runDirect(o.value)}
						/>
					))}
					{PICK_OPS.map((o) => (
						<ActionButton
							key={o.value}
							label={PICK_LABELS[o.value] ?? o.label}
							disabled={!!pickingFor || !!runningOp || removingSmall || smallSuccess || !!successOp}
							onClick={() => startPicking(o.value)}
						/>
					))}
				</ActionList>

				{note && (
					<p className="atb-flyout-note atb-flyout-note--error" role="alert">
						{note}
					</p>
				)}

				<MenuDivider />

				{/* "Remove small" sits last — it needs its own size threshold,
				    so it stays an expandable row (slider + Apply) rather than a
				    single-click action like everything above it. */}
				<GrandchildRow label="Remove small" pill>
					<NumberSliderField
						label="Min size"
						value={minimumSize}
						// A voxel count is a whole number, so a typed 2.5 is rounded. The
						// slider starts at 0 so its 50-voxel grid holds the default 1000
						// (and every round number); the smallest size stays 1.
						onChange={(v) => { setMinimumSize(Math.max(MIN_SIZE_VOXELS, Math.round(v))); setSmallNote(null); }}
						min={0}
						max={MAX_SIZE_VOXELS}
						step={50}
						unit={minimumSize === 1 ? "voxel" : "voxels"}
						ariaLabel="Minimum island size"
					/>
					<MenuDivider />
					{smallNote && (
						<p className="atb-flyout-note atb-flyout-note--error" role="alert">
							{smallNote}
						</p>
					)}
					<ApplyButton
					onApply={runRemoveSmall}
					onDone={finishRemoveSmall}
					disabled={removingSmall || smallSuccess || !!runningOp || !!successOp}
					label={`Remove islands smaller than ${Math.round(displayedSize)} ${Math.round(displayedSize) === 1 ? "voxel" : "voxels"}`}
					applyingLabel="Removing…"
					successLabel="Removed"
				/>
				</GrandchildRow>
			</MenuColumn>

			{/* Same "Got it" instruction modal used by Copy/Fill-across-slices
			    and Grow-from-seeds: blocks every canvas click until dismissed,
			    then gets out of the way and lets a real pick land. Exit /
			    Start over now live as fixed buttons in the toolbar ribbon
			    (via onGuidedControlsChange) instead of floating here. */}
			{pickingFor && !acked && (
				<GuidedStepModal
					title={PICK_STEP_LABEL[pickingFor] ?? "Pick an island"}
					instruction={PICK_INSTRUCTION[pickingFor] ?? "Click the island on the canvas."}
					onPrimary={acknowledgeStep}
					onEscape={acknowledgeStep}
				/>
			)}

			{pickRejected && errorPos && waitingForClick && (
				<PickErrorHint
					message="That voxel isn't part of this class. Click inside the class's own island instead."
					x={errorPos.x}
					y={errorPos.y}
				/>
			)}
		</>
	);
}