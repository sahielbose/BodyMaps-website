// helpers/viewer/useInteractivePromptTool.ts
//
// Mirrors usePolygonDraw's architecture (pane tracking, world-space storage,
// canvas reprojection) but for the much simpler point/box prompt gesture: a
// single click submits immediately in "point" mode; a click-drag defines two
// corners and submits on mouseup in "box" mode.
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

export type PromptMode = "point" | "box";

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
	// `hasResult` gates prompts that only make sense against an existing
	// object (corrective clicks).
	const promptSessionRef = useRef<(PromptSessionState & { hasResult: boolean }) | null>(null);
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
		paneRef.current = null;
	}, []);

	const submit = useCallback(async (_pane: CinePane, pointWorld: Point3, boxWorld?: [Point3, Point3], include: boolean = true) => {
		if (busyRef.current) return; // one in-flight request at a time
		if (activeSegmentIndex == null) {
			onLog?.("Interactive segment: no target segment selected.");
			return;
		}
		if (caseId == null) {
			onLog?.("Interactive segment: no case loaded.");
			return;
		}
		if (!include && !promptSessionRef.current?.hasResult) {
			// A corrective prompt only means something against an object this
			// session already produced — the model has nothing to carve from
			// yet, and the backend would reject it anyway. Explain locally
			// instead of burning a server round trip.
			const msg = "Add a positive click first — right-click then removes from that object.";
			onLog?.(msg);
			setStatus("error");
			setStatusMessage(msg);
			return;
		}
		if (!promptSessionRef.current) {
			promptSessionRef.current = {
				token: crypto.randomUUID(),
				prevProposal: null,
				priorValues: new Map(),
				hasResult: false,
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
				{ pointLps: pointWorld, boxLps: boxWorld, tolerance, include },
				res,
				session,
			);
			if (result.sessionActive) {
				session.prevProposal = result.proposal;
				session.hasResult = true;
			} else {
				// One-shot response (fallback path ran server-side): the mask
				// was merged additively and there is no accumulated object to
				// refine, so don't carry replace semantics into the next click.
				session.prevProposal = null;
				session.priorValues.clear();
				session.hasResult = false;
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
						"Applied. The tool stays armed, and each new click refines this same object — left-click adds, right-click (or Alt-click) removes. Switching tools or classes starts a fresh one."
					);
				} else {
					// Feedback is the mask itself plus the log line — a modal
					// on every refinement click would break the flow.
					setStatus("idle");
					setStatusMessage(null);
				}
			} else {
				const msg = include
					? "Interactive segment: nothing changed from that prompt — try a different spot."
					: "Nothing to remove there — that click didn't change the object.";
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
		// Alt+click = corrective (remove) — same polarity gesture in both
		// modes, and the keyboard-only sibling of right-click for setups
		// where right-click is spoken for (trackpads, tablet pens).
		void submit(pane, world, undefined, !e.altKey);
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
		void submit(pane, world, undefined, false);
	};

	// Box mode: mousedown starts the drag, mousemove updates the live preview
	// rectangle, mouseup submits both corners. Mirrors the pointer semantics a
	// user already expects from the scissors' click-drag box operations.
	// Alt held at mousedown makes the whole drag corrective (remove-box);
	// polarity is latched at the start so releasing Alt mid-drag doesn't
	// silently flip what the submit will do.
	const dragIncludeRef = useRef(true);
	const handleMouseDown = (pane: CinePane) => (e: MouseEvent) => {
		if (!enabled || mode !== "box") return;
		// Left button only — the right button belongs to handleContextMenu's
		// corrective point, and a right-drag would otherwise strand a live
		// preview box when the context menu event interrupts it.
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
		const endWorld = canvasPointToWorld(pane, canvasPos);
		const startWorld = dragStartWorld;
		reset();
		if (!endWorld) return;
		// A click with ~no drag is treated as a degenerate box — submit as a
		// point at the start position instead of an empty/near-empty box,
		// which the backend's region_grow would otherwise clamp to nothing.
		const dx = Math.abs(canvasPos[0] - (dragStartCanvas?.[0] ?? 0));
		const dy = Math.abs(canvasPos[1] - (dragStartCanvas?.[1] ?? 0));
		if (dx < 4 && dy < 4) {
			void submit(pane, startWorld, undefined, dragIncludeRef.current);
		} else {
			void submit(pane, startWorld, [startWorld, endWorld], dragIncludeRef.current);
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