// helpers/viewer/useInteractivePromptTool.ts
//
// Mirrors usePolygonDraw's architecture (pane tracking, world-space storage,
// canvas reprojection) but for the simpler prompt gestures: a single click
// submits immediately in "point" mode; a click-drag defines two corners and
// submits on mouseup in "box" mode; a freehand drag collects a polyline and
// submits it on mouseup in "scribble" mode (open stroke over the structure)
// and "lasso" mode (closed contour around it, filled server-side).
//
// The tool is equip-and-use, like the brush: it stays armed after a
// successful prompt, and consecutive prompts share one PromptSessionState —
// the backend keeps the nnInteractive session open under that token, so
// every new click REFINES the same object (the model sees all prior prompts
// as context) instead of segmenting from scratch. Disarming the tool,
// switching the target class, or changing case/resolution ends the session;
// the next prompt starts a fresh object.
import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
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
import { interactiveAttribution, primeInteractiveLicense } from "./interactiveAttribution";
// Avoid importing Point3 from "@cornerstonejs/core/types" directly — Vite's
// import analysis doesn't reliably resolve that subpath for every file (it
// works from CornerstoneNifti2.tsx, which Vite already had in its graph, but
// errored here). A plain 3-tuple is structurally identical to Point3 for
// everything this file does with it.
type Point3 = [number, number, number];

export type PromptMode = "point" | "box" | "scribble" | "lasso";

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
	// Stroke gesture (scribble): points accumulate in refs — the source of
	// truth mousemove appends to — with a state mirror for the overlay, so
	// rapid mousemoves can't lose points to a stale-closure state read.
	const strokeCanvasRef = useRef<[number, number][]>([]);
	const strokeWorldRef = useRef<Point3[]>([]);
	const [liveStrokeCanvas, setLiveStrokeCanvas] = useState<[number, number][] | null>(null);
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
			`This scan has thick slices. Interactive segmentation is less reliable here: boundaries will be rougher, and thin structures may be out of reach entirely. On thick scans a box tends to overshoot on large solid organs, so prefer a single click for those, and keep the box and lasso for air-filled structures such as the lungs.`
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
	// The hint modal's attribution line reads the licence the running model
	// server reports; start that fetch before the first result needs it.
	useEffect(() => primeInteractiveLicense(apiBase), [apiBase]);

	// The marker overlay reads session.markers, which undo/redo closures
	// mutate from OUTSIDE the React tree (they live in the shared edit
	// history). Those closures repaint the labelmap through the
	// segmentation-modified event — a GPU-texture path that never renders
	// React — so without this bump, an undone prompt's dot lingers on the
	// pane until some unrelated state change happens to re-render.
	const [, bumpMarkersVersion] = useState(0);
	useEffect(() => subscribeToSegmentationEdits(() => bumpMarkersVersion((v) => v + 1)), []);

	// The touch or pen pointer that owns the drag in progress; a second finger
	// is ignored until it lifts.
	const activePointerRef = useRef<number | null>(null);
	const reset = useCallback(() => {
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxCanvas(null);
		strokeCanvasRef.current = [];
		strokeWorldRef.current = [];
		setLiveStrokeCanvas(null);
		paneRef.current = null;
		activePointerRef.current = null;
	}, []);

	// Escape mid-drag: drops the half-drawn box or stroke (and its preview)
	// without submitting it, and without touching the tool or its session.
	// Returns whether there was a gesture to cancel, so the keyboard handler
	// only lets a second Escape through to disarm the tool.
	const cancelGesture = useCallback(() => {
		if (!paneRef.current) return false;
		reset();
		return true;
	}, [reset]);

	const submit = useCallback(async (
		pane: CinePane,
		pointWorld: Point3,
		opts: { box?: [Point3, Point3]; scribble?: Point3[]; lasso?: Point3[]; include?: boolean } = {},
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
		// work on, and the server would answer with a misleading failure. A
		// shape counts as on the scan when any of its points is, and a box when
		// any part of it overlaps the scan.
		const onScan = opts.box
			? boxTouchesScan(opts.box)
			: (opts.scribble ?? opts.lasso ?? [pointWorld]).some((p) => isWorldPointInSegmentation(p));
		if (!onScan) {
			setStatus("error");
			setStatusMessage(opts.box || opts.scribble || opts.lasso ? OUTSIDE_SCAN_SHAPE_MESSAGE : OUTSIDE_SCAN_MESSAGE);
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
		// The pane the stroke was drawn on tells the server which volume axis is
		// the slice axis; a perfectly straight stroke cannot reveal it itself.
		const plane = opts.scribble || opts.lasso ? pane : undefined;
		const prompt = { pointLps: pointWorld, boxLps: opts.box, scribbleLps: opts.scribble, lassoLps: opts.lasso, plane, tolerance, include };
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
				} else if (result.degenerate) {
					// The request succeeded but the model landed almost no
					// voxels (a point on a lung returns single digits out of
					// 1.5M). Logging "+8 voxels" as success while nothing visible
					// appears reads as a broken tool, so say what actually
					// happened and steer to the prompt types that work there.
					setStatus("success");
					const landed = `${result.added.toLocaleString()} ${result.added === 1 ? "voxel" : "voxels"}`;
					// A box, lasso or scribble got here too, and telling that
					// reader to draw a box or lasso (or naming a click they
					// never made) would be circular.
					const pointShaped = !opts.box && !opts.scribble && !opts.lasso;
					setStatusMessage(
						pointShaped
							? `The model found almost nothing at that click (${landed}). Point prompts work poorly on large or air-filled structures such as the lungs or colon. Draw a box or lasso around the target instead, or keep clicking if the target really is that small.`
							: `The model found almost nothing inside that shape (${landed}). Try a box that sits snugly on the structure, a different slice, or a single click in its centre.`
					);
				} else if (result.sessionActive && !refineHintShownRef.current) {
					refineHintShownRef.current = true;
					setStatus("success");
					setStatusMessage(
						`The tool stays armed, and each new ${isTouchInput() ? "tap refines this same object: tap adds, touch and hold removes" : "click refines this same object: left-click adds, right-click (or Alt-click) removes"}. Switching classes starts a fresh one. ${interactiveAttribution()}`
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
					: opts.box || opts.scribble || opts.lasso
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
		// A finger held still fires this mid-drag (Android long-press). Once the
		// finger has moved it is a real drag: leave it alone so the lift still
		// submits the box or stroke instead of finding the session busy with a
		// stray corrective point. A finger that has not moved is the long-press
		// corrective gesture; it ends the drag so the lift submits nothing more.
		// "Moved" is the lift's own test, so a drag the lift would still turn
		// into a point (finger jitter) is a long-press, not a box or stroke.
		if (activePointerRef.current !== null) {
			const box = liveBoxCanvas;
			const pts = strokeCanvasRef.current;
			let pathLen = 0;
			for (let i = 1; i < pts.length; i++) pathLen += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
			const moved = box
				? Math.abs(box[1][0] - box[0][0]) >= 4 || Math.abs(box[1][1] - box[0][1]) >= 4
				: pts.length >= (mode === "lasso" ? 3 : 2) && pathLen >= 8;
			if (moved) return;
			reset();
		}
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return;
		void submit(pane, world, { include: false });
	};

	// Drag modes (box and scribble): mousedown starts the gesture, mousemove
	// updates the live preview (rectangle or polyline), mouseup submits. Box
	// mirrors the pointer semantics a user already expects from the scissors'
	// click-drag operations; scribble collects the freehand path itself.
	// Alt held at mousedown makes the whole gesture corrective (remove);
	// polarity is latched at the start so releasing Alt mid-drag doesn't
	// silently flip what the submit will do.
	const dragIncludeRef = useRef(true);
	const isStrokeMode = mode === "scribble" || mode === "lasso";
	// A finger or pen fires pointer events and no mousemove, so the drag
	// gestures also run off these (see handlePointerDown). When the browser
	// then emulates a mousedown for a tap, it must not start a second gesture;
	// only the mouse path checks this, so a real touch can follow straight on.
	const lastTouchAtRef = useRef(0);
	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (enabled && mode === "point" && e.button === 0) clickDownRef.current = [e.clientX, e.clientY];
		if (!enabled || (mode !== "box" && !isStrokeMode)) return;
		if (Date.now() - lastTouchAtRef.current < 1000) return;
		startDrag(pane, e);
	};
	// Returns whether a gesture started.
	const startDrag = (pane: CinePane, e: MouseEvent): boolean => {
		// Left button only — the right button belongs to handleContextMenu's
		// corrective point, and a right-drag would otherwise strand a live
		// preview when the context menu event interrupts it.
		if (e.button !== 0) return false;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const world = canvasPointToWorld(pane, canvasPos);
		if (!world) return false;
		dragIncludeRef.current = !e.altKey;
		paneRef.current = pane;
		setDragStartCanvas(canvasPos);
		setDragStartWorld(world);
		if (mode === "box") {
			setLiveBoxCanvas([canvasPos, canvasPos]);
		} else {
			strokeCanvasRef.current = [canvasPos];
			strokeWorldRef.current = [world];
			setLiveStrokeCanvas([canvasPos]);
		}
		return true;
	};

	const handleMouseMove = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || paneRef.current !== pane || !dragStartCanvas) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		if (mode === "box") {
			setLiveBoxCanvas([dragStartCanvas, canvasPos]);
		} else if (isStrokeMode) {
			const pts = strokeCanvasRef.current;
			const last = pts[pts.length - 1];
			// ≥2px spacing keeps the point count proportional to path length,
			// not event rate — a slow careful stroke stays a few hundred
			// points instead of thousands.
			if (!last || Math.hypot(canvasPos[0] - last[0], canvasPos[1] - last[1]) >= 2) {
				const world = canvasPointToWorld(pane, canvasPos);
				if (!world) return;
				pts.push(canvasPos);
				strokeWorldRef.current.push(world);
				setLiveStrokeCanvas([...pts]);
			}
		}
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
		// The browser took a touch drag for its own (a system gesture, an
		// incoming call): pointercancel bubbles here from the captured pane.
		window.addEventListener("pointercancel", abandon);
		window.addEventListener("blur", abandon);
		return () => {
			window.removeEventListener("mouseup", abandon);
			window.removeEventListener("pointercancel", abandon);
			window.removeEventListener("blur", abandon);
		};
	}, [dragStartCanvas, reset]);

	const handleMouseUp = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || (mode !== "box" && !isStrokeMode) || paneRef.current !== pane || !dragStartWorld) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const canvasPos: [number, number] = [e.clientX - rect.left, e.clientY - rect.top];
		const startWorld = dragStartWorld;
		const include = dragIncludeRef.current;

		if (isStrokeMode) {
			const worldPts = strokeWorldRef.current;
			const canvasPts = strokeCanvasRef.current;
			reset();
			// Path length, not displacement: a stroke that curls back to its
			// start is a real scribble/lasso, while a jitter-only "click" isn't.
			let pathLen = 0;
			for (let i = 1; i < canvasPts.length; i++) {
				pathLen += Math.hypot(canvasPts[i][0] - canvasPts[i - 1][0], canvasPts[i][1] - canvasPts[i - 1][1]);
			}
			const minPts = mode === "lasso" ? 3 : 2;
			if (worldPts.length < minPts || pathLen < 8) {
				// Degenerate stroke -> point prompt, same polarity, mirroring
				// the degenerate-box behavior below.
				void submit(pane, startWorld, { include });
			} else if (mode === "lasso") {
				// No need to repeat the first point — the rasterizer closes
				// the polygon itself.
				void submit(pane, worldPts[0], { lasso: worldPts, include });
			} else {
				void submit(pane, worldPts[0], { scribble: worldPts, include });
			}
			return;
		}

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

	// Touch and pen drive the same drag gestures through pointer events: a
	// finger drag fires pointer events and no mousemove, and Cornerstone's
	// ghost-click filter swallows the mouse events a tap emulates. Mouse
	// pointers are left to the mouse handlers above, so nothing runs twice.
	// The pane captures the pointer so a drag that leaves it still ends here.
	// One pointer at a time: a second finger during a drag must not restart the
	// box or feed the stroke.
	const handlePointerDown = (pane: CinePane) => (e: PointerEvent) => {
		if (e.pointerType === "mouse" || !enabled || (mode !== "box" && !isStrokeMode)) return;
		if (!e.isPrimary || activePointerRef.current !== null) return;
		try {
			(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		} catch {
			// The pointer is already gone; the drag still runs without capture.
		}
		if (startDrag(pane, e)) activePointerRef.current = e.pointerId;
	};
	const handlePointerMove = (pane: CinePane) => (e: PointerEvent) => {
		if (e.pointerType === "mouse" || e.pointerId !== activePointerRef.current) return;
		handleMouseMove(pane)(e);
	};
	const handlePointerUp = (pane: CinePane) => (e: PointerEvent) => {
		if (e.pointerType === "mouse") return;
		if (e.pointerId !== activePointerRef.current) return;
		activePointerRef.current = null;
		lastTouchAtRef.current = Date.now();
		handleMouseUp(pane)(e);
	};

	// Whether a drag tool is armed, so the panes stop the browser scrolling or
	// zooming the page under the finger (touch-action: none, set in the CSS).
	const dragArmed = enabled && (mode === "box" || isStrokeMode);

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
		liveStroke: liveStrokeCanvas,
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
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		dragArmed,
		cancel: reset,
		cancelGesture,
		reset,
	};
}