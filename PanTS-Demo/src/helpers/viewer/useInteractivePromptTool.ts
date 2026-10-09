// helpers/viewer/useInteractivePromptTool.ts
//
// Mirrors usePolygonDraw's architecture (pane tracking, world-space storage,
// canvas reprojection) but for the simpler prompt gestures: a single click
// submits immediately in "point" mode; a click-drag defines two corners and
// submits on mouseup in "box" mode.
//
// The tool is equip-and-use, like the brush: it stays armed after a
// successful prompt, and consecutive prompts share one PromptSessionState —
// the backend keeps the nnInteractive session open under that token, so
// every new click REFINES the same object (the model sees all prior prompts
// as context) instead of segmenting from scratch. Disarming the tool,
// switching the target class, or changing case/resolution ends the session;
// the next prompt starts a fresh object.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToWorld,
	worldToCanvasPoint,
	getSegmentationSpacing,
	isWorldPointInSegmentation,
	submitInteractiveSegmentPrompt,
	subscribeToSegmentationEdits,
	releasePromptSession,
	endPromptSession,
	PromptSessionLostError,
	type CinePane,
	type InteractivePromptResult,
	type PromptMarker,
	type PromptSessionState,
} from "../CornerstoneNifti2";
// Avoid importing Point3 from "@cornerstonejs/core/types" directly — Vite's
// import analysis doesn't reliably resolve that subpath for every file (it
// works from CornerstoneNifti2.tsx, which Vite already had in its graph, but
// errored here). A plain 3-tuple is structurally identical to Point3 for
// everything this file does with it.
type Point3 = [number, number, number];

export type PromptMode = "point" | "box";

// Slice-thickness ratio (max spacing / min spacing) at or above which the
// arm-time thick-slice notice shows. 3 splits the measured cases cleanly:
// the 6.4:1 and 9.2:1 scans are where scores collapse and where box prompts
// start overshooting, while at 2.6:1 the tool still behaves normally.
export const THICK_SLICE_RATIO = 3;

// How long a prompt may run before the client gives up on it. The backend
// gives the model up to 300 s per call, and a session's first prompt also
// uploads the volume, so a slow CPU or MPS host can legitimately take a few
// minutes; past this the model server is stuck, not slow. The applying card's
// Cancel button covers anything sooner.
export const PROMPT_TIMEOUT_MS = 6 * 60 * 1000;

// Shown when a model tool is used where the backend has no dataset case to
// load the CT from (an uploaded scan's session view).
export const MODEL_NEEDS_DATASET_CASE =
	"Segmenting with the model works on cases from the dataset. It can't read an uploaded scan yet.";

// A box is two corners, so a box drawn from the margin on one side of the
// scan to the margin on the other has both corners outside while covering the
// scan. Samples the box on a grid (the server clips boxes to the volume).
const BOX_SAMPLES = 9;
function boxTouchesScan(box: [Point3, Point3]): boolean {
	const [a, b] = box;
	const steps = [0, 1, 2].map((axis) => (a[axis] === b[axis] ? 1 : BOX_SAMPLES));
	for (let x = 0; x < steps[0]; x++) {
		for (let y = 0; y < steps[1]; y++) {
			for (let z = 0; z < steps[2]; z++) {
				const at = [x, y, z].map((n, axis) =>
					steps[axis] === 1 ? a[axis] : a[axis] + ((b[axis] - a[axis]) * n) / (steps[axis] - 1),
				) as Point3;
				if (isWorldPointInSegmentation(at)) return true;
			}
		}
	}
	return false;
}

// Shown when a prompt lands wholly outside the CT volume (the pane's black margin).
export const OUTSIDE_SCAN_MESSAGE = "That click is outside the scan. Click on the image.";
const OUTSIDE_SCAN_SHAPE_MESSAGE = "That shape is outside the scan. Draw it on the image.";

interface UseInteractivePromptToolArgs {
	enabled: boolean;
	mode: PromptMode;
	apiBase: string;
	caseId: string | number | null;
	activeSegmentIndex: number | null;
	/** MUST reflect whichever grid the segmentation volume is actually on
	 *  right now — pass through the same hdReady-derived value used to gate
	 *  the Annotate button. Do not guess. */
	res: "low" | "full";
	tolerance?: number;
	onLog?: (detail: string) => void;
	/** Fired while a request is in flight, so the caller can show a spinner /
	 *  disable further clicks — a click mid-request would race the previous
	 *  one's voxel writes. */
	onBusyChange?: (busy: boolean) => void;
}

interface PromptFlight {
	controller: AbortController;
	stopped: "cancel" | "timeout" | null;
}

// A phone has no right button or Alt key: the removal that works there is the
// touch-and-hold, so the first-use hint names the gesture the screen has.
function isTouchInput(): boolean {
	try {
		return !!window.matchMedia?.("(pointer: coarse)")?.matches;
	} catch {
		return false;
	}
}

// Stops the prompt in flight, if any, as a cancel: the request is aborted and
// its answer is never applied.
function stopPromptFlight(flightRef: { current: PromptFlight | null }) {
	const flight = flightRef.current;
	if (!flight || flight.stopped) return;
	flight.stopped = "cancel";
	flight.controller.abort();
}

export function useInteractivePromptTool({
	enabled, mode, apiBase, caseId, activeSegmentIndex, res, tolerance, onLog, onBusyChange,
}: UseInteractivePromptToolArgs) {
	const [dragStartCanvas, setDragStartCanvas] = useState<[number, number] | null>(null);
	const [dragStartWorld, setDragStartWorld] = useState<Point3 | null>(null);
	const [liveBoxCanvas, setLiveBoxCanvas] = useState<[[number, number], [number, number]] | null>(null);
	const paneRef = useRef<CinePane | null>(null);
	const busyRef = useRef(false);
	// Drives the applying/success overlay (mirrors CopyAcrossSlicesFlyout's
	// GuidedStepModal pattern) instead of the tool silently completing with
	// only a session-log line — a click/box submit is a real server round
	// trip (hundreds of ms to a few seconds), so it needs its own feedback,
	// not just whatever "Interactive segment (N vox)" text happens to scroll
	// past in the log panel.
	const [status, setStatus] = useState<"idle" | "applying" | "success" | "error" | "notice">("idle");
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	// Thick-slice heads-up, shown once per case when a prompt tool is armed on
	// a scan whose slices are much thicker than its in-plane pixels. Measured
	// on real 7.5 mm and 5 mm PanTS cases: soft-tissue scores collapse, some
	// structures are unreachable by any prompt, and the failure direction
	// FLIPS by prompt type (a box overshoots on large solid organs there,
	// while points still work) — so the user should hear it before the first
	// click, not deduce it from strange results.
	const thickWarnedCaseRef = useRef<string | number | null>(null);
	useEffect(() => {
		if (!enabled || caseId == null || thickWarnedCaseRef.current === caseId) return;
		const spacing = getSegmentationSpacing();
		if (!spacing) return;
		const ratio = Math.max(...spacing) / Math.max(Math.min(...spacing), 1e-6);
		if (ratio < THICK_SLICE_RATIO) return;
		thickWarnedCaseRef.current = caseId;
		setStatus("notice");
		// No figure in millimetres: the loaded grid may be the low-res copy (every
		// spacing scaled up by make_lowres.py) or, where the server has none, the
		// full scan, and nothing here says which. The ratio holds on both.
		setStatusMessage(
			`This scan has thick slices. Interactive segmentation is less reliable here: boundaries will be rougher, and thin structures may be out of reach entirely. On thick scans a box tends to overshoot on large solid organs, so prefer a single click for those, and keep the box for air-filled structures such as the lungs.`
		);
	// mode is in the deps so a tool switch gives the check another chance if
	// the labelmap had not finished loading at first arm; the ref keeps the
	// notice at once per case regardless.
	}, [enabled, caseId, mode]);

	// One refinement session per armed stretch of the tool. Created lazily on
	// the first submit; torn down whenever the arming context changes (the
	// effect below), so a stale token can never leak across classes or cases.
	// Note `mode` is deliberately NOT in the teardown deps: the point and box
	// tools share this one instance, so switching between them keeps refining
	// the same object.
	const promptSessionRef = useRef<PromptSessionState | null>(null);
	// The request in flight, so the applying card can cancel it.
	const flightRef = useRef<PromptFlight | null>(null);
	// The overwritten labels of a session a cancel or timeout ended. The ref
	// is already null by then, so the next session picks them up from here.
	const endedPriorValuesRef = useRef<Map<number, number> | null>(null);
	// Show the "keep clicking to refine" explainer once per page visit, not
	// on every session — after the first time it's just in the way.
	const refineHintShownRef = useRef(false);
	useEffect(() => {
		// Hand the finished session's lease back before forgetting its token.
		// Dropping the ref alone leaves the backend holding a model-server slot
		// for a class nobody is annotating any more, and the server refuses new
		// sessions rather than evicting, so a run of classes (every vertebra in
		// a scan) would stall on capacity with only idle sessions in the way.
		// A prompt still running belongs to the context that just ended; its
		// answer must not land on the new class or case.
		stopPromptFlight(flightRef);
		const prev = promptSessionRef.current;
		promptSessionRef.current = null;
		endedPriorValuesRef.current = null;
		if (prev) endPromptSession(prev);
		if (prev && caseId != null) releasePromptSession(apiBase, caseId, prev.token);
		// The render that flipped the context still read the old session's
		// markers, and nothing else re-renders when the ref is cleared, so one
		// more render makes the dots go with the session.
		if (prev) bumpMarkersVersion((v) => v + 1);
		// apiBase is intentionally out of the deps: it never changes at runtime,
		// and listing it would release a live session on an unrelated re-render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, activeSegmentIndex, caseId, res]);
	// The effect above only runs when the arming context CHANGES, so leaving
	// the viewer (unmount) or closing the tab mid-session would strand the
	// lease until the backend's idle reaper, 10 minutes later. Release on
	// both. pagehide rather than beforeunload: it also fires when the page
	// goes into the back/forward cache, and releasePromptSession's beacon is
	// built to survive teardown. A page restored from that cache just starts
	// a fresh session on its next prompt, seeded from the labelmap.
	const releaseTargetRef = useRef({ apiBase, caseId });
	useEffect(() => {
		releaseTargetRef.current = { apiBase, caseId };
	}, [apiBase, caseId]);
	useEffect(() => {
		const releaseNow = () => {
			const live = promptSessionRef.current;
			const target = releaseTargetRef.current;
			promptSessionRef.current = null;
			if (live) endPromptSession(live);
			if (live && target.caseId != null) releasePromptSession(target.apiBase, target.caseId, live.token);
		};
		window.addEventListener("pagehide", releaseNow);
		return () => {
			window.removeEventListener("pagehide", releaseNow);
			// Leaving the viewer mid-prompt: stop the request too, or its late
			// answer lands on the next case's labelmap and undo history.
			stopPromptFlight(flightRef);
			releaseNow();
		};
	}, []);
	// The marker overlay reads session.markers, which undo/redo closures
	// mutate from OUTSIDE the React tree (they live in the shared edit
	// history). Those closures repaint the labelmap through the
	// segmentation-modified event — a GPU-texture path that never renders
	// React — so without this bump, an undone prompt's dot lingers on the
	// pane until some unrelated state change happens to re-render.
	const [, bumpMarkersVersion] = useState(0);
	useEffect(() => subscribeToSegmentationEdits(() => bumpMarkersVersion((v) => v + 1)), []);

	const reset = useCallback(() => {
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxCanvas(null);
		paneRef.current = null;
	}, []);

	// Escape mid-drag: drops the half-drawn box (and its preview)
	// without submitting it, and without touching the tool or its session.
	// Returns whether there was a gesture to cancel, so the keyboard handler
	// only lets a second Escape through to disarm the tool.
	const cancelGesture = useCallback(() => {
		if (!paneRef.current) return false;
		reset();
		return true;
	}, [reset]);

	const submit = useCallback(async (
		_pane: CinePane,
		pointWorld: Point3,
		opts: { box?: [Point3, Point3]; include?: boolean } = {},
	) => {
		const include = opts.include ?? true;
		if (busyRef.current) return; // one in-flight request at a time
		if (activeSegmentIndex == null) return;
		if (caseId == null) {
			// The toolbar leaves the model tools out where there is no dataset
			// case, but if one is armed anyway it must say why nothing happens.
			setStatus("error");
			setStatusMessage(MODEL_NEEDS_DATASET_CASE);
			return;
		}
		// A prompt placed in the black margin around the scan has no voxel to
		// work on, and the server would answer with a misleading failure. A box
		// counts as on the scan when any part of it overlaps the scan.
		const onScan = opts.box ? boxTouchesScan(opts.box) : isWorldPointInSegmentation(pointWorld);
		if (!onScan) {
			setStatus("error");
			setStatusMessage(opts.box ? OUTSIDE_SCAN_SHAPE_MESSAGE : OUTSIDE_SCAN_MESSAGE);
			return;
		}
		// No corrective-prompt gate here: whether a right-click has something
		// to carve from (a prior result, or an existing label the seed scan
		// finds) is decided inside submitInteractiveSegmentPrompt, which
		// throws a plain-English message — still before any network round
		// trip — when it doesn't.
		const deadSession = promptSessionRef.current;
		if (deadSession?.dead) {
			// A redo (or a failed server-side undo sync) invalidated the
			// model server's context for this session. Start over — the
			// fresh session's seed scan hands the model the labelmap as it
			// stands, so nothing the user sees is lost. The dead token
			// still holds a model-server lease, and nothing else can reach
			// it once the ref moves on, so hand it back first; otherwise two
			// undo-then-click rounds used up every slot for ten minutes.
			promptSessionRef.current = null;
			endPromptSession(deadSession);
			releasePromptSession(apiBase, caseId, deadSession.token);
		}
		// A replacement session keeps the labels the old one overwrote: the
		// model's object restarts from the seed scan, but a trim must still
		// give those voxels back to their old class, not to background. (The
		// ref is cleared whenever the class, case or resolution changes, so
		// a carried map never crosses to another target.)
		const newSession = (carry?: Map<number, number>): PromptSessionState => ({
			token: crypto.randomUUID(),
			prevProposal: null,
			priorValues: new Map(carry),
			markers: [],
		});
		if (!promptSessionRef.current) {
			promptSessionRef.current = newSession(deadSession?.priorValues ?? endedPriorValuesRef.current ?? undefined);
			endedPriorValuesRef.current = null;
		}
		let session = promptSessionRef.current;
		busyRef.current = true;
		onBusyChange?.(true);
		setStatus("applying");
		setStatusMessage(null);
		const prompt = { pointLps: pointWorld, boxLps: opts.box, tolerance, include };
		// Cancel (the applying card's button, or Escape) and the deadline both
		// abort the request; `stopped` records which, so the catch below can
		// tell them from a real failure.
		const flight: PromptFlight = { controller: new AbortController(), stopped: null };
		flightRef.current = flight;
		const deadline = setTimeout(() => {
			flight.stopped = "timeout";
			flight.controller.abort();
		}, PROMPT_TIMEOUT_MS);
		const signal = flight.controller.signal;
		try {
			let result: InteractivePromptResult;
			try {
				result = await submitInteractiveSegmentPrompt(apiBase, caseId, activeSegmentIndex, prompt, res, session, signal);
			} catch (e) {
				// (A session the arming context already replaced is left to
				// fail: the user has moved on to another class or case.)
				if (!(e instanceof PromptSessionLostError) || promptSessionRef.current !== session) throw e;
				// The server dropped this object (idle for ten minutes, or it
				// restarted). Rather than lose the prompt or the object, run
				// the same prompt once more on a fresh session: its seed scan
				// hands the model the class as it stands, so every earlier
				// click's result is kept as the starting point.
				endPromptSession(session);
				releasePromptSession(apiBase, caseId, session.token);
				session = newSession(session.priorValues);
				promptSessionRef.current = session;
				result = await submitInteractiveSegmentPrompt(apiBase, caseId, activeSegmentIndex, prompt, res, session, signal);
			}
			if (result.sessionActive) {
				session.prevProposal = result.proposal;
			} else {
				// One-shot response (fallback path ran server-side): the mask
				// was merged additively and there is no accumulated object to
				// refine, so don't carry replace semantics into the next click.
				session.prevProposal = null;
				session.priorValues.clear();
			}
			if (result.changed > 0) {
				const parts: string[] = [];
				if (result.added > 0) parts.push(`+${result.added.toLocaleString()}`);
				if (result.removed > 0) parts.push(`-${result.removed.toLocaleString()}`);
				const touched = result.added + result.removed;
				onLog?.(`Interactive segment (${parts.join(" / ")} ${touched === 1 ? "voxel" : "voxels"})`);
				if (result.modelFallback) {
					// The model didn't answer and the backend grew a region by
					// intensity instead. That blob must not pass for the
					// model's work, or the tool gets judged by a fallback the
					// user never asked for.
					setStatus("success");
					setStatusMessage(
						"The segmentation model didn't answer, so this came from a simple intensity fill around your prompt instead. Check the result, and undo it if it spread too far."
					);
				} else if (result.sessionActive && !refineHintShownRef.current) {
					refineHintShownRef.current = true;
					setStatus("success");
					setStatusMessage(
						`The tool stays armed, and each new ${isTouchInput() ? "tap refines this same object: tap adds, touch and hold removes" : "click refines this same object: left-click adds, right-click (or Alt-click) removes"}. Switching classes starts a fresh one.`
					);
				} else {
					// Feedback is the mask itself plus the log line — a modal
					// on every refinement click would break the flow.
					setStatus("idle");
					setStatusMessage(null);
				}
			} else {
				const msg = include
					? "Interactive segment: nothing changed from that prompt. Try a different spot."
					: opts.box
						? "Nothing to remove inside that shape. It didn't change the object."
						: "Nothing to remove there. That click didn't change the object.";
				setStatus("error");
				setStatusMessage(msg);
			}
		} catch (e) {
			if (flight.stopped) {
				// Nothing was applied, but the server may still finish this
				// prompt and add it to the session, so the model's object and
				// the labelmap no longer agree: end the session and hand its
				// lease back. The next prompt re-seeds from the labelmap. (A
				// session no longer in the ref was already released by the
				// class, case or unmount teardown that replaced it.)
				endPromptSession(session);
				if (promptSessionRef.current === session) {
					promptSessionRef.current = null;
					endedPriorValuesRef.current = session.priorValues;
					releasePromptSession(apiBase, caseId, session.token);
				}
				if (flight.stopped === "timeout") {
					const msg = `The model took longer than ${PROMPT_TIMEOUT_MS / 60000} minutes, so the prompt was stopped and nothing was changed. Try again in a moment.`;
					setStatus("error");
					setStatusMessage(msg);
				} else {
					setStatus("idle");
					setStatusMessage(null);
				}
				return;
			}
			// A dropped connection rejects with the browser's own wording
			// ("Failed to fetch", "Load failed"); the errors the client throws
			// itself are already plain sentences.
			if (e instanceof TypeError) console.error("Interactive segmentation request failed", e);
			const msg = e instanceof TypeError
				? "Couldn't reach the segmentation service. Check your connection and try again."
				: e instanceof Error ? e.message : "Interactive segmentation failed.";
			setStatus("error");
			setStatusMessage(msg);
		} finally {
			clearTimeout(deadline);
			if (flightRef.current === flight) flightRef.current = null;
			busyRef.current = false;
			onBusyChange?.(false);
		}
	}, [apiBase, caseId, activeSegmentIndex, res, tolerance, onLog, onBusyChange]);

	// Stops the prompt in flight, if any. The applying card offers it as
	// Cancel (and on Escape): a stalled model server otherwise held that card,
	// which blocks the whole viewer, until the backend's own timeouts ran out.
	const cancelPrompt = useCallback(() => stopPromptFlight(flightRef), []);

	// Ends the session from outside the edit history. A room undo is a server
	// request, so the local history entry that normally resets the session
	// never runs; without this the next click would send the old proposal
	// again and bring the undone object back. The dead-session path in submit
	// releases the lease and re-seeds from the labelmap as it stands.
	const invalidateSession = useCallback(() => {
		const live = promptSessionRef.current;
		if (!live) return;
		live.dead = true;
		live.markers.length = 0;
		bumpMarkersVersion((v) => v + 1);
	}, []);

	const dismissStatus = useCallback(() => {
		setStatus("idle");
		setStatusMessage(null);
	}, []);

	// Where the left button went down in point mode. Pan stays on the left
	// button while this tool is armed, and the browser still fires `click`
	// when a drag is released over the same pane, so without this every pan
	// ended in a prompt at the release point. Same 4px slack as a box drag.
	const clickDownRef = useRef<[number, number] | null>(null);
	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "point") return;
		const down = clickDownRef.current;
		clickDownRef.current = null;
		if (down && (Math.abs(e.clientX - down[0]) >= 4 || Math.abs(e.clientY - down[1]) >= 4)) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return;
		// Alt+click = corrective (remove) — same polarity gesture in every
		// mode, and the keyboard-only sibling of right-click for setups
		// where right-click is spoken for (trackpads, tablet pens).
		void submit(pane, world, { include: !e.altKey });
	};

	// Right-click = corrective prompt at the cursor, in both modes (in box
	// mode it submits a corrective POINT — a click, not a drag). Only
	// intercepts the browser menu while the tool is armed; an unarmed pane
	// keeps its default behavior.
	const handleContextMenu = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled) return;
		e.preventDefault();
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return;
		void submit(pane, world, { include: false });
	};

	// Box mode: mousedown starts the drag, mousemove updates the live preview
	// rectangle, mouseup submits both corners. Mirrors the pointer semantics a
	// user already expects from the scissors' click-drag box operations.
	// Alt held at mousedown makes the whole gesture corrective (remove);
	// polarity is latched at the start so releasing Alt mid-drag doesn't
	// silently flip what the submit will do.
	const dragIncludeRef = useRef(true);
	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (enabled && mode === "point" && e.button === 0) clickDownRef.current = [e.clientX, e.clientY];
		if (!enabled || mode !== "box") return;
		// Left button only — the right button belongs to handleContextMenu's
		// corrective point, and a right-drag would otherwise strand a live
		// preview when the context menu event interrupts it.
		if (e.button !== 0) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return;
		dragIncludeRef.current = !e.altKey;
		paneRef.current = pane;
		setDragStartCanvas(canvasPos);
		setDragStartWorld(world);
		setLiveBoxCanvas([canvasPos, canvasPos]);
	};

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "box" || paneRef.current !== pane || !dragStartCanvas) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		setLiveBoxCanvas([dragStartCanvas, canvasPos]);
	};

	// A drag released outside the pane never reaches the pane's mouseup
	// handler, which used to leave the drag state (and the live preview box)
	// stuck until the next click — which then submitted a box the user never
	// meant to draw. A window-level release just abandons the drag; releases
	// inside the pane are already handled (and reset) before this fires.
	useEffect(() => {
		if (!dragStartCanvas) return;
		const abandon = () => reset();
		window.addEventListener("mouseup", abandon);
		window.addEventListener("blur", abandon);
		return () => {
			window.removeEventListener("mouseup", abandon);
			window.removeEventListener("blur", abandon);
		};
	}, [dragStartCanvas, reset]);

	const handleMouseUp = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "box" || paneRef.current !== pane || !dragStartWorld) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const startWorld = dragStartWorld;
		const include = dragIncludeRef.current;
		const endWorld = canvasPointToWorld(pane, canvasPos);
		reset();
		if (!endWorld) return;
		// A click with ~no drag is treated as a degenerate box — submit as a
		// point at the start position instead of an empty/near-empty box,
		// which the backend's region_grow would otherwise clamp to nothing.
		const dx = Math.abs(canvasPos[0] - (dragStartCanvas?.[0] ?? 0));
		const dy = Math.abs(canvasPos[1] - (dragStartCanvas?.[1] ?? 0));
		if (dx < 4 && dy < 4) {
			void submit(pane, startWorld, { include });
		} else {
			void submit(pane, startWorld, { box: [startWorld, endWorld], include });
		}
	};

	// Canvas-space live box for the overlay, reprojected against the CURRENT
	// camera on every render, same reasoning as usePolygonDraw's toCanvas().
	const pane = paneRef.current;
	const liveBoxDisplay = liveBoxCanvas;
	void worldToCanvasPoint; // referenced for parity with usePolygonDraw's reprojection pattern; box mode doesn't need it since it never stores world corners across a re-render before submit.

	// Landed-prompt markers for the pane overlays. Read straight off the
	// session each render (the array mutates without a state update): every
	// submit round-trip already re-renders via setStatus, and undo/redo ride
	// the segmentation-changed refresh, so the overlay tracks closely enough
	// without duplicating the array into state. Hidden once the session is
	// dead — those prompts no longer back the model's context.
	const session = promptSessionRef.current;
	const promptMarkers: PromptMarker[] = session && !session.dead ? session.markers : [];

	return {
		pane,
		liveBox: liveBoxDisplay,
		promptMarkers,
		status,
		statusMessage,
		dismissStatus,
		cancelPrompt,
		invalidateSession,
		handleClick,
		handleContextMenu,
		handleMouseDown,
		handleMouseMove,
		handleMouseUp,
		cancel: reset,
		cancelGesture,
		reset,
	};
}