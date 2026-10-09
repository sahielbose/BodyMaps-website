import { useState, useRef, useCallback, useEffect, useId, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import {
	IconBrush,
	IconEraser,
	IconScissors,
	IconRipple,
	IconArrowsDiagonal,
	IconDroplet,
	IconMathFunction,
	IconWand,
	IconStack2,
	IconCopy,
	IconWaveSine,
	IconCircleDashed,
	IconTarget,
	IconBoxAlignTopLeft,
	IconScribble,
	IconLasso,
	IconSparkles,
	IconCheck,
} from "@tabler/icons-react";
import "./AnnotationToolbar.css";
import NumberSliderField from "../NumberSliderField";
import { FlyoutArrow, FlyoutPanel, MenuColumn, MenuRow, MenuDivider, useFlyout } from "./FlyoutPrimitives";
import { tooltipSide } from "../../helpers/viewer/tooltipSide";
import { ribbonHiddenStrip, snapRibbonScroll } from "../../helpers/viewer/ribbonSnap";
import { MAX_DIAMETER_MM, MIN_DIAMETER_MM } from "../../helpers/viewer/brushSize";
import {
	interactiveAttribution,
	primeInteractiveLicense,
	modelToolOffered,
	useInteractiveCapabilities,
} from "../../helpers/viewer/interactiveAttribution";
import { useGuidedStepModalOpen, type GuidedFlowControls } from "../segmentation/SliceAnchorPickerUI";
import { focusableWithin, useDialogFocus } from "../../hooks/useDialogFocus";

// sessionStorage keys: once a hint has been seen, it won't auto-open again
// FOR THE REST OF THIS TAB SESSION. Deliberately sessionStorage rather than
// localStorage — these are meant to re-appear on every fresh page
// load/reload, not just once ever per browser.
// Guided-flow (Continue / Start over / Exit) explainer. Each guided tool
// (Grow from Seeds, Copy across slices, Fill between slices, Islands) gets
// its OWN "seen" flag — so seeing the explainer for one doesn't suppress it
// for the others — even though several of them share the same wording.
const GUIDED_HINT_SEEN_KEY_PREFIX = "mm_annotation_guided_hint_seen_";

export type PrimaryEditTool =
	| "paint" | "erase" | "scissors" | "levelTracing"
	| "margin" | "smoothing" | "islands" | "logicalOperators"
	| "growFromSeeds" | "fillBetweenSlices" | "copyAcrossSlices" | "hollow"
	| "pointSegment" | "boxSegment" | "scribbleSegment" | "lassoSegment"
	| "refineSegment"
	| null;
export type ScissorsOperation = "eraseInside" | "eraseOutside" | "fillInside" | "fillOutside";
export type ScissorsSliceCut = "unlimited" | "positive" | "negative" | "symmetric";

export interface ScissorsOptions {
	operation: ScissorsOperation;
	/** When on, each placed point snaps to the nearest strong intensity edge
	 *  within a small radius (like Photoshop's magnetic lasso). */
	magnetEnabled?: boolean;
}

interface AnnotationToolbarProps {
	open: boolean;
	hasSegments: boolean;
	hasActiveTarget: boolean;
	activeTool: PrimaryEditTool;
	onToolChange: (tool: PrimaryEditTool) => void;
	diameterMm: number;
	onDiameterChange: (mm: number) => void;
	onDiameterPreviewChange?: (active: boolean) => void;
	scissorsOptions: ScissorsOptions;
	onScissorsOptionsChange: (opts: ScissorsOptions) => void;
	scissorsPointCount: number;
	onScissorsCancel: () => void;

	/** Id of whatever class/organ is currently targeted. Not used for editing
	 *  logic here — only watched so the ribbon can deselect the active tool
	 *  when the target changes (see the reset effect below). */
	targetKey: number | null;

	// `onApplied`: one-shot tools (margin, smoothing, islands, logical
	// operators, grow-from-seeds, hollow, ...) call this once their Apply
	// button runs, to deselect the tool (see LIVE_COMMIT_TOOLS for tools that
	// skip this). `onCloseSettings` closes just the settings flyout without
	// deselecting the tool — used by level tracing (auto-close on mode pick)
	// and the guided-overlay tools (close once their full-screen walkthrough
	// takes over).
	renderFlyout: (tool: Exclude<PrimaryEditTool, null>, onApplied: () => void, onCloseSettings: () => void, onGuidedControlsChange: (controls: GuidedFlowControls | null) => void) => React.ReactNode;
	/** Fired whenever a guided slice-anchor pick flow (Copy/Fill across
	 *  slices) becomes active or finishes — true for the flow's entire
	 *  lifecycle (both click steps, the ready-to-apply confirm, and while
	 *  committing), not just the literal picking sub-phase, since the
	 *  crosshair shouldn't be live for any of it: clicking a pane during a
	 *  guided pick is meant to choose a slice/anchor, not move the
	 *  crosshair. The caller (VisualizationPage) uses this to suppress
	 *  Crosshairs for the duration. */
	onGuidedPickingChange?: (active: boolean) => void;

	popupRef?: React.RefObject<HTMLDivElement | null>;
	sliceJumpRef?: React.RefObject<HTMLDivElement | null>;

	/** The pencil/Annotate button in the main toolbar (VisualizationPage)
	 *  that opens this ribbon. The ribbon itself renders as a centered
	 *  popout regardless of where that button sits, but this ref lets it
	 *  draw a small pointer arrow back up to the button — see the
	 *  pointer-tracking effect below and .atb--horizontal__pointer. */
	anchorRef?: React.RefObject<HTMLElement | null>;

	/** False where the model can't be asked at all: an uploaded scan's
	 *  session view has no dataset case for the backend to load, so the
	 *  model tools are left out there instead of doing nothing on a click.
	 *  Defaults to true. */
	modelToolsAvailable?: boolean;

}

// The four model-prompt tools carry an attribution line under their
// tooltips. Its text lives in interactiveAttribution(), which reads the
// weights licence from the running model server (with today's licence as
// the fallback) — the attribution and the licence scope belong right where
// the feature is offered, not buried in a repo file, and they must track
// whatever checkpoint the server actually loaded.
const TOOL_DEFS: Array<{ id: Exclude<PrimaryEditTool, null>; label: string; Icon: typeof IconBrush; description: string; modelAttribution?: boolean }> = [
	{ id: "paint", label: "Brush", Icon: IconBrush, description: "Paint freehand with a round brush." },
	{ id: "erase", label: "Erase", Icon: IconEraser, description: "Erase parts of a shape manually." },
	{ id: "scissors", label: "Scissors", Icon: IconScissors, description: "Lasso tool using anchor points." },
	{ id: "levelTracing", label: "Level tracing", Icon: IconRipple, description: "Traces the boundary of similar intensity around cursor." },
	{ id: "pointSegment", label: "Segment from click", Icon: IconTarget, description: "Click a structure once and the model proposes its full 3D mask.", modelAttribution: true },
	{ id: "boxSegment", label: "Segment from box", Icon: IconBoxAlignTopLeft, description: "Drag a box around a structure on one slice to get its 3D mask.", modelAttribution: true },
	{ id: "scribbleSegment", label: "Segment from scribble", Icon: IconScribble, description: "Draw a quick stroke over a structure and the model segments it in 3D.", modelAttribution: true },
	{ id: "lassoSegment", label: "Segment from lasso", Icon: IconLasso, description: "Circle a structure freehand and the model segments everything inside.", modelAttribution: true },
	{ id: "refineSegment", label: "Refine with model", Icon: IconSparkles, description: "The model redraws the class's outline from its current voxels, with no clicks.", modelAttribution: true },
	{ id: "margin", label: "Margin", Icon: IconArrowsDiagonal, description: "Grow or shrink by a specified margin size." },
	{ id: "smoothing", label: "Smoothing", Icon: IconWaveSine, description: "Smooth class boundaries." },
	{ id: "islands", label: "Islands", Icon: IconDroplet, description: "Edit islands (connected components) in a class." },
	{ id: "logicalOperators", label: "Logical operators", Icon: IconMathFunction, description: "Apply logical operators or combine classes." },
	{ id: "growFromSeeds", label: "Grow from seeds", Icon: IconWand, description: "Grow a class from points you click inside and outside it." },
	{ id: "fillBetweenSlices", label: "Fill between slices", Icon: IconStack2, description: "Interpolate a class's shape between two annotated slices." },
	{ id: "copyAcrossSlices", label: "Copy across slices", Icon: IconCopy, description: "Copy a class's shape from first to last slice." },
	{ id: "hollow", label: "Hollow", Icon: IconCircleDashed, description: "Make the class hollow by replacing it with a uniform-thickness shell." },
];

const SCISSORS_OPERATIONS: { value: ScissorsOperation; label: string }[] = [
	{ value: "eraseInside", label: "Erase inside" },
	{ value: "eraseOutside", label: "Erase outside" },
	{ value: "fillInside", label: "Fill inside" },
	{ value: "fillOutside", label: "Fill outside" },
];

// Tools that don't have an ApplyButton — they commit directly on pointer
// interaction, so the rendering dot is the only feedback available.
const LIVE_COMMIT_TOOLS: Exclude<PrimaryEditTool, null>[] = ["paint", "erase", "scissors", "levelTracing", "pointSegment", "boxSegment", "scribbleSegment", "lassoSegment"];

// The model-prompt tools: equip-and-use like the brush, but no settings
// flyout at all — everything they need is the click/drag gesture itself.
const PROMPT_TOOLS: Exclude<PrimaryEditTool, null>[] = ["pointSegment", "boxSegment", "scribbleSegment", "lassoSegment"];

// Which "explain Continue / Start over / Exit" message a guided tool falls
// under. Grow from Seeds gets its own copy; the slice-range tools (Copy/Fill
// across slices) and Islands' pick-based ops (Remove picked/Keep picked)
// all drive the exact same three controls, so they share one message keyed
// off a single "seen" flag rather than repeating the popup three times.
type GuidedHintGroup = "growSeeds" | "sliceOps";
function guidedHintGroup(tool: PrimaryEditTool): GuidedHintGroup | null {
	if (tool === "growFromSeeds") return "growSeeds";
	if (tool === "copyAcrossSlices" || tool === "fillBetweenSlices" || tool === "islands") return "sliceOps";
	return null;
}
const GUIDED_HINT_COPY: Record<GuidedHintGroup, string> = {
	growSeeds:
		"Continue moves on once you've placed your seed points. Start over clears every seed and lets you begin again. Exit leaves Grow from seeds without changing anything.",
	sliceOps:
		"Start over clears any choices made and lets you pick again. Exit leaves the tool without changing anything.",
};

// Height of the strip under the ribbon that the guided-flow controls hang in
// (the pill is about 45px tall, 6px below the ribbon, and the viewer already
// leaves 10px), kept in --atb-panel-h while that pill is showing. On a phone
// or touch screen its buttons are 36px tall rather than 28px, which makes the
// pill 8px taller, so the strip grows by the same 8px. Keep the query and the
// 8px in step with the .atb-guided__btn touch rule in the CSS.
const GUIDED_STRIP_H = 44;
const GUIDED_STRIP_H_TOUCH = GUIDED_STRIP_H + 8;
const GUIDED_TOUCH_QUERY = "(max-width: 640px), (pointer: coarse)";

// Phone ribbon start fade: a tool group at least this far in from the row's
// edge is shown whole (the 32px scroll padding less the 6px group gap), and
// the gap is that 6px. Keep both in step with .atb__tools in the CSS.
const RIBBON_FADE_MIN = 26;
const RIBBON_GROUP_GAP = 6;

// Ribbon height, matches --atb-ribbon-h in CSS. Exported so SegmentsPopup
// can dock directly beneath the ribbon without duplicating the constant.
export const ANNOTATION_DOCK_WIDTH = 60;

function DiameterFlyout({
	title, diameterMm, onDiameterChange, onPreviewChange, fieldRef,
}: {
	title: string;
	diameterMm: number;
	onDiameterChange: (mm: number) => void;
	onPreviewChange?: (active: boolean) => void;
	/** Wraps the slider field so the walkthrough can spotlight its live rect. */
	fieldRef?: React.RefObject<HTMLDivElement>;
}) {
	return (
		<div className="seg-effect">
			<div ref={fieldRef}>
				<NumberSliderField
					label={title}
					value={diameterMm}
					onChange={onDiameterChange}
					min={MIN_DIAMETER_MM}
					max={MAX_DIAMETER_MM}
					step={0.5}
					unit="mm"
					ariaLabel={title}
					onPreviewChange={onPreviewChange}
				/>
			</div>
		</div>
	);
}

function ScissorsFlyout({ options, onChange, onCloseSettings }: {
	options: ScissorsOptions;
	onChange: (opts: ScissorsOptions) => void;
	pointCount: number;
	onCancel: () => void;
	/** Closes the Scissors settings flyout once an operation is picked;
	 *  scissors itself stays equipped. */
	onCloseSettings: () => void;
}) {
	const set = <K extends keyof ScissorsOptions>(key: K, value: ScissorsOptions[K]) =>
		onChange({ ...options, [key]: value });

	// Brief "picked" state on the row before the settings flyout collapses.
	// onCloseSettings closes whichever tool's settings are open, so the
	// pending close is dropped when this unmounts (Scissors deselected, or
	// another tool picked within the beat, whose flyout it would otherwise
	// shut) and a second pick replaces the first rather than stacking.
	const closeTimerRef = useRef<number | null>(null);
	useEffect(() => () => {
		if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
	}, []);
	const pickOperation = (op: ScissorsOperation) => {
		set("operation", op);
		if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			onCloseSettings();
		}, 320);
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 190 }}>
			<MenuColumn>
				<label className="atb-menu-row atb-menu-row--checkbox" title="Snap each point to the nearest strong intensity edge, like Photoshop's magnetic lasso">
					<span className="atb-menu-row__label">Magnetic snap</span>
					{/* The native input stays (hidden by the stylesheet) for the
					    label's toggling, focus and screen readers; the box beside
					    it is the shared custom checkbox. */}
					<input
						type="checkbox"
						className="atb-menu-row__checkbox-input"
						// Undefined (never touched) reads as ON — the default people
						// want nearly all the time — while an explicit false (user
						// unchecked it) is respected.
						checked={options.magnetEnabled !== false}
						onChange={(e) => set("magnetEnabled", e.target.checked)}
					/>
					<span className={`atb-checkbox-box ${options.magnetEnabled !== false ? "is-checked" : ""}`} aria-hidden="true">
						<IconCheck size={12} stroke={3} className="atb-checkbox-box__check" />
					</span>
				</label>
			</MenuColumn>

			<MenuDivider />

			<MenuColumn role="radiogroup" ariaLabel="Scissors operation">
				{SCISSORS_OPERATIONS.map((op) => (
					<MenuRow
						key={op.value}
						label={op.label}
						radio
						// Reflects `options.operation` directly (not some local
						// "just picked" flag), so re-opening later always shows
						// the operation that's actually active.
						open={op.value === options.operation}
						onClick={() => pickOperation(op.value)}
					/>
				))}
			</MenuColumn>
		</div>
	);
}



// Same box as last time? Lets the live-measured hints skip a state update,
// and the re-render of this whole toolbar, when nothing moved.
function sameRect(a: DOMRect | null, b: DOMRect | null): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

// Gap between a ribbon icon and its tooltip.
const TOOLTIP_GAP = 10;

// A tooltip follows keyboard focus, not focus a closing dialog hands back to
// the button after a mouse click. (Environments without :focus-visible
// support fall back to showing it.)
const isFocusVisible = (el: Element): boolean => {
	try {
		return el.matches(":focus-visible");
	} catch {
		return true;
	}
};

// Portal-rendered tooltip — rendered to document.body and positioned via
// getBoundingClientRect of the hovered icon, so it's never clipped by the
// dock's own overflow:hidden/auto rules.
function IconTooltip({
	id, label, description, attribution, anchorRect,
}: {
	id: string;
	label: string;
	description: string;
	attribution?: string;
	anchorRect: DOMRect | null;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [side, setSide] = useState<"above" | "below">("above");
	// Its height is only known once rendered, so measure before paint and
	// flip below the icon when it would run off the top of the window (the
	// model tools' tooltips carry a licence line and are tall).
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box || !anchorRect) return;
		const topbar = document.querySelector(".vp-topbar");
		const ceiling = topbar ? Math.max(0, topbar.getBoundingClientRect().bottom) : 0;
		const next = tooltipSide(anchorRect, box.offsetHeight, window.innerHeight, undefined, undefined, ceiling);
		if (next !== side) setSide(next);
	}, [anchorRect, label, description, attribution, side]);
	if (!anchorRect) return null;
	// Tooltip is centered above its icon by default (so it reads as an
	// annotation on the icon rather than colliding with whatever settings
	// flyout opens below the ribbon), but that puts it offscreen for icons
	// near either edge (Brush on the left, Hollow on the right) — clamp the
	// center point so the box (max-width 240) always stays fully within the
	// viewport, with a small margin.
	const halfWidth = 120;
	const margin = 8;
	const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
	const idealCenter = anchorRect.left + anchorRect.width / 2;
	const clampedCenter = Math.min(
		Math.max(idealCenter, halfWidth + margin),
		viewportWidth - halfWidth - margin
	);
	return createPortal(
		<div
			ref={boxRef}
			id={id}
			role="tooltip"
			className="atb-icon-tip"
			style={{
				top: side === "above" ? anchorRect.top - TOOLTIP_GAP : anchorRect.bottom + TOOLTIP_GAP,
				left: clampedCenter,
				transform: side === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)",
			}}
		>
			<div className="atb-icon-tip__label">{label}</div>
			<div className="atb-icon-tip__desc">{description}</div>
			{attribution && <div className="atb-icon-tip__attribution">{attribution}</div>}
		</div>,
		document.body
	);
}

export default function AnnotationToolbar({
	open, hasSegments, hasActiveTarget, activeTool, onToolChange,
	diameterMm, onDiameterChange, onDiameterPreviewChange, scissorsOptions, onScissorsOptionsChange,
	renderFlyout, scissorsPointCount, onScissorsCancel,
	targetKey,
	popupRef, onGuidedPickingChange, anchorRef, modelToolsAvailable = true,
}: AnnotationToolbarProps) {
	// The hovered tool and its anchor rect live in one object so leaving one
	// tile can never null the rect that the next tile's enter just queued.
	const [hover, setHover] = useState<{ id: string; rect: DOMRect | null } | null>(null);
	const hoveredTool = hover?.id ?? null;
	const tipIdBase = useId();
	// Fetch the live licence string once so the model-tool tooltips show what
	// the running server actually reports rather than only the fallback.
	useEffect(() => primeInteractiveLicense(), []);
	const modelCaps = useInteractiveCapabilities();
	const iconRefs = useRef<Record<string, HTMLElement | null>>({});
	// Just the icon <button> itself, keyed the same as iconRefs — needed
	// only for LIVE_COMMIT_TOOLS, whose wrapper div also contains the
	// separate FlyoutArrow chevron beside the icon. Anchoring the settings
	// flyout to that wrapper (as iconRefs alone would) meant the computed
	// center included the arrow's own width, so the flyout's pointer sat
	// visibly right of the icon's true center instead of directly under
	// it. Anchoring to the icon button alone keeps the pointer centered on
	// the icon regardless of the arrow sitting beside it.
	const btnRefs = useRef<Record<string, HTMLElement | null>>({});

	// --- Hints -----------------------------------------------------------------
	// "Pick a class first" hint — shown when a disabled tool icon is clicked
	// (disabled buttons don't fire onClick, so this replaces that silent no-op).
	const [pickClassHintOpen, setPickClassHintOpen] = useState(false);
	const [pickClassHintRect, setPickClassHintRect] = useState<DOMRect | null>(null);
	// "Explain Continue/Start over/Exit" — shown the first time a guided flow
	// (Grow from Seeds, Copy/Fill-across-slices, Islands' pick ops) actually
	// surfaces those controls, once per flow family per session.
	const [guidedHintOpen, setGuidedHintOpen] = useState(false);
	const [guidedHintRect, setGuidedHintRect] = useState<DOMRect | null>(null);
	const [guidedHintText, setGuidedHintText] = useState<string>("");
	const guidedControlsBoxRef = useRef<HTMLDivElement>(null);
	const prevGuidedControlsRef = useRef<GuidedFlowControls | null>(null);

	const fieldRef = useRef<HTMLDivElement>(null);
	const panelBodyRef = useRef<HTMLDivElement>(null);
	// Unstyled inner wrapper measured for --atb-panel-h (see JSX usage below
	// for why measuring the styled body directly caused runaway growth).
	const panelBodyContentRef = useRef<HTMLDivElement>(null);
	const dockElRef = useRef<HTMLDivElement>(null);
	// Unstyled inner wrapper measured for --atb-ribbon-h. Observing the
	// styled dock element itself (which has `min-height: var(--atb-ribbon-h)`)
	// would be self-referential and grow without bound.
	const dockContentRef = useRef<HTMLDivElement>(null);

	// Measures the ribbon's real height into --atb-ribbon-h (consumed by
	// VisualizationPage.css to reserve space above the CT viewport), since a
	// hardcoded value drifts as row contents change.
	// useLayoutEffect so it lands before paint, avoiding a one-frame flash of
	// the CSS fallback height. Math.ceil + 1px pad absorbs sub-pixel rounding.
	useLayoutEffect(() => {
		const el = dockContentRef.current;
		if (!el) return;
		const sync = () => {
			// The wrapper sits inside the ribbon's padding and border, so add
			// those back: the viewer reserves the ribbon's full height, else a
			// ribbon that wraps to two rows overlaps the stage below it.
			const dock = dockElRef.current;
			const cs = dock ? getComputedStyle(dock) : null;
			const chrome = cs
				? parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
					+ parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
				: 0;
			const h = Math.ceil(el.getBoundingClientRect().height + (chrome || 0)) + 1;
			document.documentElement.style.setProperty("--atb-ribbon-h", `${h}px`);
		};
		sync();
		const ro = new ResizeObserver(sync);
		ro.observe(el);
		return () => ro.disconnect();
		// `open` is a dependency (not `[]`) so this re-runs and picks up the
		// real element once the ribbon actually mounts.
	}, [open]);

	// On a phone the icon row scrolls sideways with most tools out of sight
	// and no scrollbar, so the edges that still have tools beyond them are
	// flagged here and CSS fades those edges (a half-cut tile alone reads as
	// a rendering glitch). Both stay false whenever the row fits. The start
	// fade also hides whatever tool group the edge cuts (--atb-fade-hide, see
	// the CSS): the furthest scroll cannot be moved on to a group start, so
	// there the cut group would otherwise show as a half tile or lone chevron.
	// That strip is only measured once the row rests. Measured on every scroll
	// event it jumped a whole group at a time mid-drag, so whole tiles popped
	// out; while the row moves the plain 26px fade applies.
	const toolsRef = useRef<HTMLDivElement>(null);
	const [toolsMore, setToolsMore] = useState({ start: false, end: false });
	useLayoutEffect(() => {
		const el = toolsRef.current;
		if (!el) return;
		let settleTimer = 0;
		const flag = () => {
			const start = el.scrollLeft > 1;
			const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
			setToolsMore((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
			return start;
		};
		const measureStrip = (start: boolean) => {
			window.clearTimeout(settleTimer);
			const rowLeft = el.getBoundingClientRect().left;
			const hidden = start
				? ribbonHiddenStrip(Array.from(el.children, (child) => child.getBoundingClientRect().left - rowLeft), RIBBON_FADE_MIN, RIBBON_GROUP_GAP)
				: null;
			if (hidden === null) el.style.removeProperty("--atb-fade-hide");
			else el.style.setProperty("--atb-fade-hide", `${hidden}px`);
		};
		const sync = () => measureStrip(flag());
		const onScroll = () => {
			flag();
			el.style.removeProperty("--atb-fade-hide");
			// scrollend settles it where supported; the timer covers the rest.
			window.clearTimeout(settleTimer);
			settleTimer = window.setTimeout(sync, 150);
		};
		sync();
		el.addEventListener("scroll", onScroll, { passive: true });
		el.addEventListener("scrollend", sync);
		const ro = new ResizeObserver(() => sync());
		ro.observe(el);
		// Tools come and go with the model's capabilities without resizing the row.
		const mo = new MutationObserver(() => sync());
		mo.observe(el, { childList: true });
		return () => {
			window.clearTimeout(settleTimer);
			el.removeEventListener("scroll", onScroll);
			el.removeEventListener("scrollend", sync);
			ro.disconnect();
			mo.disconnect();
		};
	}, [open]);

	// Pointer-arrow tracking — keeps the little up-chevron
	// (.atb--horizontal__pointer) aligned under the pencil button and just
	// above the ribbon, regardless of where the screen-centered ribbon or
	// the button end up (window resizes, sidebar open/close reflowing the
	// main toolbar, etc). Stored as fixed viewport coordinates (not an
	// offset within the ribbon) since the chevron is rendered as a sibling
	// of the ribbon — see the render comment below for why. `null` hides
	// the chevron entirely rather than falling back to a guessed position,
	// since a wrong guess would point at nothing.
	// Size of the little rotated-square notch below, so the position math
	// and the CSS agree on how far it should straddle the ribbon's own
	// top border (half on each side, same technique FlyoutPrimitives uses
	// for `.atb-pop__pointer`).
	const POINTER_NOTCH_SIZE = 10;
	const [pointerPos, setPointerPos] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		// Closed: keep the last position so the notch can fade out with the
		// ribbon (is-closed hides it once the fade ends); the next open
		// re-measures here before paint.
		if (!open) return;
		const sync = () => {
			const anchorEl = anchorRef?.current;
			const ribbonEl = dockElRef.current;
			if (!anchorEl || !ribbonEl) { setPointerPos(null); return; }
			const anchorRect = anchorEl.getBoundingClientRect();
			const ribbonRect = ribbonEl.getBoundingClientRect();
			const anchorCenterX = anchorRect.left + anchorRect.width / 2;
			// Clamped inside the ribbon's own horizontal bounds (with a
			// little inset) so a pencil button sitting far to one side
			// never pushes the notch off the ribbon's rounded corner.
			const left = Math.min(
				Math.max(anchorCenterX, ribbonRect.left + 14),
				ribbonRect.right - 14,
			);
			// Sits ON the ribbon's own top border (straddling it, half
			// above/half below) rather than floating free in the gap
			// above the ribbon — this is what actually reads as "grown
			// out of the ribbon" the way FlyoutPanel's own pointer grows
			// out of a settings flyout, instead of a separate decoration
			// hovering between the button and the ribbon with visible
			// space on both sides.
			setPointerPos({ left, top: ribbonRect.top - POINTER_NOTCH_SIZE / 2 });
		};
		sync();
		window.addEventListener("resize", sync);
		// Anchor and ribbon can both move without a window resize (e.g. the
		// AI sidebar toggling shifts the main toolbar's layout), so re-check
		// on any observed size change of either element too.
		const ro = new ResizeObserver(sync);
		if (anchorRef?.current) ro.observe(anchorRef.current);
		if (dockElRef.current) ro.observe(dockElRef.current);
		// The top bar can wrap (a REC pill joining it on a narrow window) and
		// move the fixed ribbon down without resizing the pencil or the ribbon.
		const topbarEl = anchorRef?.current?.closest(".vp-topbar");
		if (topbarEl) ro.observe(topbarEl);
		return () => {
			window.removeEventListener("resize", sync);
			ro.disconnect();
		};
	}, [open, anchorRef]);

	// Settings flyout — the small rectangle that opens under a tool's arrow.
	// Only one tool's settings are open at a time, always for whichever tool
	// is active. Guided-overlay tools (Grow-from-Seeds, Fill/Copy-Across-
	// Slices) render `keepMounted` (see GUIDED_OVERLAY_TOOLS above), so an
	// outside click here just hides the box without tearing down their state.
	// Mirrored into a ref so the outside-click handler below (created before
	// `guidedControls` state exists in source order) always reads the latest
	// published guided flow.
	const guidedControlsRef = useRef<GuidedFlowControls | null>(null);

	const toolFlyout = useFlyout(false, {
		scope: "top",
		// Outside click = full deselect for most tools. For a guided-overlay
		// tool, route through its own Exit handler so scribbles/anchors/picks
		// get cleared too. LIVE_COMMIT_TOOLS (brush, erase, scissors, level
		// tracing/"smart fill") are the exception: an outside click there
		// should only close the settings flyout — the icon stays selected
		// (white background) because the tool itself is still "live" and
		// ready to paint/cut on the next pointer interaction.
		onOutsideClose: () => {
			if (guidedControlsRef.current) {
				guidedControlsRef.current.onExit();
				return;
			}
			if (activeTool && LIVE_COMMIT_TOOLS.includes(activeTool)) return;
			onToolChange(null);
		},
	});

	// This component stays mounted while the toolbar is toggled off (see
	// `if (!open) return null` further down), so state has to be reset
	// explicitly on close — otherwise the flyout reopens anchored to a
	// stale/detached icon ref, and the active tool stays visually selected.
	useEffect(() => {
		if (open) return;
		// Exit any running guided flow so placed seeds/anchors/picks clear.
		guidedControlsRef.current?.onExit();
		toolFlyout.setOpen(false);
		toolFlyout.anchorRef.current = null;
		setGuidedControls(null);
		setHover(null);
		// The hint is non-modal, so the pencil can close the ribbon while it is
		// showing; drop it so it doesn't reappear on its own at the next open.
		setPickClassHintOpen(false);
		setPickClassHintRect(null);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Same reset, triggered by the TARGET changing (e.g. clicking a
	// different class) instead of the toolbar closing. Tracked via a ref so
	// this only fires on an actual change, not on first mount.
	const prevTargetKeyRef = useRef(targetKey);
	useEffect(() => {
		if (prevTargetKeyRef.current === targetKey) return;
		prevTargetKeyRef.current = targetKey;
		if (!open) return; // the toolbar-closed effect above already covers this case
		guidedControlsRef.current?.onExit();
		toolFlyout.setOpen(false);
		setGuidedControls(null);
		setHover(null);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [targetKey, open]);

	const openToolSettings = (tool: Exclude<PrimaryEditTool, null>) => {
		if (!hasSegments || !hasActiveTarget) return;
		if (activeTool !== tool) onToolChange(tool);
		// LIVE_COMMIT_TOOLS anchor to their own icon button (btnRefs) so
		// the flyout centers on the icon, not the wider icon+arrow
		// wrapper — see the btnRefs comment above for why.
		toolFlyout.anchorRef.current = btnRefs.current[tool] ?? iconRefs.current[tool] ?? null;
		toolFlyout.setOpen(true);
	};
	const showTooltip = useCallback((id: string) => {
		const el = iconRefs.current[id];
		setHover({ id, rect: el ? el.getBoundingClientRect() : null });
	}, []);
	const hideTooltip = useCallback((id: string) => {
		setHover((cur) => (cur?.id === id ? null : cur));
	}, []);


	// The popup can be dragged, so there's no single event to hook:
	// recompute on a short interval plus resize/scroll while the hint is
	// showing. Only a box that actually moved is stored, so the polling
	// doesn't re-render this whole toolbar five times a second.
	useLayoutEffect(() => {
		if (!pickClassHintOpen) return;
		const measure = () => {
			const next = popupRef?.current ? popupRef.current.getBoundingClientRect() : null;
			setPickClassHintRect((prev) => (sameRect(prev, next) ? prev : next));
		};
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const id = window.setInterval(measure, 200);
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			window.clearInterval(id);
		};
	}, [pickClassHintOpen, popupRef]);

	// The hint exists to explain why a click didn't do anything — once a
	// class actually gets picked there's nothing left to explain, so don't
	// make the person also remember to dismiss it themselves.
	useEffect(() => {
		if (hasActiveTarget) setPickClassHintOpen(false);
	}, [hasActiveTarget]);

	const dismissPickClassHint = useCallback(() => setPickClassHintOpen(false), []);

	const enabled = hasSegments && hasActiveTarget;

	// LIVE_COMMIT_TOOLS (paint/erase/scissors/level tracing) are "equip and
	// use" tools — clicking them just arms the tool, same as before, and they
	// stay equipped until something else is picked. Every other tool
	// (margin, smoothing, islands, logical operators, grow-from-seeds,
	// hollow, fill/copy across slices) is "click once, configure, apply" —
	// clicking the icon should immediately open its settings flyout right
	// there, the same way clicking Margin already opened its column of
	// options, instead of requiring a second click on the little arrow.
	const selectTool = (tool: Exclude<PrimaryEditTool, null>) => {
		if (!enabled) return;
		if (activeTool === tool) {
			// Clicking the already-active tool again toggles it off entirely
			// (and closes whatever settings were open for it). For a guided
			// flow (Grow-from-Seeds, Fill/Copy-Across-Slices, Islands' pick
			// ops) this needs to be a real Exit — not just a deselect — so
			// any placed seeds/anchors/picks are cleared the same way they
			// would be if Exit had been pressed directly, rather than being
			// silently left behind for the next time this tool is opened.
			if (guidedControlsRef.current) { guidedControlsRef.current.onExit(); return; }
			toolFlyout.setOpen(false);
			onToolChange(null);
			return;
		}
		if (LIVE_COMMIT_TOOLS.includes(tool)) {
			toolFlyout.setOpen(false);
			onToolChange(tool);
		} else {
			openToolSettings(tool);
		}
	};

	// Exit / Start over / Continue for whatever guided modal flow
	// (Grow-from-seeds, Copy/Fill-across-slices, Islands' pick ops) is
	// currently running, published up by the tool itself — rendered as
	// fixed black/white buttons in the ribbon below so they're always in
	// the same place regardless of which guided tool is active, instead of
	// each tool floating its own controls over the canvas.
	const [guidedControls, setGuidedControls] = useState<GuidedFlowControls | null>(null);
	useEffect(() => {
		guidedControlsRef.current = guidedControls;
	}, [guidedControls]);
	useEffect(() => {
		onGuidedPickingChange?.(guidedControls != null);
	}, [guidedControls, onGuidedPickingChange]);

	// The pill's buttons unmount as the flow moves on (Exit, Continue giving
	// way to the next step, the buttons becoming "Applying…"), and the browser
	// drops focus to <body> with them. Track whether keyboard focus was inside
	// the pill, and hand it to whatever replaces the button it was on. A
	// pointer press elsewhere or focus landing elsewhere clears the flag, so a
	// click on the canvas is never followed by focus jumping back here.
	const guidedFocusInsideRef = useRef(false);
	const lastGuidedToolRef = useRef<PrimaryEditTool>(null);
	useEffect(() => {
		const inside = (t: EventTarget | null) => t instanceof Node && !!guidedControlsBoxRef.current?.contains(t);
		const onFocusIn = (e: FocusEvent) => { guidedFocusInsideRef.current = inside(e.target); };
		const onPointerDown = (e: PointerEvent) => { if (!inside(e.target)) guidedFocusInsideRef.current = false; };
		document.addEventListener("focusin", onFocusIn, true);
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("focusin", onFocusIn, true);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, []);
	const guidedPresent = !!guidedControls;
	const guidedBusy = !!guidedControls?.busy;
	const guidedHasContinue = !!guidedControls?.onContinue;
	useLayoutEffect(() => {
		if (guidedPresent) lastGuidedToolRef.current = activeTool;
		if (!guidedFocusInsideRef.current) return;
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected) return;
		const box = guidedControlsBoxRef.current;
		let next: HTMLElement | null = null;
		if (guidedPresent && box) {
			next = guidedBusy ? box : box.querySelector<HTMLElement>(".atb-guided__btn--exit, .atb-guided__btn--startover");
		} else if (lastGuidedToolRef.current) {
			next = iconRefs.current[lastGuidedToolRef.current]?.querySelector<HTMLElement>("button.atb__btn") ?? null;
		}
		if (!next?.isConnected) { guidedFocusInsideRef.current = false; return; }
		next.focus({ preventScroll: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [guidedPresent, guidedBusy, guidedHasContinue]);

	// The per-tool settings panel floats over the viewer (anchored under
	// whichever icon opened it — see `toolFlyout` below), so it never needs
	// to reserve space below the ribbon. The one exception is the strip the
	// guided-flow controls (.atb-guided) hang in: it is reserved for exactly
	// as long as that pill is rendered, so choosing a guided-capable tool
	// does not leave an empty band or shift the panes before the flow starts.
	const guidedStripReserved = open && !!guidedControls;
	const [guidedTouch, setGuidedTouch] = useState(
		() => typeof window.matchMedia === "function" && window.matchMedia(GUIDED_TOUCH_QUERY).matches,
	);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mq = window.matchMedia(GUIDED_TOUCH_QUERY);
		const sync = () => setGuidedTouch(mq.matches);
		sync();
		mq.addEventListener?.("change", sync);
		return () => mq.removeEventListener?.("change", sync);
	}, []);
	useEffect(() => {
		const stripH = guidedTouch ? GUIDED_STRIP_H_TOUCH : GUIDED_STRIP_H;
		document.documentElement.style.setProperty("--atb-panel-h", guidedStripReserved ? `${stripH}px` : "0px");
		return () => { document.documentElement.style.setProperty("--atb-panel-h", "0px"); };
	}, [guidedStripReserved, guidedTouch]);

	// Small non-blocking hint shown right next to the cursor when Continue
	// is clicked while `continueDisabled` — e.g. "Mark at least one point
	// first" for Grow-from-seeds before any seed scribble exists. Cleared
	// automatically after a beat, and any time the guided flow becomes
	// unblocked or exits.
	const [continueBlockedHint, setContinueBlockedHint] = useState<{ x: number; y: number; message: string } | null>(null);
	const continueBlockedHintTimeoutRef = useRef<number | null>(null);
	useEffect(() => {
		if (!guidedControls?.continueDisabled) setContinueBlockedHint(null);
	}, [guidedControls?.continueDisabled]);
	useEffect(() => () => {
		if (continueBlockedHintTimeoutRef.current != null) window.clearTimeout(continueBlockedHintTimeoutRef.current);
	}, []);
	useEffect(() => {
		if (!activeTool) setGuidedControls(null);
	}, [activeTool]);

	// Fires once, on the null -> present transition (not on every re-render
	// while a flow is already running), the first time this session that a
	// given guided-flow family actually shows its Continue/Start over/Exit
	// controls. Skipped while `busy` — those controls aren't on screen yet
	// (see the `guidedControls.busy` branch in the render below).
	useEffect(() => {
		const wasPresent = prevGuidedControlsRef.current;
		prevGuidedControlsRef.current = guidedControls;
		if (wasPresent || !guidedControls || guidedControls.busy) return;
		const group = guidedHintGroup(activeTool);
		if (!group || !activeTool) return;
		// Per-tool key (not per-group) — Grow from Seeds having been seen
		// shouldn't suppress the explainer for Copy across slices, Fill
		// between slices, or Islands, and vice versa between those three.
		const seenKey = `${GUIDED_HINT_SEEN_KEY_PREFIX}${activeTool}`;
		let alreadySeen = false;
		try {
			alreadySeen = typeof window !== "undefined" && window.sessionStorage.getItem(seenKey) === "1";
		} catch { /* sessionStorage unavailable — just show it */ }
		if (alreadySeen) return;
		setGuidedHintText(GUIDED_HINT_COPY[group]);
		setGuidedHintOpen(true);
		try {
			if (typeof window !== "undefined") window.sessionStorage.setItem(seenKey, "1");
		} catch { /* not worth blocking on */ }
	}, [guidedControls, activeTool]);

	// Once the flow's controls go away (tool exited/deselected) or flip into
	// `busy` (buttons swap for the "Applying…" indicator), the hint no
	// longer has anything to point at, so close it automatically.
	useEffect(() => {
		if (!guidedControls || guidedControls.busy) setGuidedHintOpen(false);
	}, [guidedControls]);

	// The explainer waits for any step card to be acknowledged (both are
	// "Got it" dialogs, and stacking them made two dismissals in a row). If a
	// later step card opens while it is already showing, the person has
	// moved on, so it closes rather than popping back afterwards.
	const stepModalOpen = useGuidedStepModalOpen();
	const guidedHintShown = guidedHintOpen && !stepModalOpen;
	const guidedHintSeenRef = useRef(false);
	useEffect(() => {
		if (!guidedHintOpen) { guidedHintSeenRef.current = false; return; }
		if (stepModalOpen) {
			if (guidedHintSeenRef.current) setGuidedHintOpen(false);
			return;
		}
		// Not "seen" until it has stayed up a beat: the flow's first step
		// card mounts in the same tick that arms the explainer.
		const t = window.setTimeout(() => { guidedHintSeenRef.current = true; }, 120);
		return () => window.clearTimeout(t);
	}, [guidedHintOpen, stepModalOpen]);

	useLayoutEffect(() => {
		if (!guidedHintShown) return;
		const measure = () => {
			const next = guidedControlsBoxRef.current ? guidedControlsBoxRef.current.getBoundingClientRect() : null;
			setGuidedHintRect((prev) => (sameRect(prev, next) ? prev : next));
		};
		measure();
		window.addEventListener("resize", measure);
		window.addEventListener("scroll", measure, true);
		const id = window.setInterval(measure, 200); // controls sit in a fixed ribbon, but keep parity with the other live-measured hints
		return () => {
			window.removeEventListener("resize", measure);
			window.removeEventListener("scroll", measure, true);
			window.clearInterval(id);
		};
	}, [guidedHintShown]);

	const dismissGuidedHint = useCallback(() => setGuidedHintOpen(false), []);

	// Both hint cards point at controls outside themselves (the class list,
	// the guided flow buttons), so focus lands on "Got it" without being
	// trapped there, and Escape closes the card without also disarming the tool.
	const pickHintRef = useRef<HTMLDivElement>(null);
	const pickHintBtnRef = useRef<HTMLButtonElement>(null);
	const pickHintTextId = useId();
	useDialogFocus(open && pickClassHintOpen && !!pickClassHintRect, pickHintRef, {
		initialFocus: pickHintBtnRef,
		onEscape: dismissPickClassHint,
		lockScroll: false,
		trapFocus: false,
	});
	const guidedHintRef = useRef<HTMLDivElement>(null);
	const guidedHintBtnRef = useRef<HTMLButtonElement>(null);
	const guidedHintTextId = useId();
	useDialogFocus(open && guidedHintShown && !!guidedHintRect, guidedHintRef, {
		initialFocus: guidedHintBtnRef,
		onEscape: dismissGuidedHint,
		lockScroll: false,
		trapFocus: false,
	});

	// On a phone the fade above washes out whatever tile sits at an edge, and
	// picking a tool (or opening it from a sheet or shortcut) can leave the
	// active one right there, so bring it to the middle of the scrolling row.
	// The row is scrolled directly, not with scrollIntoView, so nothing
	// outside it ever moves; when the row fits (wider screens) there is
	// nothing to scroll and this does nothing. The centred position is then
	// moved on to the nearest tool-group start (as far in as the CSS scroll
	// padding), so the neighbour is either whole or wholly under the fade
	// instead of leaving its settings chevron peeking in at the edge.
	useEffect(() => {
		const row = toolsRef.current;
		const icon = activeTool ? iconRefs.current[activeTool] : null;
		if (!open || !row || !icon || row.scrollWidth <= row.clientWidth) return;
		const rowRect = row.getBoundingClientRect();
		const iconRect = icon.getBoundingClientRect();
		const shift = iconRect.left + iconRect.width / 2 - (rowRect.left + rowRect.width / 2);
		const padding = parseFloat(getComputedStyle(row).scrollPaddingLeft) || 0;
		const starts = Array.from(row.children, (el) => row.scrollLeft + el.getBoundingClientRect().left - rowRect.left - padding);
		const left = snapRibbonScroll(row.scrollLeft + shift, starts, row.scrollWidth - row.clientWidth);
		if (Math.abs(left - row.scrollLeft) > 1) row.scrollTo({ left });
	}, [open, activeTool, toolFlyout.open]);

	// Signals "applied" from one-shot tool flyouts — closes settings and
	// clears the tool's active highlight, same as clicking the icon again.
	const handleToolApplied = useCallback(() => {
		toolFlyout.setOpen(false);
		onToolChange(null);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [onToolChange]);

	// Keyboard access: the ribbon is portaled to the end of <body>, so left
	// alone it is the last thing Tab reaches. Opening it from the pencil moves
	// focus to its first tool, and Tab runs from the pencil into the ribbon and
	// out of its last control to whatever follows the pencil, as if the ribbon
	// sat right after it (the same hand-off FlyoutPanel does for its panels).
	// The Segments panel is the other half of the ribbon (every tool stays off
	// until a class is targeted there), so it sits in the same ring: out of the
	// ribbon's last control into the panel's first, and out of the panel's last
	// control to what follows the pencil. Shift+Tab out of the first control
	// goes back to the pencil, and out of the panel's first to the ribbon's last.
	const wasOpenRef = useRef(open);
	useEffect(() => {
		const justOpened = open && !wasOpenRef.current;
		wasOpenRef.current = open;
		if (!justOpened) return;
		const anchor = anchorRef?.current;
		const active = document.activeElement;
		const dock = dockElRef.current;
		if (!anchor || !dock || !(active instanceof Node) || !anchor.contains(active)) return;
		focusableWithin(dock)[0]?.focus({ preventScroll: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	// Closing while focus is inside (a letter shortcut or Escape from a ribbon
	// tool) would otherwise leave it on a control that is about to go inert and
	// hidden, so it drops to <body>. Hand it back to the pencil first; this runs
	// in a layout effect so it lands before the browser's inert focus fix-up.
	// A tool's settings flyout and the Segments panel are portaled out of the
	// shell, so focus inside either (the size slider Brush moves focus to, or a
	// class row reached by Tab) counts as inside the ribbon too.
	useLayoutEffect(() => {
		if (open) return;
		const anchor = anchorRef?.current;
		const shell = dockElRef.current?.closest(".atb-shell");
		const active = document.activeElement;
		if (!anchor || !shell || !anchor.isConnected || !(active instanceof Node)) return;
		if (!shell.contains(active) && !toolFlyout.panelRef.current?.contains(active) && !popupRef?.current?.contains(active)) return;
		if (anchor instanceof HTMLButtonElement && anchor.disabled) return;
		anchor.focus({ preventScroll: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || e.defaultPrevented) return;
			const anchor = anchorRef?.current;
			const dock = dockElRef.current;
			const active = document.activeElement;
			if (!anchor || !dock || !(active instanceof HTMLElement)) return;
			const items = focusableWithin(dock);
			if (items.length === 0) return;
			const popup = popupRef?.current ?? null;
			const panelItems = popup ? focusableWithin(popup) : [];
			const afterAnchor = () => {
				const order = focusableWithin(document.body).filter((el) => !dock.contains(el) && !popup?.contains(el));
				const at = order.indexOf(anchor);
				return at >= 0 ? order[at + 1] : undefined;
			};
			if (!e.shiftKey && active === anchor) {
				e.preventDefault();
				items[0].focus({ preventScroll: true });
			} else if (e.shiftKey && active === items[0]) {
				e.preventDefault();
				anchor.focus({ preventScroll: true });
			} else if (!e.shiftKey && active === items[items.length - 1]) {
				const next = panelItems[0] ?? afterAnchor();
				if (!next) return;
				e.preventDefault();
				next.focus({ preventScroll: true });
			} else if (e.shiftKey && panelItems.length > 0 && active === panelItems[0]) {
				e.preventDefault();
				items[items.length - 1].focus({ preventScroll: true });
			} else if (!e.shiftKey && panelItems.length > 0 && active === panelItems[panelItems.length - 1]) {
				const next = afterAnchor();
				if (!next) return;
				e.preventDefault();
				next.focus({ preventScroll: true });
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const activeDef = activeTool ? TOOL_DEFS.find((t) => t.id === activeTool) : null;
	// Portal straight to <body>: VisualizationPage's root has
	// overflow:hidden, which clips fixed-position descendants' paint.
	if (typeof document === "undefined") return null;
	// Stays mounted always and lets CSS (is-open/is-closed) animate it,
	// instead of `open` gating a hard unmount that couldn't animate out.
	return createPortal(
		<>
		{/* Connects the ribbon back to the pencil button that opened it —
			now built the exact same way FlyoutPanel connects its own
			settings panels to the icon/row that spawned them (see
			`.atb-pop__pointer` in FlyoutPrimitives.css): a small square,
			rotated 45°, colored and bordered to match the ribbon itself,
			straddling the ribbon's own top edge so it visibly grows out
			of the ribbon's shape instead of floating as a separate glyph
			in the gap above it (which is what the plain IconChevronUp
			here used to do, and why it never read as "connected").

			Rendered as a SIBLING of `.atb-shell` (not a descendant of it)
			for the same reason as before: `.atb-shell` carries a CSS
			`transform` for its open/close slide + centering, and per spec
			any transformed ancestor becomes the containing block for its
			`position: fixed` descendants — a notch nested inside it would
			have its "fixed" left/top resolved against the shell's own
			box, not the viewport, even though pointerPos below is real
			viewport coordinates from getBoundingClientRect(). Only
			rendered once we have a real measured position, so it never
			flashes at a wrong default location. */}
		{pointerPos !== null && (
			<div
				className={`atb--horizontal__pointer ${open ? "is-open" : "is-closed"}`}
				style={{ left: pointerPos.left, top: pointerPos.top }}
				aria-hidden="true"
			/>
		)}
		{/* inert while closed: the faded-out ribbon (and any settings panel
		    inside it) stays mounted for its exit animation, but can't be
		    tabbed to, clicked or read out. */}
		<div className={`atb-shell ${open ? "is-open" : "is-closed"}`} inert={!open}>
		<div
			ref={dockElRef}
			className={`atb atb--horizontal ${!enabled ? "atb--disabled" : ""}`}
			role="toolbar"
			aria-label="Annotation tools"
			aria-orientation="horizontal"
		>
			<div ref={dockContentRef} className="atb__content">
			<div
				ref={toolsRef}
				className="atb__tools"
				data-more-start={toolsMore.start || undefined}
				data-more-end={toolsMore.end || undefined}
			>
				{TOOL_DEFS.filter(({ id, modelAttribution }) => modelToolOffered(id, modelCaps) && (modelToolsAvailable || !modelAttribution)).map(({ id, label, Icon, description, modelAttribution }) => {
					// Only equip-and-use tools (paint/erase/scissors/level tracing)
					// get a settings arrow; other tools open settings on icon click.
					const hasSettingsArrow =
						LIVE_COMMIT_TOOLS.includes(id) && !PROMPT_TOOLS.includes(id);
					const settingsOpenHere = toolFlyout.open && activeTool === id;
					// The tip is only in the page while it shows, so the button
					// points at it only then; that puts the description and the
					// licence line in the button's accessible description.
					const tipShown = hoveredTool === id && !toolFlyout.open && !!hover?.rect;
					const tipId = `${tipIdBase}-tip-${id}`;
					return (
						<div
							key={id}
							ref={(el) => { iconRefs.current[id] = el; }}
							style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
							// A touch tap fires an emulated mouseenter that no mouseleave
							// follows until the next tap elsewhere, which left the tip
							// stuck over the flyout it had just opened. Only a real
							// pointer hover (or keyboard focus) shows it.
							onPointerEnter={(e) => { if (e.pointerType !== "touch") showTooltip(id); }}
							onMouseLeave={() => hideTooltip(id)}
						>
							<button
								ref={(el) => { if (hasSettingsArrow) btnRefs.current[id] = el; }}
								className={`atb__btn ${activeTool === id ? "is-active" : ""}`}
								onClick={() => { hideTooltip(id); if (enabled) selectTool(id); else setPickClassHintOpen(true); }}
								aria-label={label}
								aria-pressed={activeTool === id}
								aria-disabled={!enabled}
								aria-describedby={tipShown ? tipId : undefined}
								onFocus={(e) => { if (isFocusVisible(e.currentTarget)) showTooltip(id); }}
								onBlur={() => hideTooltip(id)}
							>
								<Icon size={20} />
							</button>
							{hasSettingsArrow && (
								<FlyoutArrow
									open={settingsOpenHere}
									onClick={() => {
										// Mirrors the main icon button's disabled-click handling above:
										// the arrow previously called openToolSettings unconditionally,
										// even when `enabled` was false, silently opening a tool's
										// settings flyout with no class selected. Route it through the
										// same "pick a class first" walkthrough popout instead.
										if (!enabled) { setPickClassHintOpen(true); return; }
										if (settingsOpenHere) toolFlyout.setOpen(false);
										else openToolSettings(id);
									}}
									label={`${label} settings`}
								/>
							)}
							{hoveredTool === id && !toolFlyout.open && (
								<IconTooltip
									id={tipId}
									label={label}
									description={
										!hasSegments
											? `${description} Create a class first.`
											: !hasActiveTarget
												? `${description} Pick a class first.`
												: description
									}
									attribution={modelAttribution ? interactiveAttribution() : undefined}
									anchorRect={hover?.rect ?? null}
								/>
							)}
						</div>
					);
				})}
			</div>

			{/* Exit / Start over / Continue for the running guided flow
			    (Grow-from-seeds, Copy/Fill-across-slices, Islands) — an overlay
			    hanging under the ribbon, out of its measured height. No title/label text
			    identifying which guided flow is running is shown here — just
			    the controls themselves (see guidedControlsBoxRef below, used
			    only to anchor the one-time Continue/Start over/Exit explainer
			    popup, not for a visible label). */}
			{guidedControls && (
				<div
					ref={guidedControlsBoxRef}
					className="atb-guided"
					tabIndex={-1}
				>
					{/* Local, self-contained keyframes for the Continue button's
					    glow-pulse below — kept here rather than in the shared
					    stylesheet since it's only ever used by this one button. */}
					<style>{`
						@keyframes seg-effect-continue-pulse {
							0% { box-shadow: 0 0 0 0 rgba(104, 172, 229, 0.55); }
							70% { box-shadow: 0 0 0 8px rgba(104, 172, 229, 0); }
							100% { box-shadow: 0 0 0 0 rgba(104, 172, 229, 0); }
						}
					`}</style>

					{guidedControls.busy ? (
						// Once the commit is running there's nothing left to cancel
						// or restart, so swap to the same pulsing-dot indicator.
						<span
							role="status"
							style={{
								display: "inline-flex",
								alignItems: "center",
								gap: 6,
								fontSize: 11.5,
								fontWeight: 700,
								color: "rgba(255,255,255,0.75)",
								whiteSpace: "nowrap",
							}}
						>
							<span
								aria-hidden="true"
								style={{
									width: 7,
									height: 7,
									borderRadius: "50%",
									background: "var(--jhu-blue-accent, #68ACE5)",
									animation: "seg-effect-render-pulse 0.9s ease-in-out infinite",
								}}
							/>
							Applying…
						</span>
					) : (
						<>
							{/* Continue is shown whenever the guided flow provides a
							    handler for it (e.g. Grow from Seeds), always alongside
							    Start over and Exit. It stays clickable-looking but is
							    only actually enabled once `continueDisabled` clears
							    (e.g. after at least one seed point is marked) — a
							    click while still blocked doesn't call onContinue, it
							    just surfaces a small hint near the cursor instead. */}
							{guidedControls.onContinue && (
								<button
									type="button"
									onClick={(e) => {
										if (guidedControls.continueDisabled) {
											if (continueBlockedHintTimeoutRef.current != null) window.clearTimeout(continueBlockedHintTimeoutRef.current);
											// A keyboard-synthesized click reports 0,0, so anchor to the
											// button itself instead of the window's top-left corner.
											const fromKeyboard = e.detail === 0;
											const rect = e.currentTarget.getBoundingClientRect();
											setContinueBlockedHint({
												x: fromKeyboard ? rect.left : e.clientX,
												y: fromKeyboard ? rect.bottom - 14 : e.clientY,
												message: guidedControls.continueHint || "Mark at least one point first",
											});
											continueBlockedHintTimeoutRef.current = window.setTimeout(() => setContinueBlockedHint(null), 1800);
											return;
										}
										guidedControls.onContinue?.();
									}}
									aria-disabled={!!guidedControls.continueDisabled}
									className="atb-guided__btn atb-guided__btn--continue"
									style={{
										animation: guidedControls.continueDisabled ? undefined : "seg-effect-continue-pulse 1.6s ease-in-out infinite",
										opacity: guidedControls.continueDisabled ? 0.5 : 1,
										cursor: guidedControls.continueDisabled ? "default" : "pointer",
									}}
								>
									{guidedControls.continueLabel || "Continue"}
								</button>
							)}
							<button
								type="button"
								onClick={guidedControls.onStartOver}
								className="atb-guided__btn atb-guided__btn--startover"
							>
								Start over
							</button>
							<button
								type="button"
								onClick={guidedControls.onExit}
								className="atb-guided__btn atb-guided__btn--exit"
							>
								Exit
							</button>
						</>
					)}
				</div>
			)}

			</div>{/* /dockContentRef */}
		</div>

			<FlyoutPanel
				open={enabled && !!activeTool && !!activeDef && toolFlyout.open}
				anchorRef={toolFlyout.anchorRef}
				panelRef={toolFlyout.panelRef}
				placement="below"
				// 200 matches MenuColumn's natural floor + panel padding, so
				// short one-shot flyouts (e.g. Smoothing) shrink to fit instead
				// of using a flat width regardless of content.
				minWidth={200}
				// Forces a reposition when settings reopen for a different tool
				// icon, so the panel doesn't stay glued under the previous one.
				anchorKey={activeTool}
				// Escape and tabbing out leave it like an outside click does.
				label={activeDef ? `${activeDef.label} settings` : undefined}
				onDismiss={toolFlyout.dismiss}
				// Guided-overlay tools (GrowFromSeeds, Copy/FillAcrossSlices,
				// Islands) close settings the instant their overlay takes over
				// picking; keepMounted stops that from unmounting the picker
				// state and its body-portaled overlay. The tool itself still
				// unmounts normally when deselected (activeDef goes null).
				keepMounted
			>
				{activeDef && (
					<div
						ref={panelBodyRef}
						className="atb-corner-panel atb-corner-panel--floating"
					>
						<div className="atb-corner-panel__body">
							{/* Measured for --atb-panel-h. Deliberately unstyled — observing
							    the body div directly (which has min-height: var(--atb-panel-h))
							    would be self-referential and grow without bound. */}
							<div ref={panelBodyContentRef} style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: "inherit", flexWrap: "inherit" }}>
								<div ref={fieldRef}>
									{(activeTool === "paint" || activeTool === "erase") && (
										// NumberSliderField's own `label` prop already shows
										// "Brush"/"Erase" above the slider.
										<DiameterFlyout
											title={activeTool === "paint" ? "Brush size" : "Eraser size"}
											diameterMm={diameterMm}
											onDiameterChange={onDiameterChange}
											onPreviewChange={onDiameterPreviewChange}
										/>
									)}
									{activeTool === "scissors" && (
										<ScissorsFlyout
											options={scissorsOptions}
											onChange={onScissorsOptionsChange}
											pointCount={scissorsPointCount}
											onCancel={onScissorsCancel}
											onCloseSettings={() => toolFlyout.setOpen(false)}
										/>
									)}
									{activeTool && !["paint", "erase", "scissors", ...PROMPT_TOOLS].includes(activeTool) && renderFlyout(activeTool, handleToolApplied, () => toolFlyout.setOpen(false), setGuidedControls)}
								</div>
							</div>
						</div>
					</div>
				)}
			</FlyoutPanel>
		</div>{/* /.atb-shell */}

		{open && pickClassHintOpen && pickClassHintRect && (
			<>
				{/* Traces the live popup rect so it stays aligned if the popup is
				    dragged or resized while showing. */}
				<div
					aria-hidden="true"
					style={{
						position: "fixed",
						top: pickClassHintRect.top,
						left: pickClassHintRect.left - 3,
						width: pickClassHintRect.width + 6,
						height: pickClassHintRect.height + 3,
						border: "2px dashed var(--jhu-blue-accent, #68ACE5)",
						borderRadius: 12,
						pointerEvents: "none",
						zIndex: 120,
						boxShadow: "0 0 0 4000px rgba(0,0,0,0.35)",
					}}
				/>
				<div
					ref={pickHintRef}
					role="dialog"
					aria-label="Pick a class first"
					aria-describedby={pickHintTextId}
					style={{
						position: "fixed",
						// Beside the class panel normally. On a phone the panel is a
						// full-width bottom sheet with no room to its left, and the
						// card would sit on the very list it points at, so it goes
						// above the sheet instead (as it does for a panel dragged to
						// the left edge).
						// Above only when it fits: a panel dragged near the top would
						// push the card off-screen with its Got it button.
						...((window.innerWidth <= 640 || pickClassHintRect.left <= 0) && pickClassHintRect.top >= (pickHintRef.current?.offsetHeight || 130) + 12
							? { bottom: window.innerHeight - pickClassHintRect.top + 12, left: 12 }
							: { top: Math.max(12, pickClassHintRect.top), left: Math.max(12, pickClassHintRect.left - 300) }),
						width: Math.min(260, window.innerWidth - 24),
						background: "#16181d",
						border: "1px solid rgba(255,255,255,0.14)",
						borderRadius: 12,
						boxShadow: "0 18px 44px -12px rgba(0,0,0,0.75)",
						padding: "14px 16px",
						zIndex: 121,
						color: "#fff",
					}}
				>
					<div id={pickHintTextId} style={{ fontSize: 13, lineHeight: 1.5, color: "rgba(255,255,255,0.9)" }}>
						Select an existing class or create a custom one to start annotating.
					</div>
					<button
						ref={pickHintBtnRef}
						type="button"
						onClick={dismissPickClassHint}
						style={{
							marginTop: 12,
							width: "100%",
							background: "#fff",
							color: "#08090b",
							border: "none",
							borderRadius: 8,
							fontSize: 12.5,
							fontWeight: 700,
							padding: "8px 0",
							cursor: "pointer",
						}}
					>
						Got it
					</button>
				</div>
			</>
		)}

		{open && guidedHintShown && guidedHintRect && (
			<>
				{/* Same dashed-spotlight treatment as the pick-class/first-target
				    hints above, but wrapping the Continue/Start over/Exit cluster
				    itself so it's obvious which controls the card is describing. */}
				<div
					aria-hidden="true"
					style={{
						position: "fixed",
						top: guidedHintRect.top - 8,
						left: guidedHintRect.left - 8,
						width: guidedHintRect.width + 16,
						height: guidedHintRect.height + 16,
						border: "2px dashed var(--jhu-blue-accent, #68ACE5)",
						borderRadius: 12,
						pointerEvents: "none",
						zIndex: 120,
						boxShadow: "0 0 0 4000px rgba(0,0,0,0.35)",
					}}
				/>
				<div
					ref={guidedHintRef}
					role="dialog"
					aria-label="Guided flow controls"
					aria-describedby={guidedHintTextId}
					style={{
						position: "fixed",
						top: guidedHintRect.bottom + 10,
						left: Math.max(12, Math.min(guidedHintRect.left, window.innerWidth - 292)),
						width: 260,
						background: "#16181d",
						border: "1px solid rgba(255,255,255,0.14)",
						borderRadius: 12,
						boxShadow: "0 18px 44px -12px rgba(0,0,0,0.75)",
						padding: "14px 16px",
						zIndex: 121,
						color: "#fff",
					}}
				>
					<div id={guidedHintTextId} style={{ fontSize: 13, lineHeight: 1.5, color: "rgba(255,255,255,0.9)" }}>
						{guidedHintText}
					</div>
					<button
						ref={guidedHintBtnRef}
						type="button"
						onClick={dismissGuidedHint}
						style={{
							marginTop: 12,
							width: "100%",
							background: "#fff",
							color: "#08090b",
							border: "none",
							borderRadius: 8,
							fontSize: 12.5,
							fontWeight: 700,
							padding: "8px 0",
							cursor: "pointer",
						}}
					>
						Got it
					</button>
				</div>
			</>
		)}

		{/* Small blue rectangle pinned near the cursor when Continue is
		    clicked while the guided flow still has nothing to continue
		    with (e.g. no seed point marked yet). Same visual language as
		    SliceAnchorPickerUI's PickErrorHint, kept local here since this
		    fires from the ribbon's Continue button, not from a canvas
		    click. */}
		{continueBlockedHint && (
			<div
				role="alert"
				style={{
					position: "fixed",
					left: Math.max(12, Math.min(continueBlockedHint.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1024) - 260)),
					top: Math.max(12, Math.min(continueBlockedHint.y + 14, (typeof window !== "undefined" ? window.innerHeight : 768) - 60)),
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
				}}
			>
				{continueBlockedHint.message}
			</div>
		)}

		</>,
		document.body
	);
}