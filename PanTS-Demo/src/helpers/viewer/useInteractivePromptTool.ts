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
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import {
	canvasPointToWorld,
	worldToCanvasPoint,
	submitInteractiveSegmentPrompt,
	type CinePane,
	type PromptSessionState,
} from "../CornerstoneNifti2";
// Avoid importing Point3 from "@cornerstonejs/core/types" directly — Vite's
// import analysis doesn't reliably resolve that subpath for every file (it
// works from CornerstoneNifti2.tsx, which Vite already had in its graph, but
// errored here). A plain 3-tuple is structurally identical to Point3 for
// everything this file does with it.
type Point3 = [number, number, number];

export type PromptMode = "point" | "box" | "scribble" | "lasso";

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
	const [status, setStatus] = useState<"idle" | "applying" | "success" | "error">("idle");
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	// One refinement session per armed stretch of the tool. Created lazily on
	// the first submit; torn down whenever the arming context changes (the
	// effect below), so a stale token can never leak across classes or cases.
	// Note `mode` is deliberately NOT in the teardown deps: the point and box
	// tools share this one instance, so switching between them keeps refining
	// the same object.
	const promptSessionRef = useRef<PromptSessionState | null>(null);
	// Show the "keep clicking to refine" explainer once per page visit, not
	// on every session — after the first time it's just in the way.
	const refineHintShownRef = useRef(false);
	useEffect(() => {
		promptSessionRef.current = null;
	}, [enabled, activeSegmentIndex, caseId, res]);

	const reset = useCallback(() => {
		setDragStartCanvas(null);
		setDragStartWorld(null);
		setLiveBoxCanvas(null);
		strokeCanvasRef.current = [];
		strokeWorldRef.current = [];
		setLiveStrokeCanvas(null);
		paneRef.current = null;
	}, []);

	const submit = useCallback(async (
		_pane: CinePane,
		pointWorld: Point3,
		opts: { box?: [Point3, Point3]; scribble?: Point3[]; lasso?: Point3[]; include?: boolean } = {},
	) => {
		const include = opts.include ?? true;
		if (busyRef.current) return; // one in-flight request at a time
		if (activeSegmentIndex == null) {
			onLog?.("Interactive segment: no target segment selected.");
			return;
		}
		if (caseId == null) {
			onLog?.("Interactive segment: no case loaded.");
			return;
		}
		// No corrective-prompt gate here: whether a right-click has something
		// to carve from (a prior result, or an existing label the seed scan
		// finds) is decided inside submitInteractiveSegmentPrompt, which
		// throws a plain-English message — still before any network round
		// trip — when it doesn't.
		if (!promptSessionRef.current) {
			promptSessionRef.current = {
				token: crypto.randomUUID(),
				prevProposal: null,
				priorValues: new Map(),
			};
		}
		const session = promptSessionRef.current;
		busyRef.current = true;
		onBusyChange?.(true);
		setStatus("applying");
		setStatusMessage(null);
		try {
			const result = await submitInteractiveSegmentPrompt(
				apiBase,
				caseId,
				activeSegmentIndex,
				{ pointLps: pointWorld, boxLps: opts.box, scribbleLps: opts.scribble, lassoLps: opts.lasso, tolerance, include },
				res,
				session,
			);
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
				onLog?.(`Interactive segment (${parts.join(" / ")} vox)`);
				if (result.sessionActive && !refineHintShownRef.current) {
					refineHintShownRef.current = true;
					setStatus("success");
					setStatusMessage(
						"Applied. The tool stays armed, and each new click refines this same object: left-click adds, right-click (or Alt-click) removes. Switching classes starts a fresh one."
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
					: "Nothing to remove there. That click didn't change the object.";
				onLog?.(msg);
				setStatus("error");
				setStatusMessage(msg);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : "Interactive segmentation failed.";
			onLog?.(msg);
			setStatus("error");
			setStatusMessage(msg);
		} finally {
			busyRef.current = false;
			onBusyChange?.(false);
		}
	}, [apiBase, caseId, activeSegmentIndex, res, tolerance, onLog, onBusyChange]);

	const dismissStatus = useCallback(() => {
		setStatus("idle");
		setStatusMessage(null);
	}, []);

	const handleClick = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "point") return;
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

	// Drag modes (box and scribble): mousedown starts the gesture, mousemove
	// updates the live preview (rectangle or polyline), mouseup submits. Box
	// mirrors the pointer semantics a user already expects from the scissors'
	// click-drag operations; scribble collects the freehand path itself.
	// Alt held at mousedown makes the whole gesture corrective (remove);
	// polarity is latched at the start so releasing Alt mid-drag doesn't
	// silently flip what the submit will do.
	const dragIncludeRef = useRef(true);
	const isStrokeMode = mode === "scribble" || mode === "lasso";
	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || (mode !== "box" && !isStrokeMode)) return;
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
		if (mode === "box") {
			setLiveBoxCanvas([canvasPos, canvasPos]);
		} else {
			strokeCanvasRef.current = [canvasPos];
			strokeWorldRef.current = [world];
			setLiveStrokeCanvas([canvasPos]);
		}
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
		window.addEventListener("blur", abandon);
		return () => {
			window.removeEventListener("mouseup", abandon);
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

	// Canvas-space live box for the overlay, reprojected against the CURRENT
	// camera on every render, same reasoning as usePolygonDraw's toCanvas().
	const pane = paneRef.current;
	const liveBoxDisplay = liveBoxCanvas;
	void worldToCanvasPoint; // referenced for parity with usePolygonDraw's reprojection pattern; box mode doesn't need it since it never stores world corners across a re-render before submit.

	return {
		pane,
		liveBox: liveBoxDisplay,
		liveStroke: liveStrokeCanvas,
		status,
		statusMessage,
		dismissStatus,
		handleClick,
		handleContextMenu,
		handleMouseDown,
		handleMouseMove,
		handleMouseUp,
		cancel: reset,
		reset,
	};
}