import { useEffect, useRef, useState } from "react";
import type { useSmartFill } from "../../helpers/viewer/useSmartFill";
import { GuidedStepModal, type GuidedFlowControls } from "./SliceAnchorPickerUI";
import { ActionButton, ActionList } from "../viewer/FlyoutPrimitives";
import "../viewer/FlyoutPrimitives.css";

type SmartFill = ReturnType<typeof useSmartFill>;

type GrowFromSeedsFlyoutProps = Pick<SmartFill, "markMode" | "setMarkMode" | "scope" | "setScope" | "apply" | "clearScribbles"> & {
	hasForegroundMarks?: boolean;
	hasBackgroundMarks?: boolean;
	/** Called right after a fill commits, OR when Exit is pressed mid-flow —
	 *  either way tells the toolbar to close this tool's settings and drop
	 *  its "selected" highlight. */
	onApplied?: () => void;
	/** Closes just the small settings flyout (without deselecting the
	 *  tool) the instant a scope is picked and the guided flow starts. */
	onCloseSettings?: () => void;
	/** Publishes Exit / Start over up to the annotation toolbar so it can
	 *  render them as fixed buttons in its own ribbon for as long as this
	 *  guided flow is running. Called with `null` once it ends. */
	onGuidedControlsChange?: (controls: GuidedFlowControls | null) => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while the
	 *  fill is in flight. */
	onBusyChange?: (busy: boolean) => void;
};

type Step = 1 | 2 | 3;

export default function GrowFromSeedsFlyout({
	setMarkMode, scope: _scope, setScope, apply, clearScribbles,
	hasForegroundMarks, hasBackgroundMarks, onApplied, onCloseSettings, onGuidedControlsChange, onBusyChange,
}: GrowFromSeedsFlyoutProps) {
	const [active, setActive] = useState(false);
	const [step, setStep] = useState<Step>(1);
	const [ackStep1, setAckStep1] = useState(false);
	const [ackStep2, setAckStep2] = useState(false);
	const [applying, setApplying] = useState(false);
	// Confirmation overlay shown once the fill commits.
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	// Shown on the final card when a fill writes nothing, so a refused fill
	// never passes for a success and the marks stay in place.
	const [fillNote, setFillNote] = useState<string | null>(null);

	// Only arms the canvas for marking once the current step's instruction
	// modal has been dismissed, so a click can't register as a seed before
	// "Got it" is pressed. Disarms unconditionally otherwise (flow
	// inactive, fresh scope pick, or a start-over) so no stale mode from a
	// prior step stays live.
	useEffect(() => {
		if (active && step === 1 && ackStep1) setMarkMode("fg");
		else if (active && step === 2 && ackStep2) setMarkMode("bg");
		else setMarkMode(null);
	}, [active, step, ackStep1, ackStep2, setMarkMode]);

	// Switching to another ribbon tool unmounts this flyout without going
	// through Exit, and the marks live in the smart fill hook, so without this
	// the abandoned points would come back (and count) in the next run.
	const clearScribblesRef = useRef(clearScribbles);
	clearScribblesRef.current = clearScribbles;
	const setMarkModeRef = useRef(setMarkMode);
	setMarkModeRef.current = setMarkMode;
	useEffect(() => () => {
		clearScribblesRef.current();
		setMarkModeRef.current(null);
	}, []);

	// Clears marks but stays in the guided flow at step 1, unlike Exit.
	// Marking doesn't resume until step 1's modal is acknowledged again.
	const handleStartOver = () => {
		clearScribbles();
		setFillNote(null);
		setStep(1);
		setAckStep1(false);
		setAckStep2(false);
	};

	// Cancels the flow and fully deselects the tool, from any step.
	const handleExit = () => {
		clearScribbles();
		setFillNote(null);
		setStep(1);
		setAckStep1(false);
		setAckStep2(false);
		setActive(false);
		onApplied?.();
	};

	// The fill waits two frames to start, and must not run (or set state) if
	// the flyout was closed in the meantime.
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const handleFill = async () => {
		setApplying(true);
		onBusyChange?.(true);
		setFillNote(null);
		let filled = 0;
		try {
			// Two frames first, so "Filling..." paints before the synchronous
			// flood fill blocks the thread (same trick as ApplyButton).
			await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
			if (!mounted.current) return;
			filled = await apply();
		} catch (e) {
			console.error("Grow from seeds failed", e);
			setFillNote("Filling failed. Try again.");
			return;
		} finally {
			setApplying(false);
			onBusyChange?.(false);
		}
		if (!filled) {
			setFillNote("Nothing was filled. Add more points inside the region or move the exclusion points, then try again.");
			return;
		}
		clearScribbles();
		setStep(1);
		setAckStep1(false);
		setAckStep2(false);
		// Stays "active" through the confirmation; deselects on "Got it" below.
		setSuccessMessage("Operation completed successfully");
	};

	// Returns from the final card to marking the region, so a refused fill can
	// be fixed by adding inside points (the marks stay, and Continue walks
	// forward to the exclusions again) instead of retrying blind.
	const handleBack = () => {
		setFillNote(null);
		setStep(1);
		setAckStep1(true);
		setAckStep2(false);
	};

	const dismissSuccess = () => {
		setSuccessMessage(null);
		setActive(false);
		onApplied?.();
	};

	// Picking a scope starts the flow immediately — no separate Start button.
	const selectScope = (next: typeof _scope) => {
		setScope(next);
		setFillNote(null);
		setStep(1);
		setAckStep1(false);
		setAckStep2(false);
		setActive(true);
		onCloseSettings?.();
	};

	// Publish Exit / Start over / Continue to the toolbar ribbon while the
	// flow is alive, except during the success confirmation (nothing to
	// cancel or continue past then). Continue is only offered on steps 1
	// and 2, once that step's own blocking modal has been acknowledged —
	// step 3 commits via its modal's own primary button instead.
	useEffect(() => {
		if (!active || successMessage) { onGuidedControlsChange?.(null); return; }
		const continueForStep =
			step === 1 && ackStep1
				? { continueLabel: "Continue →", onContinue: () => setStep(2), continueDisabled: hasForegroundMarks === false, continueHint: hasForegroundMarks === false ? "Mark at least one point first" : undefined }
				: step === 2 && ackStep2
				? { continueLabel: "Continue →", onContinue: () => setStep(3), continueDisabled: hasBackgroundMarks === false, continueHint: hasBackgroundMarks === false ? "Mark at least one point to exclude" : undefined }
				: {};
		onGuidedControlsChange?.({ label: "Grow from seeds", onExit: handleExit, onStartOver: handleStartOver, busy: applying, ...continueForStep });
		return () => onGuidedControlsChange?.(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active, step, applying, successMessage, ackStep1, ackStep2, hasForegroundMarks, hasBackgroundMarks]);

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
			{!active && (
				// Picking a scope is an action, not a persistent mode, so
				// these are ActionButtons rather than plain MenuRows.
				<ActionList>
					<ActionButton label="Grow across current slice" onClick={() => selectScope("slice")} />
					<ActionButton label="Grow across all slices" onClick={() => selectScope("volume")} />
				</ActionList>
			)}

			{active && step === 1 && !ackStep1 && (
				<GuidedStepModal
					title="Mark the region"
					instruction="Click a few points inside the area to grow."
					onPrimary={() => setAckStep1(true)}
					onEscape={() => setAckStep1(true)}
				/>
			)}
			{/* Once step 1/2's modal is acknowledged, Continue is rendered by the
			    toolbar ribbon (via onGuidedControlsChange above) — no floating
			    UI here so the canvas stays fully clear for scribbling. */}

			{active && step === 2 && !ackStep2 && (
				<GuidedStepModal
					title="Mark exclusions"
					instruction="Click a few points outside the area, so the fill knows where to stop."
					primaryLabel="Got it"
					onPrimary={() => setAckStep2(true)}
					onEscape={() => setAckStep2(true)}
				/>
			)}
			{active && step === 3 && (
				<GuidedStepModal
					title="Ready to fill"
					instruction="Fill the region around your marks with this class."
					note={fillNote}
					primaryLabel={applying ? "Filling…" : "Fill region"}
					onPrimary={handleFill}
					secondaryLabel={applying ? undefined : "Back"}
					onSecondary={applying ? undefined : handleBack}
					onEscape={applying ? undefined : handleBack}
					busy={applying}
				/>
			)}
		</>
	);
}