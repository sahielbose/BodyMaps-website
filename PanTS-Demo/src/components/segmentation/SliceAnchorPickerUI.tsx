// Shared guided-flow UI used by every "click things on the canvas in order"
// tool (Copy across slices, Fill between slices, Grow from seeds).
//
// Each step shows a centered modal naming what to click; its backdrop
// blocks canvas interaction until acknowledged. Once dismissed, an invalid
// click shows a small non-blocking error hint near the cursor instead of
// interrupting the flow. Exit / Start over are published via
// GuidedFlowControls and rendered as fixed buttons in the toolbar ribbon,
// rather than floating over the canvas here.
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { SliceAnchor } from "../../helpers/viewer/useSliceAnchorPicker";
import { useDialogFocus } from "../../hooks/useDialogFocus";

// "the axial view, slice 42": consistent everywhere an anchor is shown, written
// to sit mid-sentence. Pass the first anchor when formatting the second one, so
// the pane isn't repeated ("slice 57"); both picks are always in the same pane.
// eslint-disable-next-line react-refresh/only-export-components
export function formatAnchor(anchor: SliceAnchor, after?: SliceAnchor): string {
	const slice = `slice ${anchor.sliceIndex + 1}`;
	return after && after.pane === anchor.pane ? slice : `the ${anchor.pane} view, ${slice}`;
}

/** Contract a guided-flow tool publishes upward so the annotation toolbar
 *  can render fixed Exit / Start over buttons in its own ribbon for the
 *  duration of the flow, instead of the tool floating its own controls
 *  over the canvas. Publish `null` when the flow isn't running. */
export interface GuidedFlowControls {
	label: string;
	onExit: () => void;
	onStartOver: () => void;
	/** True while the final apply/fill/copy is committing. The toolbar
	 *  hides Start over / Exit while this is true and shows a loading
	 *  indicator instead, since there's nothing left to cancel or start
	 *  over from at that point. */
	busy?: boolean;
	/** Optional "move to next step" action, rendered as a highlighted
	 *  (blue, pulsing) button in the ribbon right alongside Start over /
	 *  Exit — used by multi-click-scribble steps (currently only
	 *  Grow-from-seeds) where the canvas has to stay interactive, so
	 *  there's no blocking modal to host a primary action. Omit to render
	 *  the ribbon without a Continue button (e.g. while a step's own
	 *  blocking modal is up, or on the final step). */
	continueLabel?: string;
	onContinue?: () => void;
	continueDisabled?: boolean;
	/** Message shown as a brief orange warning if Continue is pressed while
	 *  blocked (e.g. "Mark at least one point first") — not shown merely
	 *  for being disabled, only on an actual press. */
	continueHint?: string;
}

// How many step cards are mounted right now. The toolbar's one-time
// "guided controls" explainer waits on this, so first entry to a flow shows
// one "Got it" at a time instead of two stacked dialogs.
let stepModalCount = 0;
const stepModalListeners = new Set<() => void>();
const notifyStepModals = () => stepModalListeners.forEach((l) => l());
const subscribeStepModals = (l: () => void) => {
	stepModalListeners.add(l);
	return () => { stepModalListeners.delete(l); };
};

/** True while any GuidedStepModal is on screen. */
// eslint-disable-next-line react-refresh/only-export-components
export function useGuidedStepModalOpen(): boolean {
	return useSyncExternalStore(subscribeStepModals, () => stepModalCount > 0, () => false);
}

// Duration of the backdrop fade / card scale-in, played each time a new
// step's modal mounts (see the `entered` state below).
const ENTER_ANIM_MS = 180;

/** The centered, blurred-backdrop instruction card. One of these is shown
 *  per step; its button either acknowledges ("Got it") or commits (the
 *  final step's primary action, e.g. "Copy across slices" / "Fill
 *  region"). The full-viewport backdrop has pointer-events enabled, so it
 *  blocks every canvas click until the button is pressed. */
export function GuidedStepModal({
	title, instruction, note, primaryLabel = "Got it", onPrimary, secondaryLabel, onSecondary, onEscape, busy, initialFocus = "primary",
}: {
	title: string;
	instruction: string;
	/** Optional alert under the instruction, e.g. why the last press changed nothing. */
	note?: string | null;
	primaryLabel?: string;
	onPrimary: () => void;
	/** Optional second, quieter action next to the primary — e.g. "Skip"
	 *  on Grow-from-seeds' optional exclusions step. */
	secondaryLabel?: string;
	onSecondary?: () => void;
	/** What Escape does. Acknowledgements dismiss and confirmations cancel;
	 *  leave it out where the primary commits an edit, so Escape never does. */
	onEscape?: () => void;
	/** Progress card: the primary is disabled and the card is a status notice.
	 *  A secondary action (Cancel) stays live, and with onEscape so does
	 *  Escape, so a slow step can still be stopped. */
	busy?: boolean;
	/** Which button takes keyboard focus when the card opens. Defaults to the
	 *  primary; an irreversible confirmation passes "secondary" so a stray
	 *  Enter or Space lands on Cancel, not on the destructive action. */
	initialFocus?: "primary" | "secondary";
}) {
	// Mount hidden, then fade/scale in on the next frame (see ENTER_ANIM_MS).
	const [entered, setEntered] = useState(false);
	useEffect(() => {
		const raf = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(raf);
	}, []);
	useEffect(() => {
		stepModalCount += 1;
		notifyStepModals();
		return () => {
			stepModalCount -= 1;
			notifyStepModals();
		};
	}, []);
	const cardRef = useRef<HTMLDivElement>(null);
	const primaryRef = useRef<HTMLButtonElement>(null);
	const secondaryRef = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	const instructionId = useId();
	// A busy card ("Applying") is a progress notice with nothing to press, so
	// it only becomes a dialog (focus on the primary, Tab kept inside, Escape
	// handled) once its button is live. A busy card the caller lets people
	// stop takes Escape and puts focus on its Cancel, without trapping Tab.
	const stoppableWhileBusy = !!busy && !!onEscape;
	useDialogFocus(!busy || stoppableWhileBusy, cardRef, {
		initialFocus: busy || initialFocus === "secondary" ? secondaryRef : primaryRef,
		onEscape,
		lockScroll: false,
		trapFocus: !busy,
	});

	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			// Marks this backdrop as UI chrome rather than a canvas click;
			// useSliceAnchorPicker's pointerdown listener ignores anything
			// inside an element with this attribute (via closest()).
			data-guided-overlay="true"
			style={{
				position: "fixed",
				inset: 0,
				zIndex: 1200,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: 24,
				background: "rgba(6, 7, 9, 0.55)",
				backdropFilter: "blur(6px)",
				WebkitBackdropFilter: "blur(6px)",
				pointerEvents: "auto",
				opacity: entered ? 1 : 0,
				transition: `opacity ${ENTER_ANIM_MS}ms ease-out`,
			}}
		>
			<div
				ref={cardRef}
				data-guided-overlay="true"
				role={busy ? "status" : "dialog"}
				aria-modal={busy ? undefined : true}
				aria-labelledby={titleId}
				aria-describedby={instructionId}
				style={{
					width: 380,
					maxWidth: "100%",
					padding: "22px 24px",
					borderRadius: 14,
					background: "#1a1b1f",
					border: "1px solid rgba(255,255,255,0.10)",
					boxShadow: "0 24px 60px rgba(0,0,0,0.55)",
					color: "#fff",
					fontFamily: "\"Space Grotesk\", system-ui, sans-serif",
					display: "flex",
					flexDirection: "column",
					gap: 12,
					textAlign: "center",
					opacity: entered ? 1 : 0,
					transform: entered ? "scale(1) translateY(0)" : "scale(0.96) translateY(6px)",
					transition: `opacity ${ENTER_ANIM_MS}ms ease-out, transform ${ENTER_ANIM_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1)`,
				}}
			>
				<div id={titleId} style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.01em" }}>{title}</div>
				<div id={instructionId} style={{ fontSize: 13, color: "rgba(255,255,255,0.68)", lineHeight: 1.5 }}>{instruction}</div>
				{note && (
					<div role="alert" style={{ fontSize: 12.5, color: "rgba(255,255,255,0.92)", lineHeight: 1.45 }}>{note}</div>
				)}

				<div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 4 }}>
					<button
						ref={primaryRef}
						type="button"
						onClick={onPrimary}
						disabled={busy}
						style={{
							padding: "11px 16px",
							borderRadius: 9,
							border: "1px solid #002d72",
							background: "#002d72",
							color: "#ffffff",
							fontWeight: 700,
							fontSize: 13.5,
							cursor: busy ? "default" : "pointer",
							opacity: busy ? 0.65 : 1,
							transition: "background 0.12s, opacity 0.12s",
						}}
					>
						{primaryLabel}
					</button>
					{secondaryLabel && onSecondary && (
						<button
							ref={secondaryRef}
							type="button"
							onClick={onSecondary}
							style={{
								padding: "8px 12px",
								borderRadius: 9,
								border: "1px solid rgba(255,255,255,0.14)",
								background: "transparent",
								color: "rgba(255,255,255,0.65)",
								fontWeight: 600,
								fontSize: 12.5,
								cursor: "pointer",
							}}
						>
							{secondaryLabel}
						</button>
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}

/** Small error card pinned right next to the cursor's last click position
 *  — used when a click lands somewhere invalid while a step's backdrop is
 *  down and the canvas is live. Deliberately NOT a modal: it shouldn't
 *  block the next attempt. */
export function PickErrorHint({ message, x, y }: { message: string; x: number; y: number }) {
	if (typeof document === "undefined") return null;
	// Clamp so the hint never renders off the right/bottom edge when the
	// click happens near a corner of the viewport.
	const left = Math.min(x + 18, (typeof window !== "undefined" ? window.innerWidth : 1024) - 260);
	const top = Math.min(y + 18, (typeof window !== "undefined" ? window.innerHeight : 768) - 90);
	return createPortal(
		<div
			role="alert"
			data-guided-overlay="true"
			style={{
				position: "fixed",
				left: Math.max(12, left),
				top: Math.max(12, top),
				zIndex: 1300,
				pointerEvents: "none",
				maxWidth: 240,
				padding: "8px 12px",
				borderRadius: 10,
				background: "#002d72",
				border: "1px solid rgba(255, 255, 255, 0.25)",
				color: "#ffffff",
				fontSize: 12.5,
				fontWeight: 600,
				lineHeight: 1.35,
				fontFamily: "\"Space Grotesk\", system-ui, sans-serif",
				boxShadow: "0 12px 30px rgba(0,0,0,0.45)",
				animation: "seg-effect-error-in 0.12s ease-out",
			}}
		>
			{message}
		</div>,
		document.body
	);
}

/** Small non-blocking pill, pinned bottom-center, used only by
 *  Grow-from-seeds between its instruction modals — that tool's steps are
 *  multi-click scribbling (not a single pick), so the canvas has to stay
 *  interactive while the person marks points; this is how they signal
 *  "done marking, move on" without a full blurred modal getting in the
 *  way of the scribbling itself. */
export function GuidedContinuePill({
	label, onClick, disabled, hint,
}: {
	label: string;
	onClick: () => void;
	disabled?: boolean;
	hint?: string;
}) {
	const [entered, setEntered] = useState(false);
	useEffect(() => {
		const raf = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(raf);
	}, []);

	if (typeof document === "undefined") return null;
	return createPortal(
		<div
			data-guided-overlay="true"
			style={{
				position: "fixed",
				bottom: 28,
				left: "50%",
				transform: entered ? "translateX(-50%) translateY(0)" : "translateX(-50%) translateY(8px)",
				opacity: entered ? 1 : 0,
				transition: `opacity ${ENTER_ANIM_MS}ms ease-out, transform ${ENTER_ANIM_MS}ms cubic-bezier(0.2, 0.8, 0.3, 1)`,
				zIndex: 1100,
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				gap: 6,
				pointerEvents: "none",
			}}
		>
			{hint && (
				<div
					style={{
						pointerEvents: "none",
						fontSize: 12,
						fontWeight: 600,
						color: "rgba(255,255,255,0.65)",
						background: "rgba(20,20,24,0.9)",
						border: "1px solid rgba(255,255,255,0.1)",
						borderRadius: 999,
						padding: "5px 12px",
					}}
				>
					{hint}
				</div>
			)}
			<button
				type="button"
				onClick={onClick}
				disabled={disabled}
				style={{
					pointerEvents: "auto",
					padding: "11px 22px",
					borderRadius: 999,
					border: "1px solid #002d72",
					background: disabled ? "rgba(0, 45, 114, 0.4)" : "#002d72",
					color: "#ffffff",
					fontWeight: 700,
					fontSize: 13.5,
					cursor: disabled ? "default" : "pointer",
					boxShadow: "0 14px 34px rgba(0,0,0,0.45)",
					fontFamily: "\"Space Grotesk\", system-ui, sans-serif",
					transition: "background 0.12s",
				}}
			>
				{label}
			</button>
		</div>,
		document.body
	);
}