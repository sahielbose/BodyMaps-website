// Powers the guided "click the shape on the first/last slice" flow shared by
// CopyAcrossSlicesFlyout and FillBetweenSlicesFlyout. The user never types a
// pane name or a slice number — they click directly in whichever pane it's
// easiest to see the class in, and this resolves pane + slice index for them
// via pickSliceAnchorAtClientPoint.
import { useEffect, useRef, useState } from "react";
import { pickSliceAnchorAtClientPoint, type CinePane } from "../CornerstoneNifti2";

export type SliceAnchor = { pane: CinePane; sliceIndex: number };
type Step = "first" | "last";
type Phase = "idle" | "picking" | "ready";

// Only a primary-button press on the pane itself is a pick. A right or middle
// press is the context menu or a pan, and a press on a control that sits over
// the canvas (the slice slider, the slice-number chip) is how the reader gets
// to the slice they want. The picker's own lookup can't tell those apart from
// the canvas, so they are filtered here, and by the flyouts' hint listeners.
export function isSliceAnchorControl(target: EventTarget | null): boolean {
	return !!(target as Element | null)?.closest?.('input, button, select, textarea, a, [role="slider"]');
}

// Same slack as commitOnRelease: a press that travels this far is a pan.
const PAN_SLACK_PX = 4;

/**
 * Runs `commit` when the pointer that went down comes back up, but only if it
 * stayed put. Pan stays on the left button while the picker is armed, and a
 * pinch puts two fingers down, so acting on the press would take the start of
 * every pan or pinch as an anchor. A move of 4px or more, another press (a
 * second finger, or a new press after a lost release) or a cancelled pointer
 * drops the pick. Returns a function that drops it too.
 */
export function onSliceAnchorRelease(down: PointerEvent, commit: (up: PointerEvent) => void): () => void {
	const stop = () => {
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("pointerup", onUp, true);
		window.removeEventListener("pointercancel", stop, true);
		window.removeEventListener("pointerdown", onOther, true);
		window.removeEventListener("blur", stop);
	};
	const moved = (e: PointerEvent) =>
		Math.abs(e.clientX - down.clientX) >= PAN_SLACK_PX || Math.abs(e.clientY - down.clientY) >= PAN_SLACK_PX;
	const sameId = (e: PointerEvent) => e.pointerId === undefined || down.pointerId === undefined || e.pointerId === down.pointerId;
	function onMove(e: PointerEvent) {
		if (sameId(e) && moved(e)) stop();
	}
	function onUp(e: PointerEvent) {
		if (!sameId(e)) return;
		stop();
		if (!moved(e)) commit(e);
	}
	// A second finger is a pinch, not a pick.
	function onOther() {
		stop();
	}
	window.addEventListener("pointermove", onMove, true);
	window.addEventListener("pointerup", onUp, true);
	window.addEventListener("pointercancel", stop, true);
	window.addEventListener("pointerdown", onOther, true);
	window.addEventListener("blur", stop);
	return stop;
}

interface Options {
	segmentIndex: number;
	lastRequiresSegment: boolean;
	/** Every rejected click (wrong spot, wrong pane, same slice, etc.) is reported here — never silent. */
	onError: (detail: string) => void;
}

export function useSliceAnchorPicker({ segmentIndex, lastRequiresSegment, onError }: Options) {
	const [step, setStep] = useState<Step>("first");
	const [phase, setPhase] = useState<Phase>("idle");
	const [first, setFirst] = useState<SliceAnchor | null>(null);
	const [last, setLast] = useState<SliceAnchor | null>(null);
	const stepRef = useRef(step);
	stepRef.current = step;
	const firstRef = useRef(first);
	firstRef.current = first;

	// onError is an inline arrow in every caller, so its identity changes on
	// every parent render — including renders caused by the error state this
	// callback itself sets. If it were a dependency of the listener effect
	// below, every error would tear down and re-add the window listener,
	// and any click landing in that gap would be silently dropped. That's
	// what produced "step 2 does nothing, no error at all" — the listener
	// simply wasn't attached at the instant of the click. Route calls
	// through a ref instead so the effect never resubscribes because of it.
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;

	useEffect(() => {
		if (phase !== "picking") return;

		const pick = (clientX: number, clientY: number) => {
			const hit = pickSliceAnchorAtClientPoint(clientX, clientY);
			if (!hit) {
				return;
			}

			const isFirstStep = stepRef.current === "first";
			const needsSegment = isFirstStep || lastRequiresSegment;
			if (needsSegment && hit.segmentAtPoint !== segmentIndex) {
				onErrorRef.current("That spot isn't part of the class you're editing. Click on the class itself.");
				return;
			}

			if (isFirstStep) {
				setFirst({ pane: hit.pane, sliceIndex: hit.sliceIndex });
				setStep("last");
				return; // stay in picking mode for the second click
			}

			// step === "last"
			if (firstRef.current && hit.pane !== firstRef.current.pane) {
				onErrorRef.current(`Click in the same view (${firstRef.current.pane}) as the first slice.`);
				return;
			}
			if (firstRef.current && hit.sliceIndex === firstRef.current.sliceIndex) {
				onErrorRef.current("That's the same slice. Scroll to a different one first.");
				return;
			}
			setLast({ pane: hit.pane, sliceIndex: hit.sliceIndex });
			setPhase("ready");
		};

		let stopPending: (() => void) | null = null;
		const onClick = (e: PointerEvent) => {
			if (e.button > 0) return; // right and middle presses are not picks
			if (e.isPrimary === false) return; // a second finger is a pinch
			const target = e.target as Element | null;
			if (target?.closest?.("[data-guided-overlay]") || isSliceAnchorControl(target)) return;

			// Pan stays on the left button, so the pick is read on release and
			// only if the pointer stayed put: a drag is a pan, not a pick.
			stopPending = onSliceAnchorRelease(e, () => pick(e.clientX, e.clientY));
		};

		window.addEventListener("pointerdown", onClick, true);
		return () => {
			window.removeEventListener("pointerdown", onClick, true);
			stopPending?.();
		};
	}, [phase, segmentIndex, lastRequiresSegment]);

	const startPicking = () => {
		setPhase("picking");
		setStep(first ? "last" : "first");
	};
	const cancelPicking = () => setPhase(first && last ? "ready" : "idle");

	const reset = () => {
		setFirst(null);
		setLast(null);
		setStep("first");
		setPhase("idle");
	};

	// Clears both anchors and goes straight back to picking the first one, in
	// one batch. reset() + startPicking() can't do this: startPicking reads
	// the render-time first/phase, so after reset() it sees stale values.
	const restart = () => {
		setFirst(null);
		setLast(null);
		setStep("first");
		setPhase("picking");
	};

	return {
		phase,
		step,
		first,
		last,
		startPicking,
		cancelPicking,
		reset,
		restart,
	};
}