// Live side-by-side CT comparison: two 3-plane MPR viewers (one case each) with per-case
// crosshair navigation, segmentation overlays, CT-window presets, and an optional link that
// syncs proportional slice position across the two cases. Case ids come from the URL
// (?a=&b=) so the comparison is shareable. All Cornerstone wiring lives in
// helpers/compareViewer (isolated from the single-case viewer).
//
// The chrome (top toolbar, flyout groups, floating gear) intentionally mirrors
// VisualizationPage.tsx's PYCAD-style toolbar — same vp-* classes, same
// useToolbarFlyout hook, same hidden-by-default/floating-gear behavior — so the two
// viewers feel like one product instead of an older sidebar-based design bolted onto a
// newer one.
import {
	IconAdjustmentsHorizontal,
	IconAngle,
	IconArrowsCross,
	IconArrowUpRight,
	IconChevronDown,
	IconChevronUp,
	IconCircle,
	IconClick,
	IconClipboardList,
	IconFlipVertical,
	IconGrid3x3,
	IconHome,
	IconLasso,
	IconLink,
	IconPlayerPause,
	IconPlayerPlay,
	IconPointer,
	IconRotateClockwise,
	IconRuler2,
	IconScanEye,
	IconSquareDashed,
	IconStack2,
	IconZoomIn,
} from "@tabler/icons-react";
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useSearchParams } from "react-router-dom";
import CompareMeasurementPanel from "../components/MeasurementPanel/CompareMeasurementPanel";
import { ClearMeasurementsFlyoutItem } from "../components/MeasurementPanel/ClearMeasurementsConfirm";
import { measurementToolDetail, measurementToolName } from "../helpers/measurementTools";
import MessagePage from "../components/MessagePage";
import OrganCheckbox from "../components/OrganCheckbox";
import TriggerLabel from "../components/TriggerLabel";
import { resolveSources } from "../helpers/compareSources";
import {
	ANGLE_TOOL,
	ARROW_TOOL,
	BIDIRECTIONAL_TOOL,
	type CompareHandle,
	ELLIPSE_TOOL,
	FREEHAND_ROI_TOOL,
	getOrganLabelAtPoint,
	LENGTH_TOOL,
	MAGNIFY_TOOL,
	PROBE_TOOL,
	type PrimaryMouseToolName,
	ROI_TOOL,
	setupCompare,
	type SliceReadout,
	VIEWPORT_IDS,
} from "../helpers/compareViewer";
import { segmentation_categories, segmentation_category_colors } from "../helpers/constants";
import { filenameToName } from "../helpers/utils.name";
import { escapeWasUsed, markEscapeUsed, NON_TEXT_INPUT_TYPES } from "../helpers/viewer/escapeUsed";
import { organTipPosition } from "../helpers/viewer/organTipPosition";
import { useToolbarFlyout } from "../helpers/viewer/useToolbarFlyout";
import { CT_WINDOWS } from "../helpers/ctWindows";
// Reuse the single viewer's design-system CSS (vp-* classes) so the toolbar is visually
// identical. Its rules are namespaced (vp-*) and its CSS variables are re-declared on
// .cmv below, so importing it here has no side effects on this page.
import "../routes/VisualizationPage.css";
import "./CompareViewerPage.css";

const CT_PRESETS = [
	{ name: "Soft tissue", ...CT_WINDOWS.softTissue },
	{ name: "Bone", ...CT_WINDOWS.bone },
	{ name: "Lung", ...CT_WINDOWS.lung },
	{ name: "Liver", ...CT_WINDOWS.liver },
] as const;

type ViewMode = "mpr" | "axial" | "sagittal" | "coronal";

// 3D is omitted: the single viewer's 3D is a per-case mesh render that has no meaning in a
// two-case side-by-side layout. The other four modes match the single viewer exactly.
const VIEW_MODES: { mode: ViewMode; label: string }[] = [
	{ mode: "mpr", label: "MPR" },
	{ mode: "axial", label: "Axial" },
	{ mode: "sagittal", label: "Sagittal" },
	{ mode: "coronal", label: "Coronal" },
];

const VIEW_TRIGGER_LABELS: readonly string[] = VIEW_MODES.map((v) => v.label);
const WINDOW_TRIGGER_LABELS: readonly string[] = ["Window", ...CT_PRESETS.map((p) => p.name)];

// Measurement tools + magnify loupe the toolbar can switch the primary mouse button to
// (on both cases at once) — same set as the single viewer.
const MEASURE_TOOLS: { name: PrimaryMouseToolName; Icon: typeof IconRuler2 }[] = [
	{ name: LENGTH_TOOL, Icon: IconRuler2 },
	{ name: BIDIRECTIONAL_TOOL, Icon: IconArrowsCross },
	{ name: ANGLE_TOOL, Icon: IconAngle },
	{ name: PROBE_TOOL, Icon: IconClick },
	{ name: ROI_TOOL, Icon: IconSquareDashed },
	{ name: ELLIPSE_TOOL, Icon: IconCircle },
	{ name: FREEHAND_ROI_TOOL, Icon: IconLasso },
	{ name: ARROW_TOOL, Icon: IconArrowUpRight },
	{ name: MAGNIFY_TOOL, Icon: IconZoomIn },
];

// Hover-identify resolves a segment index to a display name — same static organ catalog
// the Class Map panel uses (compare has no custom/edited classes, unlike the single viewer).
const resolveOrganLabel = (idx: number): string | undefined => {
	const staticName = segmentation_categories[idx - 1];
	return staticName ? filenameToName(staticName) : undefined;
};

// Cornerstone's segmentation Color is [r, g, b, a] on a 0–255 scale; CSS wants alpha 0–1.
const colorToCss = (c: readonly number[] | undefined): string =>
	c ? `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(c[3] ?? 255) / 255})` : "rgba(255, 255, 255, 0.4)";

export default function CompareViewerPage() {
	const [params] = useSearchParams();
	const idA = params.get("a") ?? "";
	const idB = params.get("b") ?? "";
	// ?hd=1 reads both CTs at full resolution instead of the fast low-res copies, and the
	// links back to the comparison keep it, so reopening the viewer stays full resolution.
	const hd = params.get("hd") === "1";

	const aAx = useRef<HTMLDivElement>(null);
	const aSag = useRef<HTMLDivElement>(null);
	const aCor = useRef<HTMLDivElement>(null);
	const bAx = useRef<HTMLDivElement>(null);
	const bSag = useRef<HTMLDivElement>(null);
	const bCor = useRef<HTMLDivElement>(null);
	const handleRef = useRef<CompareHandle | null>(null);
	const gridRef = useRef<HTMLDivElement>(null);

	const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
	// Which case failed ("a"/"b"), when setupCompare could tell; null means unknown.
	const [failedCase, setFailedCase] = useState<"a" | "b" | null>(null);
	// True only when the loader saw a definite 404/410, the one failure a wrong case ID explains.
	const [failedNotFound, setFailedNotFound] = useState(false);
	// Bumped by Try again to re-run the load effect for the same pair.
	const [attempt, setAttempt] = useState(0);
	// Try again unmounts with the error, so focus moves to the loading overlay once it shows.
	const loadingOverlayRef = useRef<HTMLDivElement>(null);
	const focusLoadingRef = useRef(false);
	// The overlay unmounts when the retry ends, so focus then moves to a control that survives
	// the swap: the toolbar toggle after a load, the new error's Try again after a failure.
	const retryFocusRef = useRef(false);
	const retryButtonRef = useRef<HTMLButtonElement>(null);
	const [linked, setLinked] = useState(true);
	const [syncCursor, setSyncCursor] = useState(false);
	const [opacityValue, setOpacityValue] = useState(60); // 0–100, matches the single viewer
	const [activePreset, setActivePreset] = useState<string>("Soft tissue");
	const [winWidth, setWinWidth] = useState(400);
	const [winCenter, setWinCenter] = useState(40);
	// Read when a load finishes, so a window picked while the pair was still loading is
	// the one applied to the new handle (the load effect only re-runs on a new pair).
	const winRef = useRef({ width: winWidth, center: winCenter });
	winRef.current = { width: winWidth, center: winCenter };
	// The toolbar lives in normal flow, above the viewports, and opens shown like the single
	// viewer's vp-topbar; the chevron collapses it to a slim bar.
	const [showToolbar, setShowToolbar] = useState(true);
	const topbarRef = useRef<HTMLDivElement>(null);
	// Whichever toggle is mounted (top bar or collapsed bar); focus follows it across the swap.
	const gearRef = useRef<HTMLButtonElement>(null);
	const prevToolbarRef = useRef(showToolbar);
	// The Organs and Measurements buttons, so closing either dock from its own close button
	// can hand keyboard focus back to the button that opened it.
	const organsBtnRef = useRef<HTMLButtonElement>(null);
	const measureBtnRef = useRef<HTMLButtonElement>(null);
	// Class Map panel (OrganCheckbox) open state — mirrors the single viewer's showOrganDetails.
	const [showOrganDetails, setShowOrganDetails] = useState(false);
	const [viewMode, setViewMode] = useState<ViewMode>("mpr");
	const viewLabel = VIEW_MODES.find((v) => v.mode === viewMode)?.label ?? "View";
	const [zoom, setZoom] = useState(1);
	// Read inside the refit's rAF so a slider nudge made meanwhile is not undone.
	const zoomRef = useRef(zoom);
	zoomRef.current = zoom;
	// Per-organ visibility applied to BOTH cases. Index 0 = background (always on).
	const [organVisible, setOrganVisible] = useState<boolean[]>(
		() => [true, ...segmentation_categories.map(() => true)]
	);
	// Hover-to-identify: names the organ under the cursor without moving the crosshair.
	const [hoverIdentifyEnabled, setHoverIdentifyEnabled] = useState(false);
	const [hoverTip, setHoverTip] = useState({ visible: false, x: 0, y: 0, text: "", color: "transparent" });
	// Reference lines: dotted line in a case's other 2 panes for whichever of that case's
	// panes was last scrolled — tracked independently per case inside compareViewer.ts.
	const [referenceLinesOn, setReferenceLinesOn] = useState(false);
	// Cine playback acts on whichever pane was last clicked/scrolled (tracked in compareViewer.ts).
	const [cinePlaying, setCinePlaying] = useState(false);
	const [cineFps, setCineFps] = useState(12);
	// Measurement tools + magnify share one "owns the primary button" slot, applied to
	// both cases at once so either can be measured while a tool is active.
	const [activeMeasureTool, setActiveMeasureTool] = useState<PrimaryMouseToolName | null>(null);
	const [showMeasurePanel, setShowMeasurePanel] = useState(false);
	// Whether either case has a measurement, so the Measure menu's Clear measurements row
	// goes dim instead of offering a confirmation that would clear nothing.
	const [hasMeasurements, setHasMeasurements] = useState(false);
	// Each pane's slice, by viewport id, for the counter chip in its corner.
	const [sliceReadouts, setSliceReadouts] = useState<Record<string, SliceReadout>>({});

	const viewFlyout = useToolbarFlyout();
	const windowFlyout = useToolbarFlyout();
	const adjustFlyout = useToolbarFlyout();
	const syncFlyout = useToolbarFlyout();
	const measureFlyout = useToolbarFlyout();
	const cineFlyout = useToolbarFlyout();

	useEffect(() => {
		if (!idA || !idB) {
			setStatus("idle");
			return;
		}
		let cancelled = false;
		let handle: CompareHandle | null = null;
		const abort = new AbortController();
		setStatus("loading");
		setFailedCase(null);
		setFailedNotFound(false);
		(async () => {
			try {
				const [sa, sb] = await Promise.all([resolveSources(idA, hd), resolveSources(idB, hd)]);
				if (cancelled || !aAx.current) return;
				handle = await setupCompare(
					{
						aAx: aAx.current!, aSag: aSag.current!, aCor: aCor.current!,
						bAx: bAx.current!, bSag: bSag.current!, bCor: bCor.current!,
					},
					{ ctA: sa.ct, segA: sa.seg, ctB: sb.ct, segB: sb.seg },
					abort.signal
				);
				if (cancelled) {
					handle.destroy();
					return;
				}
				handleRef.current = handle;
				handle.applyWindow(winRef.current.width, winRef.current.center); // Soft tissue unless changed while loading
				setStatus("ready");
			} catch (e) {
				console.error(e);
				if (cancelled) return;
				const which = (e as { which?: unknown } | null)?.which;
				setFailedCase(which === "a" || which === "b" ? which : null);
				setFailedNotFound(/\bHTTP (404|410)\b/.test(e instanceof Error ? e.message : ""));
				setStatus("error");
			}
		})();
		return () => {
			cancelled = true;
			// Still loading: no handle exists yet, so the signal stops the in-flight load itself.
			abort.abort();
			handle?.destroy();
			handleRef.current = null;
			// The old handle's cine interval/measurement-tool state is gone with it; drop the
			// UI-only state that tracked it so a fresh load starts in plain navigation mode.
			setCinePlaying(false);
			setActiveMeasureTool(null);
		};
	}, [idA, idB, hd, attempt]);

	useEffect(() => {
		if (status === "loading" && focusLoadingRef.current) {
			focusLoadingRef.current = false;
			loadingOverlayRef.current?.focus();
		}
		if ((status === "ready" || status === "error") && retryFocusRef.current) {
			retryFocusRef.current = false;
			// Only when focus was dropped with the overlay; someone who moved on keeps their place.
			const active = document.activeElement;
			if (!active || active === document.body) {
				(status === "error" ? retryButtonRef : gearRef).current?.focus({ preventScroll: true });
			}
		}
	}, [status]);

	// Follow the pair's measurement count for the Measure menu's Clear measurements row.
	useEffect(() => {
		const handle = handleRef.current;
		if (status !== "ready" || !handle) {
			setHasMeasurements(false);
			return;
		}
		const refresh = () => setHasMeasurements(handle.getMeasurementSummaries().length > 0);
		refresh();
		return handle.subscribeToMeasurementChanges(refresh);
	}, [status, idA, idB]);

	// Keep each pane's slice counter current as it scrolls. The handle is replaced on every
	// reload, so the subscription follows it and the old readings go with it.
	useEffect(() => {
		const handle = handleRef.current;
		if (status !== "ready" || !handle) {
			setSliceReadouts({});
			return;
		}
		const unsubscribe = handle.subscribeToSliceChanges?.((viewportId, readout) => {
			setSliceReadouts((prev) => {
				const old = prev[viewportId];
				return old && old.current === readout.current && old.total === readout.total
					? prev
					: { ...prev, [viewportId]: readout };
			});
		});
		return () => {
			unsubscribe?.();
			setSliceReadouts({});
		};
	}, [status, idA, idB]);

	useEffect(() => {
		handleRef.current?.setLinked(linked);
	}, [linked]);
	useEffect(() => {
		handleRef.current?.setSyncCursor(syncCursor);
	}, [syncCursor]);
	useEffect(() => {
		handleRef.current?.setSegOpacity(opacityValue / 100);
	}, [opacityValue]);
	useEffect(() => {
		handleRef.current?.setOrganVisibility(organVisible);
	}, [organVisible]);
	useEffect(() => {
		handleRef.current?.applyZoom(zoom);
	}, [zoom]);
	useEffect(() => {
		handleRef.current?.setReferenceLines(referenceLinesOn);
	}, [referenceLinesOn]);
	useEffect(() => {
		handleRef.current?.setActiveMeasurementTool(activeMeasureTool);
	}, [activeMeasureTool]);
	// Escape that nothing else used disarms the armed measure or magnify tool, like the case
	// viewer. A flyout, dialog or text field keeps its own Escape; whatever closes or cancels
	// on it marks the event, and some of those listeners run after this one, so the mark is
	// checked once the event has finished.
	useEffect(() => {
		if (!activeMeasureTool) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || escapeWasUsed(e)) return;
			const target = e.target as HTMLElement | null;
			if (target?.closest?.('[role="dialog"], [aria-modal="true"], .vp-flyout')) return;
			if (target && (target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
			if (target?.tagName === "INPUT" && !NON_TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)) return;
			window.setTimeout(() => {
				if (!escapeWasUsed(e)) setActiveMeasureTool(null);
			}, 0);
		};
		// A half-drawn measurement takes the Escape first (as in the case viewer). Capture
		// phase, so this runs before Cornerstone's own Freehand binding cancels the outline
		// without marking the Escape, which would disarm the tool along with it.
		const onEscapeCapture = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (handleRef.current?.cancelDrawing()) markEscapeUsed(e);
		};
		document.addEventListener("keydown", onKey);
		window.addEventListener("keydown", onEscapeCapture, true);
		return () => {
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("keydown", onEscapeCapture, true);
		};
	}, [activeMeasureTool]);
	// Re-apply the user's view settings once a fresh load is ready. A new case load builds a
	// new handle with default state (all organs on, 0.6 opacity, fit zoom, linked scroll, no
	// measure tool), so if the user had changed any of these before switching cases, or while
	// the pair was still loading, we push them back onto the new handle. The per-setting
	// effects above only fire on change, not on reload.
	useEffect(() => {
		if (status !== "ready") return;
		handleRef.current?.setLinked(linked);
		handleRef.current?.setSyncCursor(syncCursor);
		handleRef.current?.setActiveMeasurementTool(activeMeasureTool);
		handleRef.current?.setOrganVisibility(organVisible);
		handleRef.current?.setSegOpacity(opacityValue / 100);
		handleRef.current?.applyZoom(zoom);
		handleRef.current?.setReferenceLines(referenceLinesOn);
		// Inputs intentionally omitted: the per-setting effects handle live changes; this runs
		// only when a load completes.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [status]);
	// The viewport grid changes size whenever the view mode switches between MPR (3 planes)
	// and a single plane, OR the Class Map or Measurements panel opens/closes (each is a real
	// docked sidebar — flex-basis + display:none/flex — not an overlay, so it genuinely narrows the
	// stage, not just paints over it). Cornerstone's RenderingEngine doesn't know the DOM
	// around it resized unless told to — without this, its canvases keep their stale
	// pre-toggle dimensions, so anything relying on canvas-to-world math (centerCursor, zoom)
	// looks subtly wrong until something else happens to trigger a resize. Re-fit after the
	// layout has painted (double rAF, like the single viewer). A dock is opened mid-read
	// (the Measurements panel next to a measurement), so it keeps the slice, pan and zoom.
	// The stage observer below waits while one of these full refits is queued, since a
	// keep-the-view pass on top of it would leave a pane cropped.
	const fullRefitPendingRef = useRef(false);
	const refitAfterPaint = (keepView: boolean) => {
		let raf2 = 0;
		if (!keepView) fullRefitPendingRef.current = true;
		const raf1 = requestAnimationFrame(() => {
			raf2 = requestAnimationFrame(() => {
				handleRef.current?.refit(keepView);
				// A full refit puts every pane back at fit zoom; bring back the zoom the slider shows.
				if (!keepView) {
					handleRef.current?.applyZoom(zoomRef.current);
					fullRefitPendingRef.current = false;
				}
			});
		});
		return () => {
			cancelAnimationFrame(raf1);
			cancelAnimationFrame(raf2);
			if (!keepView) fullRefitPendingRef.current = false;
		};
	};
	useEffect(() => {
		if (status !== "ready") return;
		return refitAfterPaint(false);
	}, [viewMode, status]);
	// Keep the panes fitted to the grid as it resizes for any reason: a dock opening or
	// closing, the window or a tablet's orientation changing, the toolbar wrapping to more rows
	// or being collapsed to its fixed bar, the mobile browser bars moving the dynamic viewport.
	// Cornerstone has no resize handling of its own, so without this the canvases keep their
	// old pixel size and the scans look stretched or clipped. Each pane keeps its slice, pan
	// and zoom (a dock is opened mid-read), like the single viewer's stage observer. Cornerstone
	// drops a resize while a render is queued, and a dock moves the grid over several frames,
	// so refit once a frame until refit() reports the panes caught up.
	useEffect(() => {
		const el = gridRef.current;
		if (status !== "ready" || !el || typeof ResizeObserver === "undefined") return;
		let raf = 0;
		const settle = (passes: number) => {
			raf = 0;
			// A view-mode refit is queued; let it run, then look again.
			if (fullRefitPendingRef.current) {
				raf = requestAnimationFrame(() => settle(passes));
				return;
			}
			if (el.clientWidth === 0 || el.clientHeight === 0) return;
			const unsettled = handleRef.current?.refit(true);
			if (unsettled && passes < 12) raf = requestAnimationFrame(() => settle(passes + 1));
		};
		const ro = new ResizeObserver(() => {
			if (raf) cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => settle(0));
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			if (raf) cancelAnimationFrame(raf);
		};
	}, [status]);
	// Cine, flip and rotate act on the focused pane, so a single-plane view must focus a pane
	// that is on screen (case A's), and a cine running on a now-hidden pane stops.
	useEffect(() => {
		if (status !== "ready" || viewMode === "mpr") return;
		handleRef.current?.stopCine();
		setCinePlaying(false);
		handleRef.current?.setFocusedViewport(
			viewMode === "axial" ? VIEWPORT_IDS.aAx : viewMode === "sagittal" ? VIEWPORT_IDS.aSag : VIEWPORT_IDS.aCor
		);
	}, [viewMode, status]);
	const docksReadyRef = useRef(false);
	useEffect(() => {
		if (status !== "ready") {
			docksReadyRef.current = false;
			return;
		}
		// The load itself is refitted above; only a dock toggle after it keeps the view.
		if (!docksReadyRef.current) {
			docksReadyRef.current = true;
			return;
		}
		return refitAfterPaint(true);
	}, [status, showOrganDetails, showMeasurePanel]);

	// The button that toggles the toolbar is a different element in each state, so keyboard
	// focus would drop to the page body when the old one unmounts.
	useEffect(() => {
		// Compare against the previous value so a StrictMode double-run of the mount effect
		// does not grab focus on load.
		if (prevToolbarRef.current === showToolbar) return;
		prevToolbarRef.current = showToolbar;
		gearRef.current?.focus({ preventScroll: true });
	}, [showToolbar]);

	// A dock's own close button hides (Organs) or unmounts (Measurements) with the dock, which
	// would drop focus to <body>. Closing from inside a dock hands focus back to the toolbar
	// button that opened it, or to the toggle when the toolbar is collapsed; a close from
	// elsewhere leaves focus where it is.
	const keepFocusOnDockButton = (trigger: React.RefObject<HTMLButtonElement | null>) => {
		if (document.activeElement?.closest(".vp-organs, .vp-measure")) {
			(trigger.current ?? gearRef.current)?.focus({ preventScroll: true });
		}
	};

	const applyPreset = (preset: (typeof CT_PRESETS)[number]) => {
		setActivePreset(preset.name);
		setWinWidth(preset.width);
		setWinCenter(preset.center);
		handleRef.current?.applyWindow(preset.width, preset.center);
	};
	// Same contract as the single viewer's window-change handler: fall back to the current
	// value for whichever side isn't being changed.
	const handleWindowChange = (newWidth: number | null, newCenter: number | null) => {
		const width = Math.max(newWidth ?? winWidth, 1);
		const center = newCenter ?? winCenter;
		setActivePreset("");
		setWinWidth(width);
		setWinCenter(center);
		handleRef.current?.applyWindow(width, center);
	};

	const handleOpacityChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const value = Number(e.target.value);
		setOpacityValue(value);
		handleRef.current?.setSegOpacity(value / 100);
	};

	const resetView = () => {
		setZoom(1);
		handleRef.current?.resetView();
	};

	// A line that says why a jump did nothing, for about five seconds (the single viewer's
	// tool notices work the same way).
	const [notice, setNotice] = useState<string | null>(null);
	const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const showNotice = (message: string) => {
		setNotice(message);
		if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
		noticeTimerRef.current = setTimeout(() => setNotice(null), 5000);
	};
	useEffect(() => () => {
		if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
	}, []);

	// Jump both cases' crosshairs to the organ's centroid, and make sure it's visible first
	// (matches the single viewer's behaviour). A case whose mask lacks the organ stays put, and
	// when neither has it nothing is switched on: the checkbox would read as shown with no mask behind it.
	const handleJumpToOrgan = (label: number) => {
		const missing = handleRef.current?.jumpToOrgan(label) ?? [];
		if (missing.length >= 2) {
			showNotice("That organ is not in either case.");
			return;
		}
		if (missing.length === 1) showNotice(`That organ is not in case ${missing[0] === "a" ? idA : idB}.`);
		setOrganVisible((prev) => {
			if (prev[label]) return prev;
			const next = [...prev];
			next[label] = true;
			return next;
		});
	};

	// Hover-identify: resolves the organ under the cursor via the SAME viewport the mouse
	// is over (works on any of the 6 panes — each looks up that pane's own case's volume).
	const handlePaneHover = (viewportId: string) => (e: React.MouseEvent) => {
		if (!hoverIdentifyEnabled) return;
		const idx = getOrganLabelAtPoint(viewportId, e.clientX, e.clientY);
		if (idx == null || idx === 0) {
			setHoverTip((t) => (t.visible ? { ...t, visible: false } : t));
			return;
		}
		const name = resolveOrganLabel(idx) ?? "Unknown";
		const color = colorToCss(segmentation_category_colors[idx]);
		const { x, y } = organTipPosition(e.clientX, e.clientY, name);
		setHoverTip({ visible: true, x, y, text: name, color });
	};
	const handlePaneHoverLeave = () => setHoverTip((t) => (t.visible ? { ...t, visible: false } : t));

	// Focus (which pane cine/flip/rotate act on) is tracked inside compareViewer.ts itself
	// via its own mousedown/wheel listeners — this just forwards an explicit click there too,
	// so clicking (without dragging) a pane also moves focus, matching the single viewer.
	const handlePaneMouseDown = (viewportId: string) => () => handleRef.current?.setFocusedViewport(viewportId);

	const toggleCine = () => {
		if (cinePlaying) {
			handleRef.current?.stopCine();
			setCinePlaying(false);
			return;
		}
		const ok = handleRef.current?.startCine(cineFps) ?? false;
		setCinePlaying(ok);
	};
	const handleCineFpsChange = (fps: number) => {
		setCineFps(fps);
		if (cinePlaying) {
			handleRef.current?.stopCine();
			handleRef.current?.startCine(fps);
		}
	};

	const bothIds = idA && idB;
	const syncActive = linked || syncCursor;
	const activeMeasureEntry = MEASURE_TOOLS.find((t) => t.name === activeMeasureTool);
	const ActiveMeasureIcon = activeMeasureEntry?.Icon ?? IconRuler2;

	// Reached without two case ids (a hand-typed or truncated URL): a normal site page with
	// a way to pick cases, not a blank viewer.
	if (!bothIds) {
		const compareHref = idA || idB ? `/compare?${new URLSearchParams({ ...(idA ? { a: idA } : { b: idB }), ...(hd ? { hd: "1" } : {}) })}` : hd ? "/compare?hd=1" : "/compare";
		return (
			<MessagePage
				eyebrow="Compare viewer"
				title="Choose two cases to compare"
				actions={[
					{ label: "Browse the dataset", to: "/dashboard" },
					{ label: "Open the compare page", to: compareHref },
				]}
			>
				<p>
					This viewer shows two CT scans side by side. Pick two cases in the dataset, or enter
					their IDs on the compare page.
				</p>
			</MessagePage>
		);
	}

	const failedLabel =
		failedCase === "a" ? `Case ${idA} couldn't be loaded.`
		: failedCase === "b" ? `Case ${idB} couldn't be loaded.`
		: "One or both cases couldn't be loaded.";

	return (
		<div className="cmv">
			{showToolbar && (
				<div className="vp-topbar" ref={topbarRef}>
					<Link
						className="vp-iconbtn"
						to={`/compare?a=${idA}&b=${idB}${hd ? "&hd=1" : ""}`}
						aria-label="Back to comparison"
						title="Back to comparison"
					>
						<IconHome size={20} color="white" />
					</Link>

					<span className="vp-tb-divider" />

					<div className="vp-tb-id">
						<span className="vp-tb-id__eyebrow">Compare</span>
						<span className="vp-tb-id__val">#{idA} vs #{idB}</span>
					</div>

					<span className="vp-tb-divider" />

					{/* View ▾ — MPR/Axial/Sag/Cor, same set as the single viewer minus 3D
					    (which has no meaning for a two-case side-by-side layout). View, Adjust
					    and Cine are labelled groups rather than ARIA menus: they hold toggles
					    and sliders, which role="menu" cannot contain. */}
					<div className="vp-toolgroup" ref={viewFlyout.groupRef}>
						<button
							ref={viewFlyout.btnRef}
							className={`vp-tb-mini vp-tb-mini--flyout ${viewFlyout.open ? "vp-tb-mini--active" : ""}`}
							onClick={viewFlyout.toggle}
							aria-label={`View: ${viewLabel}`}
							aria-expanded={viewFlyout.open}
						>
							<TriggerLabel current={viewLabel} options={VIEW_TRIGGER_LABELS} />
							<IconChevronDown size={13} />
						</button>
						{viewFlyout.open && viewFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--config"
									role="group"
									aria-label="View options"
									ref={viewFlyout.menuRef}
									style={viewFlyout.panelStyle}
								>
									<span className="vp-panel__title">View</span>
									<div className="vp-seg cmv__viewseg" role="group" aria-label="View mode">
										{VIEW_MODES.map((v) => (
											<button
												key={v.mode}
												onClick={() => setViewMode(v.mode)}
												aria-pressed={viewMode === v.mode}
												className={`vp-seg__btn ${viewMode === v.mode ? "vp-seg__btn--active" : ""}`}
											>
												{v.label}
											</button>
										))}
									</div>
									<button
										className={`vp-flyout__item ${hoverIdentifyEnabled ? "is-active" : ""}`}
										aria-pressed={hoverIdentifyEnabled}
										title="Name the organ under the cursor, in either case"
										onClick={() => {
											setHoverIdentifyEnabled((v) => !v);
											setHoverTip((t) => (t.visible ? { ...t, visible: false } : t));
											viewFlyout.close();
										}}
									>
										<IconScanEye size={18} />
										<span>{hoverIdentifyEnabled ? "Hover identify: on" : "Hover identify"}</span>
									</button>
									<button
										className={`vp-flyout__item ${referenceLinesOn ? "is-active" : ""}`}
										aria-pressed={referenceLinesOn}
										title="Dotted line in each case's other panes for whichever you scroll"
										onClick={() => {
											setReferenceLinesOn((v) => !v);
											viewFlyout.close();
										}}
									>
										<IconGrid3x3 size={18} />
										<span>{referenceLinesOn ? "Reference lines: on" : "Reference lines"}</span>
									</button>
									<button
										className="vp-flyout__item"
										title="Acts on the focused pane (the last one clicked or scrolled)"
										onClick={() => {
											handleRef.current?.flipFocused();
											viewFlyout.close();
										}}
									>
										<IconFlipVertical size={18} />
										<span>Flip horizontal</span>
									</button>
									<button
										className="vp-flyout__item"
										title="Acts on the focused pane (the last one clicked or scrolled)"
										onClick={() => {
											handleRef.current?.rotateFocused90();
											viewFlyout.close();
										}}
									>
										<IconRotateClockwise size={18} />
										<span>Rotate 90° clockwise</span>
									</button>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Window ▾ — CT presets. Trigger shows the active preset's name. */}
					<div className="vp-toolgroup" ref={windowFlyout.groupRef}>
						<button
							ref={windowFlyout.btnRef}
							className={`vp-tb-mini vp-tb-mini--flyout ${windowFlyout.open ? "vp-tb-mini--active" : ""}`}
							onClick={windowFlyout.toggle}
							aria-label={activePreset ? `CT window preset: ${activePreset}` : "CT window preset"}
							aria-expanded={windowFlyout.open}
							aria-controls={windowFlyout.open ? windowFlyout.panelId : undefined}
						>
							<TriggerLabel current={activePreset || "Window"} options={WINDOW_TRIGGER_LABELS} />
							<IconChevronDown size={13} />
						</button>
						{windowFlyout.open && windowFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout"
									id={windowFlyout.panelId}
									role="group"
									aria-label="CT window preset"
									ref={windowFlyout.menuRef}
									style={windowFlyout.panelStyle}
								>
									{CT_PRESETS.map((preset) => (
										<button
											key={preset.name}
											className={`vp-flyout__item ${activePreset === preset.name ? "is-active" : ""}`}
											aria-pressed={activePreset === preset.name}
											onClick={() => applyPreset(preset)}
										>
											<span>{preset.name}</span>
										</button>
									))}
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Adjust ▾ — mask fill opacity, brightness, contrast, zoom, plus center/reset. */}
					<div className="vp-toolgroup" ref={adjustFlyout.groupRef}>
						<button
							ref={adjustFlyout.btnRef}
							className={`vp-tool ${adjustFlyout.open ? "vp-tool--active" : ""}`}
							onClick={adjustFlyout.toggle}
							aria-label="Adjust"
							aria-haspopup="dialog"
							aria-expanded={adjustFlyout.open}
						>
							<IconAdjustmentsHorizontal size={20} color={adjustFlyout.open ? "#08090b" : "white"} />
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">Adjust</span>
						</button>
						{adjustFlyout.open && adjustFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--adjust"
									role="group"
									aria-label="Adjust image"
									ref={adjustFlyout.menuRef}
									style={adjustFlyout.panelStyle}
								>
									<label className="vp-tb-slider" title="Segmentation fill opacity">
										<span className="vp-tb-slider__label">Fill</span>
										<input
											type="range" min="0" max="100" step="1" className="vp-range"
											aria-label="Segmentation opacity"
											value={opacityValue}
											onChange={handleOpacityChange}
										/>
										<span className="vp-tb-slider__val">{Math.round(opacityValue)}%</span>
									</label>
									<label className="vp-tb-slider" title="Brightness (window level)">
										<span className="vp-tb-slider__label">Brt</span>
										<input
											type="range" min="-1000" max="1000" step="1" className="vp-range"
											aria-label="Brightness"
											value={winCenter * -1}
											onChange={(e) => handleWindowChange(null, Number(e.target.value) * -1)}
										/>
									</label>
									<label className="vp-tb-slider" title="Contrast (window width)">
										<span className="vp-tb-slider__label">Con</span>
										<input
											type="range" min="1" max="2000" step="1" className="vp-range"
											aria-label="Contrast"
											value={winWidth}
											onChange={(e) => handleWindowChange(Number(e.target.value), null)}
										/>
									</label>
									<label className="vp-tb-slider" title="Zoom">
										<span className="vp-tb-slider__label">Zoom</span>
										<input
											type="range" min="0.5" max="2" step="0.05" className="vp-range"
											aria-label="Zoom"
											value={zoom}
											onChange={(e) => setZoom(Number(e.target.value))}
										/>
										<span className="vp-tb-slider__val">{zoom.toFixed(2)}×</span>
									</label>
									<div className="vp-flyout--adjust__actions">
										<button className="vp-tb-mini" onClick={() => handleRef.current?.centerCursor()} title="Center on crosshair">
											Center
										</button>
										<button className="vp-tb-mini" onClick={resetView} title="Reset zoom & pan">
											Reset
										</button>
									</div>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Measure ▾ — distance/angle/probe/ROI/arrow tools + magnify loupe, applied to
					    BOTH cases at once (draw on whichever one you click). */}
					<div className="vp-toolgroup" ref={measureFlyout.groupRef}>
						<button
							ref={measureFlyout.btnRef}
							className={`vp-tool ${activeMeasureTool || measureFlyout.open ? "vp-tool--active" : ""}`}
							onClick={measureFlyout.toggle}
							aria-label="Measurement tools"
							aria-haspopup="dialog"
							aria-expanded={measureFlyout.open}
							aria-controls={measureFlyout.open ? measureFlyout.panelId : undefined}
						>
							<ActiveMeasureIcon size={20} color={activeMeasureTool || measureFlyout.open ? "#08090b" : "white"} />
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">Measure</span>
						</button>
						{measureFlyout.open && measureFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout"
									id={measureFlyout.panelId}
									role="group"
									aria-label="Measurement tools"
									ref={measureFlyout.menuRef}
									style={measureFlyout.panelStyle}
								>
									{MEASURE_TOOLS.map(({ name, Icon }) => (
										<button
											key={name}
											className={`vp-flyout__item ${activeMeasureTool === name ? "is-active" : ""}`}
											aria-pressed={activeMeasureTool === name}
											// Name and detail are adjacent spans, which read as one run-on word.
											aria-label={`${measurementToolName(name)}, ${measurementToolDetail(name)}`}
											onClick={() => {
												setActiveMeasureTool((p) => (p === name ? null : name));
												measureFlyout.close();
											}}
										>
											<Icon size={18} />
											<span>{measurementToolName(name)}</span>
											<span className="vp-flyout__detail">{measurementToolDetail(name)}</span>
										</button>
									))}
									<ClearMeasurementsFlyoutItem
										disabled={!hasMeasurements}
										onClear={() => {
											handleRef.current?.clearMeasurements();
											setHasMeasurements(false);
											measureFlyout.close();
										}}
									/>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Cine ▾ — the one flyout that stays open on click: a live mini-panel
					    (play/pause + FPS side by side), not a pick-and-dismiss menu. Plays
					    whichever pane was last clicked/scrolled. */}
					<div className="vp-toolgroup" ref={cineFlyout.groupRef}>
						<button
							ref={cineFlyout.btnRef}
							className={`vp-tool ${cinePlaying || cineFlyout.open ? "vp-tool--active" : ""}`}
							onClick={cineFlyout.toggle}
							aria-label="Cine controls"
							aria-haspopup="dialog"
							aria-expanded={cineFlyout.open}
						>
							{cinePlaying ? (
								<IconPlayerPause size={20} color={cineFlyout.open ? "#08090b" : "white"} />
							) : (
								<IconPlayerPlay size={20} color={cineFlyout.open ? "#08090b" : "white"} />
							)}
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">
								{cinePlaying ? `Cine playing (${cineFps} fps). Click for controls` : "Cine controls"}
							</span>
						</button>
						{cineFlyout.open && cineFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout vp-flyout--cine"
									role="group"
									aria-label="Cine playback"
									ref={cineFlyout.menuRef}
									style={cineFlyout.panelStyle}
								>
									<button
										className={`vp-tool vp-tool--cine-play ${cinePlaying ? "vp-tool--active" : ""}`}
										onClick={toggleCine}
										aria-label={cinePlaying ? "Pause cine playback" : "Play cine playback"}
									>
										{cinePlaying ? (
											<IconPlayerPause size={20} color="#08090b" />
										) : (
											<IconPlayerPlay size={20} color="white" />
										)}
									</button>
									<label className="vp-tb-slider vp-tb-slider--cine" title="Cine playback speed">
										<span className="vp-tb-slider__label">FPS</span>
										<input
											type="range" min="1" max="100" step="1" className="vp-range"
											aria-label="Cine frames per second"
											value={cineFps}
											onChange={(e) => handleCineFpsChange(Number(e.target.value))}
										/>
										<span className="vp-tb-slider__val">{cineFps}</span>
									</label>
								</div>,
								document.body
							)}
					</div>

					<span className="vp-tb-divider" />

					{/* Class Map — the same full-view organ panel as the single viewer. */}
					<button
						ref={organsBtnRef}
						className={`vp-tool ${showOrganDetails ? "vp-tool--active" : ""}`}
						onClick={() => setShowOrganDetails((v) => !v)}
						aria-label="Organs"
						aria-pressed={showOrganDetails}
					>
						<IconStack2 size={20} color={showOrganDetails ? "#08090b" : "white"} />
						<span className="vp-tool__tip">Organs</span>
					</button>

					{/* Measurements list — rename/jump/delete each annotation, tagged with which case. */}
					<button
						ref={measureBtnRef}
						className={`vp-tool cmv__tool--tip-start ${showMeasurePanel ? "vp-tool--active" : ""}`}
						onClick={() => setShowMeasurePanel((v) => !v)}
						aria-label="Measurements"
						aria-pressed={showMeasurePanel}
					>
						<IconClipboardList size={20} color={showMeasurePanel ? "#08090b" : "white"} />
						<span className="vp-tool__tip">Measurements</span>
					</button>

					<span className="vp-tb-divider" />

					{/* Sync ▾ — compare-only, no equivalent in the single viewer. Keeps the two
					    cases' navigation in step (proportional slice link, and/or a shared
					    cursor position). */}
					<div className="vp-toolgroup" ref={syncFlyout.groupRef}>
						<button
							ref={syncFlyout.btnRef}
							className={`vp-tool ${syncActive || syncFlyout.open ? "vp-tool--active" : ""}`}
							onClick={syncFlyout.toggle}
							aria-label="Sync"
							aria-haspopup="dialog"
							aria-expanded={syncFlyout.open}
							aria-controls={syncFlyout.open ? syncFlyout.panelId : undefined}
						>
							<IconLink size={20} color={syncActive || syncFlyout.open ? "#08090b" : "white"} />
							<span className="vp-tool__caret" />
							<span className="vp-tool__tip">Sync</span>
						</button>
						{syncFlyout.open && syncFlyout.pos &&
							createPortal(
								<div
									className="vp-flyout"
									id={syncFlyout.panelId}
									role="group"
									aria-label="Sync options"
									ref={syncFlyout.menuRef}
									style={syncFlyout.panelStyle}
								>
									<button
										className={`vp-flyout__item ${linked ? "is-active" : ""}`}
										aria-pressed={linked}
										title="Keep both cases at the same proportional slice position"
										onClick={() => setLinked((v) => !v)}
									>
										<IconLink size={18} />
										<span>Link scroll</span>
									</button>
									<button
										className={`vp-flyout__item ${syncCursor ? "is-active" : ""}`}
										aria-pressed={syncCursor}
										title="Mirror the crosshair position between cases"
										onClick={() => setSyncCursor((v) => !v)}
									>
										<IconPointer size={18} />
										<span>Sync cursor</span>
									</button>
								</div>,
								document.body
							)}
					</div>
					{/* Last in the bar so Home leads, as in the single viewer; the margin pushes it to the
					    end of the last row. */}
					<button
						ref={gearRef}
						className="vp-iconbtn cmv__tbtoggle"
						title="Hide toolbar"
						aria-label="Toggle toolbar"
						aria-expanded={true}
						onClick={() => setShowToolbar(false)}
					>
						<IconChevronUp size={20} color="white" />
					</button>
				</div>
			)}

			{/* Keep the collapsed-toolbar control in its own chrome row.  The old
			    floating button sat on top of the first viewport and could obscure
			    the case label/text underneath it. */}
			{!showToolbar && (
				<div className="cmv__collapsedbar">
					<button
						ref={gearRef}
						className="vp-floating-gear vp-iconbtn"
						title="Show toolbar"
						aria-label="Toggle toolbar"
						aria-expanded={false}
						onClick={() => setShowToolbar(true)}
					>
						<IconChevronDown size={20} color="white" />
					</button>
				</div>
			)}

			<main className="vp-body">
				<h1 className="sr-only">
					Case {idA} and case {idB} side by side
				</h1>
				{/* Class Map: full-view organ panel (slides over everything), identical to the
				    single viewer. Kept mounted so it can slide in/out. */}
				<OrganCheckbox
					setCheckState={setOrganVisible}
					checkState={organVisible}
					sessionId={undefined}
					setShowOrganDetails={(open) => { if (open === false) keepFocusOnDockButton(organsBtnRef); setShowOrganDetails(open); }}
					showOrganDetails={showOrganDetails}
					labelColorMap={segmentation_category_colors}
					onJumpToOrgan={handleJumpToOrgan}
				/>

				<div className="vp-stage cmv__grid" ref={gridRef}>
				{[
					{
						id: idA, ax: aAx, sag: aSag, cor: aCor,
						vp: { axial: VIEWPORT_IDS.aAx, sagittal: VIEWPORT_IDS.aSag, coronal: VIEWPORT_IDS.aCor },
					},
					{
						id: idB, ax: bAx, sag: bSag, cor: bCor,
						vp: { axial: VIEWPORT_IDS.bAx, sagittal: VIEWPORT_IDS.bSag, coronal: VIEWPORT_IDS.bCor },
					},
				].map((row, r) => (
					<div
						className={`cmv__caserow${viewMode === "mpr" ? " cmv__caserow--mpr" : ""}`}
						key={r}
						style={viewMode === "mpr" ? undefined : { gridTemplateColumns: "1fr" }}
					>
						{([
							["Axial", "axial", row.ax],
							["Sagittal", "sagittal", row.sag],
							["Coronal", "coronal", row.cor],
						] as const).map(([label, mode, ref], c) => {
							// Keep every viewport div mounted (Cornerstone needs its element);
							// just hide the planes not in the current view mode.
							const hidden = viewMode !== "mpr" && viewMode !== mode;
							const viewportId = row.vp[mode];
							return (
								<div className="cmv__cell" key={c} style={hidden ? { display: "none" } : undefined}>
									{/* On the first visible cell: in a single-plane view the axial cell is hidden. */}
									{mode === (viewMode === "mpr" ? "axial" : viewMode) && <span className="cmv__caselabel">Case {row.id}</span>}
									<span className={`cmv__planelabel cmv__planelabel--${mode}`}>{label}</span>
									{sliceReadouts[viewportId] && (
										<span
											className="cmv__slicecount"
											role="img"
											aria-label={`Case ${row.id} ${mode} slice ${sliceReadouts[viewportId].current + 1} of ${sliceReadouts[viewportId].total}`}
										>
											{sliceReadouts[viewportId].current + 1}/{sliceReadouts[viewportId].total}
										</span>
									)}
									<div
										className={`cmv__viewport${hoverIdentifyEnabled ? " cmv__viewport--hover-identify" : ""}`}
										ref={ref}
										onContextMenu={(e) => e.preventDefault()}
										onMouseMove={handlePaneHover(viewportId)}
										onMouseLeave={handlePaneHoverLeave}
										onMouseDown={handlePaneMouseDown(viewportId)}
									/>
								</div>
							);
						})}
					</div>
				))}

				{status === "loading" && (
					<div className="cmv__overlay" tabIndex={-1} ref={loadingOverlayRef}>
						<span className="cmv__spinner" aria-hidden="true" /> Loading both cases…
					</div>
				)}
				{status === "error" && (
					<div className="cmv__overlay cmv__overlay--err">
						<div className="cmv__error" role="alert">
							<h2 className="cmv__error-title">{failedLabel}</h2>
							<p className="cmv__error-text">
								{failedNotFound
									? "Check the case ID, or go back and pick another case."
									: "This can be a connection problem. Try again."}
							</p>
						</div>
						<div className="cmv__error-actions">
							<button
								type="button"
								className="cmv__error-primary"
								ref={retryButtonRef}
								onClick={() => {
									focusLoadingRef.current = true;
									retryFocusRef.current = true;
									setAttempt((n) => n + 1);
								}}
							>
								Try again
							</button>
							<Link className="cmv__error-link" to={`/compare?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}${hd ? "&hd=1" : ""}`}>
								Back to the comparison
							</Link>
							<Link className="cmv__error-link" to="/dashboard">
								Browse the dataset
							</Link>
						</div>
					</div>
				)}
				</div>
				{/* Always mounted, so a change in their text is spoken (a live region inserted with
				    its text often is not). The overlay and toast show the same words for the eye. */}
				<span className="sr-only" role="status">{status === "loading" ? "Loading both cases" : ""}</span>
				<span className="sr-only" role="status">{notice ?? ""}</span>

				{showMeasurePanel && (
					<CompareMeasurementPanel
						handle={handleRef.current}
						idA={idA}
						idB={idB}
						onClose={() => { keepFocusOnDockButton(measureBtnRef); setShowMeasurePanel(false); }}
					/>
				)}
			</main>

			{notice && (
				<div className="cmv__notice" aria-hidden="true">
					{notice}
				</div>
			)}

			{hoverTip.visible && (
				<div
					className="vp-organ-tip"
					style={{ left: hoverTip.x, top: hoverTip.y, borderLeftColor: hoverTip.color }}
				>
					<span className="vp-organ-tip__swatch" style={{ background: hoverTip.color }} />
					{hoverTip.text}
				</div>
			)}
		</div>
	);
}
