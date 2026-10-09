import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	IconEye, IconEyeOff, IconTrash, IconPlus, IconStack2, IconSparkles,
	IconPencil,
	IconLoader2,
	IconCheck,
} from "@tabler/icons-react";
import type { CheckBoxData } from "../../types";
import "../viewer/FlyoutPrimitives.css";
import "./SegmentsPopup.css";
import ApplyButton from "../ApplyButton";
import { GuidedStepModal } from "../segmentation/SliceAnchorPickerUI";
import { NEW_CLASS_PALETTE } from "../../helpers/constants";
import { escapeWasUsed, markEscapeUsed } from "../../helpers/viewer/escapeUsed";
import { classInSentence } from "../../helpers/utils.name";
import { focusableWithin } from "../../hooks/useDialogFocus";

interface SegmentsPopupProps {
	/** Mirrors AnnotationToolbar's own `open` prop: the component stays
	 *  mounted (and its drag/resize state alive) at all times — closing just
	 *  renders null after the hooks have run — so a dragged position isn't
	 *  lost every time the panel is toggled off and back on. */
	open: boolean;
	segments: CheckBoxData[];
	colors: Record<number, string>;
	visibility: Record<number, boolean>;
	activeSegmentId: number | null;
	onSelect: (id: number | null) => void;
	onRename: (id: number, name: string) => boolean;
	onColorChange: (id: number, hex: string) => void;
	onToggleVisibility: (id: number) => void;
	onDelete: (id: number) => void;
	/** Null means it failed for no stated reason; a string is the reason to show. */
	onCreate: (name: string, colorHex: string) => CheckBoxData | string | null;
	organCatalog: { id: number; label: string }[];
	activeCatalogOrganId: number | null;
	onSelectCatalogOrgan: (id: number | null) => void;

	/** Fires whenever the "any deletes currently in flight" state flips, so
	 *  the parent can surface it in AnnotationToolbar's own "Deleting…"
	 *  indicator (this popup lives outside that component). True from the
	 *  moment a delete is confirmed until the deleted class has actually
	 *  left `segments`. */
	onDeletingChange?: (isDeleting: boolean) => void;

	/** Refs the parent (VisualizationPage) attaches this component's outer
	 *  panel and header to, so AnnotationToolbar's Overview walkthrough can
	 *  spotlight this popup even though it lives outside that component. */
	containerRef?: React.RefObject<HTMLDivElement | null>;
	dragHandleRef?: React.RefObject<HTMLDivElement | null>;
	/** Kept for callers still passing it through (e.g. the walkthrough
	 *  spotlight rects) — there's no minimize button anymore, so nothing
	 *  attaches a ref to it, but removing the prop would be a breaking
	 *  change to every call site for no behavioral benefit. */
	minButtonRef?: React.RefObject<HTMLButtonElement | null>;

	/** "Show only target class" display preference — moved here (above the
	 *  organ/class list) from AnnotationToolbar's ribbon. On by default:
	 *  every class except whichever one is currently targeted is hidden
	 *  from the CT viewer. */
	showOnlyTargetMask: boolean;
	onShowOnlyTargetMaskChange: (v: boolean) => void;
	hasActiveTarget: boolean;
}

// Suggested default swatch for the next new class — cycles through the
// bright NEW_CLASS_PALETTE (the same rotation other class-creation paths
// use), so a fresh class's mask is visible over the CT immediately. An
// earlier version cycled the brand ink colors here, and a class defaulting
// to near-black #0F172A rendered invisibly against the scan at mask
// opacity until manually repainted. Can still be repainted afterward.
const NEXT_COLOR_POOL = NEW_CLASS_PALETTE.map(
	([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()
);

// The colour offered for the next new class: the first pool colour no current
// class uses. Cycling by list length repeated a colour once a class had been
// deleted (ids and colours stay, the length shrinks).
const nextClassColor = (segments: { id: number }[], colors: Record<number, string>): string =>
	NEXT_COLOR_POOL.find((c) => !segments.some((s) => colors[s.id]?.toLowerCase() === c.toLowerCase()))
	?? NEXT_COLOR_POOL[segments.length % NEXT_COLOR_POOL.length];

// Applies to both the "add segment" and "rename" name fields.
const MAX_SEGMENT_NAME_LENGTH = 40;

interface ShowOnlyTargetToggleProps {
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled: boolean;
}

// Display preference shown above the class list, centered — replaces the
// old per-tab hint text. Lives here (rather than in AnnotationToolbar)
// since it's a property of the list itself, not of any editing tool.
function ShowOnlyTargetToggle({ checked, onChange, disabled }: ShowOnlyTargetToggleProps) {
	return (
		<button
			type="button"
			className={`segpop__show-target ${disabled ? "is-disabled" : ""}`}
			role="checkbox"
			aria-checked={checked}
			aria-disabled={disabled}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			title={
				disabled
					? "Pick or create a class first."
					: checked
						? "On: every class except whichever one is currently targeted is hidden. Click to show every class's mask."
						: "Off: every class's mask is showing. Click to show only the targeted class's mask."
			}
		>
			<span className={`atb-checkbox-box ${checked ? "is-checked" : ""}`}>
				<IconCheck aria-hidden="true" size={12} stroke={3} className="atb-checkbox-box__check" />
			</span>
			<span>Show only target class</span>
		</button>
	);
}// Kept in sync with the CSS transition durations in SegmentsPopup.css so
// JS timers gate the real state change at the right moment.
const EXIT_ANIM_MS = 200;

type PopupTab = "existing" | "custom";

// Hands focus back to the control that opened a popover or editor once it is
// gone. Only when focus has been dropped on <body> (its own button unmounted):
// if the person moved on to another control, that one keeps it.
const restoreFocus = (el: HTMLElement | null | undefined) => {
	const active = document.activeElement;
	if (el && el.isConnected && (!active || active === document.body)) el.focus();
};

// Tab past either end of a body-portaled panel (the class editor, the colour
// popover) would otherwise walk out of the page while the panel stays open:
// the portal sits at the end of <body>, far from its trigger. Closes the panel
// and carries focus on from the trigger, as useToolbarFlyout does for the
// ribbon flyouts: back to the trigger for Shift+Tab, to whatever follows it for Tab.
const leaveOnTab = (e: KeyboardEvent, panel: HTMLElement | null, trigger: HTMLElement | null | undefined, close: () => void) => {
	if (e.key !== "Tab" || e.isComposing || !panel) return;
	const active = document.activeElement;
	if (!(active instanceof Node) || !panel.contains(active)) return;
	const items = focusableWithin(panel);
	const back = e.shiftKey && (active === items[0] || active === panel);
	const forward = !e.shiftKey && (active === items[items.length - 1] || active === panel || items.length === 0);
	if (!back && !forward) return;
	e.preventDefault();
	close();
	if (back) { trigger?.focus({ preventScroll: true }); return; }
	// The colour popover is a portal of its own, so it is not "after" anything.
	const order = focusableWithin(document.body).filter((el) => !panel.contains(el) && !el.closest("[data-color-popover-portal]"));
	const at = trigger ? order.indexOf(trigger) : -1;
	(order[at + 1] && at >= 0 ? order[at + 1] : trigger)?.focus({ preventScroll: true });
};

// Small curated swatch set for the color popover — the bright new-class
// rotation first (colors that read over a CT at mask opacity), then two
// muted accents for deliberate low-key choices. The near-black brand inks
// that used to lead this grid are gone: a mask that color is invisible
// against the scan, which reads as "the tool did nothing".
const SWATCH_PRESETS = [
	...NEXT_COLOR_POOL,
	"#E76F51", "#7C8A9E",
];

interface ColorPickerPopoverProps {
	value: string;
	onChange: (hex: string) => void;
	onClose: () => void;
	/** Swatch button this popover is anchored to — used only to compute a
	 *  fixed viewport position, since the popover itself portals to
	 *  <body> (see below) rather than rendering inline. */
	anchorRef: React.RefObject<HTMLElement | null>;
}

// Small anchored popover for picking a class color — a grid of preset
// swatches plus a native color input for anything custom. Gradually
// scales/fades in on open and back out on close (mirrors GuidedStepModal's
// treatment elsewhere in the annotation tool) instead of the browser's own
// abrupt native color picker being the only way in.
//
// Portals to <body> and positions itself with `fixed` coords computed from
// the swatch button's own rect, rather than rendering inline where
// .segpop__list/.segpop__row's overflow:hidden (needed for their own
// scroll/collapse animations) would otherwise clip it to the panel. This
// lets the popover spill out over the canvas instead of being boxed in.
function ColorPickerPopover({ value, onChange, onClose, anchorRef }: ColorPickerPopoverProps) {
	const [closing, setClosing] = useState(false);
	const popRef = useRef<HTMLDivElement>(null);
	const colorInputRef = useRef<HTMLInputElement>(null);
	// True only while the native picker is open (from the input's click until
	// its native change, the page window regaining focus, or a blur while the page
	// still has focus). Focus alone is not enough: the hidden input keeps focus
	// after the picker closes and would swallow the next outside click.
	const nativePickerOpenRef = useRef(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	// React's onChange is the live "input" event; the native "change" fires once
	// when the picker closes with a choice.
	useEffect(() => {
		const input = colorInputRef.current;
		if (!input) return;
		const onPickerClosed = () => { nativePickerOpenRef.current = false; };
		input.addEventListener("change", onPickerClosed);
		// A picker dismissed without a new colour fires no change, and one that is
		// its own OS window blurs the page when it opens, so the page window
		// regaining focus is what says it has closed.
		window.addEventListener("focus", onPickerClosed);
		return () => {
			input.removeEventListener("change", onPickerClosed);
			window.removeEventListener("focus", onPickerClosed);
		};
	}, [pos]);
	// A click outside has already put focus where the person clicked, so only
	// the keyboard paths (Escape, Done, the swatch button) hand it back.
	const restoreOnCloseRef = useRef(true);
	const focusedOnOpenRef = useRef(false);

	const requestClose = () => setClosing(true);

	// Portaled to the end of <body>, so its swatches are far from the button
	// in tab order: move focus in when it opens, and back to the button when
	// it closes.
	useEffect(() => {
		if (!pos || focusedOnOpenRef.current) return;
		focusedOnOpenRef.current = true;
		popRef.current?.querySelector<HTMLElement>("button")?.focus();
	}, [pos]);
	useEffect(() => () => {
		if (restoreOnCloseRef.current) restoreFocus(anchorRef.current);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Calls onClose once the close animation has played. The timer belongs to
	// an effect so it is cancelled if this popover unmounts first, as in
	// FormFlyout: a popover whose editor was replaced (another class's pencil)
	// would otherwise close the one just opened in the editor replacing it.
	useEffect(() => {
		if (!closing) return;
		const timer = window.setTimeout(onClose, EXIT_ANIM_MS);
		return () => window.clearTimeout(timer);
		// onClose is a new closure every render, and re-arming the timer on
		// each one could hold the close off indefinitely.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [closing]);

	// Runs again once the popover has rendered (`placed`), before paint: the
	// first pass has no panel to measure, so its height is 0 and the vertical
	// clamp below would be skipped, leaving the swatches below the viewport.
	const placed = pos !== null;
	useLayoutEffect(() => {
		const compute = () => {
			const anchor = anchorRef.current;
			if (!anchor) return;
			const rect = anchor.getBoundingClientRect();
			const popW = popRef.current?.offsetWidth ?? 208;
			const popH = popRef.current?.offsetHeight ?? 0;
			const margin = 8;
			// Prefer opening to the right of the swatch; flip to the left if
			// it would run off the viewport edge, and clamp vertically so it
			// never gets pushed off the top/bottom either.
			let left = rect.right + margin;
			if (left + popW > window.innerWidth - margin) {
				left = rect.left - popW - margin;
			}
			left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));
			let top = rect.top;
			if (popH) top = Math.max(margin, Math.min(top, window.innerHeight - popH - margin));
			setPos({ top, left });
		};
		compute();
		window.addEventListener("resize", compute);
		window.addEventListener("scroll", compute, true);
		return () => {
			window.removeEventListener("resize", compute);
			window.removeEventListener("scroll", compute, true);
		};
	}, [anchorRef, placed]);

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (popRef.current?.contains(e.target as Node)) return;
			if (anchorRef.current?.contains(e.target as Node)) return;
			// The native OS color picker (behind the "Custom…" <input
			// type="color">) can fire a synthetic mousedown on `document`
			// itself — outside both the input and this whole component tree —
			// when the user drags/picks within the OS dialog, in some
			// browsers. Without this guard that got misread as "clicked
			// outside the popover" and closed it mid-pick, which is exactly
			// why changing the color via the custom picker felt broken —
			// every drag/selection risked closing before it registered. Skip
			// closing while the native picker is open. That synthetic event targets
			// the document itself, so a mousedown on a real element is a real click
			// outside even if the picker was cancelled with no change event.
			if (nativePickerOpenRef.current) {
				if ((e.target as Node).nodeType === Node.DOCUMENT_NODE) return;
				nativePickerOpenRef.current = false;
			}
			restoreOnCloseRef.current = false;
			requestClose();
		};
		// Marked as used, so the viewer doesn't also disarm the active tool with
		// it. Capture phase, so this runs before the class editor the popover
		// sits in, which leaves a used Escape alone: one Escape closes only
		// the popover, the next one the editor.
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") { markEscapeUsed(e); requestClose(); return; }
			leaveOnTab(e, popRef.current, anchorRef.current, requestClose);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey, true);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (typeof document === "undefined" || !pos) return null;

	return createPortal(
		<div
			ref={popRef}
			data-color-popover-portal
			className={`segpop__color-popover segpop__color-popover--portaled ${closing ? "is-closing" : "is-open"}`}
			style={{ position: "fixed", top: pos.top, left: pos.left }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="segpop__color-popover-grid">
				{SWATCH_PRESETS.map((hex) => (
					<button
						key={hex}
						type="button"
						className={`segpop__color-popover-swatch ${value.toLowerCase() === hex.toLowerCase() ? "is-active" : ""}`}
						style={{ background: hex }}
						aria-label={hex}
						aria-pressed={value.toLowerCase() === hex.toLowerCase()}
						// Stages the color (updates the draft the caller holds) but does
						// NOT close the popover — picking a swatch used to auto-close
						// immediately, which looked like "nothing happened" since the
						// actual save is a separate action on the row below. Leaving it
						// open lets the person see the live preview/hex below update
						// and confirm with an explicit "Done" instead.
						onClick={() => onChange(hex)}
					/>
				))}
			</div>
			<label className="segpop__color-popover-custom">
				<input
					ref={colorInputRef}
					type="color"
					value={value}
					onClick={() => { nativePickerOpenRef.current = true; }}
					onChange={(e) => onChange(e.target.value)}
					// The page window blurring (a picker in its own OS window) is not the
					// picker closing: only a blur while the page keeps focus is.
					onBlur={() => { if (document.hasFocus()) nativePickerOpenRef.current = false; }}
				/>
				<span>Custom…</span>
			</label>
			{/* Explicit commit step for the popover itself — a live preview swatch
			    plus the hex value, so it's visually obvious a selection has been
			    made and staged, then "Done" closes the popover. This does NOT save
			    the class — that's still the row's own Save/ApplyButton — it just
			    makes clear the color choice registered before the popover goes
			    away, instead of a swatch click silently vanishing the popover with
			    no confirmation of what got picked. */}
			<div className="segpop__color-popover-footer">
				<span className="segpop__color-popover-preview" style={{ background: value }} aria-hidden="true" />
				<span className="segpop__color-popover-hex">{value.toUpperCase()}</span>
				<button type="button" className="segpop__color-popover-done" onClick={requestClose}>
					Done
				</button>
			</div>
		</div>,
		document.body
	);
}

// Replaces the old in-row Collapse (grid-template-rows / max-height) trick.
// That approach animated the *content's own* box open and closed inline in
// the list, which had two problems in practice: every existing row below it
// physically shifted up/down as the form expanded and collapsed (jarring
// next to a list the person is actively scanning), and its "done animating"
// signal was a CSS `transitionend` on `max-height` — which never fires if
// the browser coalesces the open→close flip within a frame, if the content's
// measured height doesn't actually change between states, or if a re-render
// interrupts the transition mid-flight. When that happened the row got stuck
// permanently in its "closing" bookkeeping state, and since the very next
// "Add class" button is gated on that same bookkeeping having cleared, it
// would silently stop appearing at all.
//
// This instead portals the add/edit form to <body> as a small floating
// panel anchored (fixed position, computed off the trigger button's own
// rect) next to whatever it's editing — same mechanism already proven out
// by ColorPickerPopover above. Existing rows and icons never move, because
// the form isn't part of their flex flow at all. And open/close is driven
// entirely by this component's own JS timer (mirroring
// ColorPickerPopover's `requestClose`), never by waiting on a transition
// event, so there's no path left where it can get stuck.
interface FormFlyoutProps {
	/** The button this flyout is anchored to and points at with its little
	 *  pointer/arrow — the "Add class" button, or a row's pencil icon. */
	anchorEl: HTMLElement | null;
	/** Called once the close animation has actually finished — the right
	 *  moment for the caller to unmount this flyout / clear its target id. */
	onClose: () => void;
	/** Reports whether this flyout is playing its close animation, so the
	 *  button that opens it can tell "close it" apart from "reopen it". */
	onClosingChange?: (closing: boolean) => void;
	/** Render prop so Cancel / successful-Enter / successful-Apply inside
	 *  the form can all trigger the same gradual close by calling this,
	 *  instead of each needing its own copy of the animate-then-unmount
	 *  logic. */
	children: (requestClose: () => void) => React.ReactNode;
}

function FormFlyout({ anchorEl, onClose, onClosingChange, children }: FormFlyoutProps) {
	const [closing, setClosing] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number; arrowLeft: number; flipped: boolean } | null>(null);
	// The pencil or "Add class" chip that opened this editor. Focus goes back
	// to it when the editor closes from the keyboard or its own buttons; an
	// outside click leaves focus where the person clicked.
	const openerRef = useRef(anchorEl);
	const restoreOnCloseRef = useRef(true);

	const requestClose = () => setClosing(true);

	useEffect(() => {
		onClosingChange?.(closing);
		// onClosingChange is a new closure every render; only a change of
		// `closing` is worth reporting.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [closing]);

	useEffect(() => () => {
		if (restoreOnCloseRef.current) restoreFocus(openerRef.current);
	}, []);

	// Calls onClose once the close animation has played. The timer belongs to
	// an effect so it is cancelled if this flyout unmounts first: the edit
	// flyout is keyed by class, so another row's pencil swaps in a new one,
	// and the old one's onClose would otherwise close the editor replacing it.
	useEffect(() => {
		if (!closing) return;
		const timer = window.setTimeout(onClose, EXIT_ANIM_MS);
		return () => window.clearTimeout(timer);
		// onClose is a new closure every render, and re-arming the timer on
		// each one could hold the close off indefinitely.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [closing]);

	// Runs again once the panel has rendered (`placed`), before paint: the
	// first pass has no panel to measure, so its height is 0 and the flip
	// above the trigger below would never happen.
	const placed = pos !== null;
	useLayoutEffect(() => {
		const compute = () => {
			if (!anchorEl) return;
			const rect = anchorEl.getBoundingClientRect();
			const panelW = panelRef.current?.offsetWidth ?? 260;
			const panelH = panelRef.current?.offsetHeight ?? 0;
			const margin = 8;
			// Prefer opening just below the trigger, left-aligned to it;
			// clamp horizontally so it never runs off the viewport edge,
			// and flip above the trigger if there isn't room below.
			let left = rect.left;
			left = Math.max(margin, Math.min(left, window.innerWidth - panelW - margin));
			let top = rect.bottom + 10;
			let flipped = false;
			if (panelH && top + panelH > window.innerHeight - margin) {
				top = Math.max(margin, rect.top - panelH - 10);
				flipped = true;
			}
			// Point the little pointer at the trigger's own center, clamped
			// to stay within the panel's own width.
			const arrowLeft = Math.max(14, Math.min(rect.left + rect.width / 2 - left, panelW - 14));
			setPos({ top, left, arrowLeft, flipped });
		};
		compute();
		// The panel grows and shrinks on its own: an error line, or the
		// characters-left count, changes its height after it was placed. Its top
		// came from the old height, so a flipped panel would then cover its
		// trigger and a low one would run off the screen.
		const panel = panelRef.current;
		const observer = panel && typeof ResizeObserver !== "undefined" ? new ResizeObserver(compute) : null;
		if (panel) observer?.observe(panel);
		window.addEventListener("resize", compute);
		window.addEventListener("scroll", compute, true);
		return () => {
			observer?.disconnect();
			window.removeEventListener("resize", compute);
			window.removeEventListener("scroll", compute, true);
		};
	}, [anchorEl, placed]);

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (panelRef.current?.contains(e.target as Node)) return;
			if (anchorEl?.contains(e.target as Node)) return;
			// The color swatch popover portals to document.body on its OWN,
			// separate from this FormFlyout's portal — so a click on a preset
			// swatch or the native color input isn't a descendant of either
			// panelRef or anchorEl, and without this check got misread as
			// "clicked outside the name/color editor," closing the whole
			// editor instead of just the small color popover. The color
			// popover already closes itself independently on its own outside
			// click; this just stops THIS flyout from also reacting to a
			// click that was actually still inside it, conceptually.
			if ((e.target as Element | null)?.closest?.("[data-color-popover-portal]")) return;
			restoreOnCloseRef.current = false;
			requestClose();
		};
		// Marked as used, so the viewer doesn't also disarm the active tool with
		// it. An Escape the colour popover inside already used is left alone.
		const onKey = (e: KeyboardEvent) => {
			// Escape in an IME composition cancels the candidate, not the editor.
			if (e.isComposing || e.keyCode === 229) return;
			if (e.key !== "Escape" || escapeWasUsed(e)) return;
			markEscapeUsed(e);
			requestClose();
		};
		// Its own capture-phase listener: Escape stays in the bubble phase above so
		// the colour popover's capture-phase Escape is heard first.
		const onTab = (e: KeyboardEvent) => leaveOnTab(e, panelRef.current, anchorEl, requestClose);
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		document.addEventListener("keydown", onTab, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("keydown", onTab, true);
		};
	}, [anchorEl]);

	if (typeof document === "undefined" || !pos) return null;

	return createPortal(
		<div
			ref={panelRef}
			className={`segpop__form-flyout ${closing ? "is-closing" : "is-open"}${pos.flipped ? " is-flipped" : ""}`}
			style={{ position: "fixed", top: pos.top, left: pos.left }}
			onClick={(e) => e.stopPropagation()}
		>
			<span className="segpop__form-flyout-arrow" style={{ left: pos.arrowLeft }} />
			{children(requestClose)}
		</div>,
		document.body
	);
}



// Gap kept clear between the docked panel's top edge and the main topbar
// above it (--vp-topbar-h — see VisualizationPage.css). The annotation
// ribbon used to be a full-width bar docked directly under the topbar, so
// this used to also add --atb-ribbon-h/--atb-panel-h to clear it. It's now
// a small centered floating popout (see .atb-shell in AnnotationToolbar.css)
// that no longer occupies the top-right corner where this panel docks, so
// there's nothing left to clear there — the panel can sit right under the
// topbar instead of leaving room for a ribbon that isn't in its way anymore.
const DOCK_CLEARANCE = "calc(var(--vp-topbar-h, 0px) + 15px)";
const POPUP_WIDTH = 320;
const POPUP_MIN_WIDTH = 240;
const POPUP_MAX_WIDTH = 560;

/**
 * Segments panel — docked to the top-right, directly beneath the main
 * topbar (the annotation ribbon floats separately as a small centered
 * popout and no longer reserves space here), like a permanent slide-in
 * side panel (same pattern as the AI sidebar) rather than a freely
 * draggable window that can end up sitting on top of the CT viewer.
 * Only its width is still adjustable
 * (drag the left edge) so it can be made more or less roomy for long
 * segment names; it never moves off its docked corner. Minimizable to a
 * small horizontal bar.
 */
export default function SegmentsPopup({
	open, segments, colors, visibility, activeSegmentId,
	onSelect, onRename, onColorChange, onToggleVisibility, onDelete, onCreate, onDeletingChange,
	organCatalog, activeCatalogOrganId, onSelectCatalogOrgan,
	containerRef, dragHandleRef,
	showOnlyTargetMask, onShowOnlyTargetMaskChange, hasActiveTarget,
}: SegmentsPopupProps) {
	// Horizontal resize — drag the left edge to widen/narrow the docked
	// panel. The handle sits on the LEFT edge (the popup is anchored to the
	// right side of the viewport) so growing it extends leftward, away from
	// the dock, while the right edge stays flush against the viewport.
	const [width, setWidth] = useState(POPUP_WIDTH);
	const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

	useEffect(() => {
		const onMove = (e: PointerEvent) => {
			const st = resizeStateRef.current;
			if (!st) return;
			const delta = st.startX - e.clientX; // dragging left = positive delta = wider
			// Also clamp against the window so the panel can never be dragged
			// wide enough to crush the CT stage on narrow screens (matches the
			// 45vw cap VisualizationPage.css puts on the reserved gutter).
			const maxW = Math.min(POPUP_MAX_WIDTH, Math.floor(window.innerWidth * 0.45));
			const next = Math.min(maxW, Math.max(POPUP_MIN_WIDTH, st.startWidth + delta));
			setWidth(next);
		};
		// A cancelled touch (or a lost capture) ends the drag too, so the next
		// touch-drag elsewhere cannot resize the panel.
		const onUp = () => { resizeStateRef.current = null; };
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onUp);
		window.addEventListener("lostpointercapture", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onUp);
			window.removeEventListener("lostpointercapture", onUp);
		};
	}, []);

	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Measure the width on screen: CSS caps the panel at 45vw, so after the
		// window narrows it can be drawn narrower than the stored width.
		const drawn = e.currentTarget.parentElement?.getBoundingClientRect().width;
		resizeStateRef.current = { startX: e.clientX, startWidth: drawn || width };
		e.currentTarget.setPointerCapture?.(e.pointerId);
	};

	// Keep --atb-segpanel-w in sync with the panel's real width (0 when
	// closed) so VisualizationPage.css's `margin-right: var(--atb-segpanel-w)`
	// reserves the actual space instead of a hardcoded fallback, letting
	// the CT viewer shrink to make room as this panel is resized.
	useEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--atb-segpanel-w", open ? `${width}px` : "0px");
	}, [open, width]);

	const [tab, setTab] = useState<PopupTab>("existing");
	// `adding` drives whether the Add-class FormFlyout is mounted at all —
	// no separate "still animating closed" bookkeeping needed anymore since
	// FormFlyout owns its own close animation/timer internally and only
	// calls back once it's genuinely done.
	const [adding, setAdding] = useState(false);
	// Keys the add form, so each "Add class" press mounts a fresh one. A press
	// during the form's close animation otherwise reused the closing form and
	// was swallowed when its close finished.
	const [addFormKey, setAddFormKey] = useState(0);
	const [addAnchorEl, setAddAnchorEl] = useState<HTMLElement | null>(null);
	// Whether the add form is playing its close animation. Pressing Add class
	// while it is open closes it; during the close it reopens a fresh form.
	const [addClosing, setAddClosing] = useState(false);
	const [draftName, setDraftName] = useState("");
	const addRemaining = MAX_SEGMENT_NAME_LENGTH - draftName.length;
	const [draftColor, setDraftColor] = useState(nextClassColor(segments, colors));
	const [createError, setCreateError] = useState("");
	const nameErrorId = useId();
	const [addColorPopoverOpen, setAddColorPopoverOpen] = useState(false);

	// Combined name+color editor, opened via the pen icon (replaces the old
	// double-click-to-rename-only flow — both fields are changed and
	// confirmed together, in one place). Same "no separate mounted flag"
	// simplification as `adding` above — the FormFlyout itself tracks its
	// close animation.
	const [editingId, setEditingId] = useState<number | null>(null);
	// Keys the editor like addFormKey keys the add form: every pencil press
	// mounts a fresh one, so pressing a class's pencil while its own editor is
	// closing reopens it instead of being swallowed by that close.
	const [editFormKey, setEditFormKey] = useState(0);
	const [editAnchorEl, setEditAnchorEl] = useState<HTMLElement | null>(null);
	// Same for the class editor and its pencil.
	const [editClosing, setEditClosing] = useState(false);
	const [editNameDraft, setEditNameDraft] = useState("");
	const [editColorDraft, setEditColorDraft] = useState("#ffffff");
	const [renameError, setRenameError] = useState<number | null>(null);
	const [editColorPopoverOpen, setEditColorPopoverOpen] = useState(false);
	// Anchors for the portaled ColorPickerPopover — one swatch button lives
	// in the add-form flyout, the other in the edit flyout, and only one of
	// either is ever mounted at a time, but keeping separate refs avoids
	// them fighting over a single ref across renders.
	const addColorBtnRef = useRef<HTMLButtonElement>(null);
	const editColorBtnRef = useRef<HTMLButtonElement>(null);

	// Deletion can take a moment on the backend — track in-flight deletes
	// locally so the row can show a spinner instead of looking unresponsive,
	// and so it can fade/collapse out smoothly before it actually leaves the
	// list rather than disappearing the instant the click lands.
	const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
	useEffect(() => {
		setDeletingIds((prev) => {
			if (prev.size === 0) return prev;
			const stillPresent = new Set(segments.map((s) => s.id));
			const next = new Set([...prev].filter((id) => stillPresent.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [segments]);

	// Tell the parent (VisualizationPage → AnnotationToolbar) whenever the
	// "something is deleting" state actually flips, not on every render —
	// onDeletingChange isn't guaranteed to be referentially stable, so this
	// only fires on a real true/false transition.
	const wasDeletingRef = useRef(false);
	useEffect(() => {
		const isDeleting = deletingIds.size > 0;
		if (isDeleting !== wasDeletingRef.current) {
			wasDeletingRef.current = isDeleting;
			onDeletingChange?.(isDeleting);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [deletingIds]);

	// Class awaiting delete confirmation — the trash icon no longer deletes
	// on the first click; it opens this confirm overlay (same GuidedStepModal
	// treatment as the guided-flow tools) and only Delete-in-the-overlay
	// actually triggers handleDelete's fade-out + real removal.
	const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

	// The flyouts, colour popovers and delete dialog are portaled to <body>,
	// outside the inert panel, so closing the panel (a room lock, a
	// disconnect, the M key) would leave them live. Drop them when it closes.
	useEffect(() => {
		if (open) return;
		setConfirmDeleteId(null);
		setAdding(false);
		setAddAnchorEl(null);
		setEditingId(null);
		setEditAnchorEl(null);
		setAddColorPopoverOpen(false);
		setEditColorPopoverOpen(false);
		setCreateError("");
		setRenameError(null);
	}, [open]);

	// Where keyboard focus goes once a deleted class's row is gone: the trash
	// button that had it is disabled by then, so it would fall to <body>.
	const focusAfterDeleteRef = useRef<{ id: number; neighbours: number[] } | null>(null);
	useEffect(() => {
		const pending = focusAfterDeleteRef.current;
		if (!pending || segments.some((s) => s.id === pending.id)) return;
		focusAfterDeleteRef.current = null;
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected) return;
		const body = tableRef.current;
		if (!body) return;
		for (const id of pending.neighbours) {
			const row = body.querySelector<HTMLElement>(`[data-segment-row="${id}"] .segpop__name`);
			if (row) { row.focus(); return; }
		}
		body.querySelector<HTMLElement>(".segpop__new")?.focus();
	}, [segments]);

	const handleDelete = (id: number) => {
		const at = segments.findIndex((s) => s.id === id);
		focusAfterDeleteRef.current = {
			id,
			neighbours: [segments[at + 1]?.id, segments[at - 1]?.id].filter((n): n is number => n != null),
		};
		setDeletingIds((prev) => new Set(prev).add(id));
		// Let the row play its fade/collapse-out transition before the
		// underlying delete actually lands and yanks it out of the list.
		window.setTimeout(() => onDelete(id), EXIT_ANIM_MS);
	};

	const switchTab = (next: PopupTab) => {
		setTab(next);
		setAdding(false);
		setCreateError("");
		setEditingId(null);
		setConfirmDeleteId(null);
	};

	const startAdd = (e: React.MouseEvent<HTMLButtonElement>) => {
		// The open form ignores presses on its own button as outside clicks, so
		// this one is the toggle: a second press closes it, keeping nothing.
		if (adding && !addClosing) { closeAddForm(); return; }
		setAddAnchorEl(e.currentTarget);
		setAddClosing(false);
		setAdding(true);
		setAddFormKey((k) => k + 1);
		// The fresh form starts with its colour popover closed, like a new
		// class's editor does (see startEdit).
		setAddColorPopoverOpen(false);
		setDraftName("");
		setCreateError("");
		setDraftColor(nextClassColor(segments, colors));
	};

	// Fully closes the add flyout immediately — used when something else
	// (switching tabs, deleting) needs it gone right away, with no need for
	// its own gradual close animation. The FormFlyout's own Cancel/Enter/
	// Apply paths instead call the `requestClose` it hands them, which
	// plays the close animation first and calls this once it's done.
	const closeAddForm = () => {
		setAddColorPopoverOpen(false);
		setAdding(false);
		setAddClosing(false);
		setAddAnchorEl(null);
	};

	const commitAdd = (): boolean => {
		const trimmed = draftName.trim();
		if (!trimmed) { setCreateError("Enter a name."); return false; }
		const lower = trimmed.toLowerCase();
		const dupCustom = segments.some((s) => s.label.toLowerCase() === lower);
		const dupCatalog = organCatalog.some((o) => o.label.toLowerCase() === lower);
		if (dupCustom || dupCatalog) {
			setCreateError(
				dupCatalog
					? "That name matches an existing class. Pick it from the Existing tab instead."
					: "That name is already used."
			);
			return false;
		}
		const created = onCreate(trimmed, draftColor);
		if (!created || typeof created === "string") { setCreateError(created || "Could not create class."); return false; }
		setDraftName("");
		setCreateError("");
		// Closing the form (its own fade/collapse-out) is deferred to
		// ApplyButton's onDone, which fires once the "Added" checkmark has
		// had a beat on screen — so the confirmation is actually seen
		// before the form collapses, instead of both happening at once.
		return true;
	};

	const startEdit = (id: number, currentName: string, currentColor: string, anchorEl: HTMLElement) => {
		// As in startAdd: pressing the pencil of the editor that is open closes
		// it rather than remounting it with the typed name thrown away.
		if (editingId === id && !editClosing) { closeEdit(id); return; }
		setEditClosing(false);
		// Each press mounts a fresh editor (see editFormKey), which starts with
		// its colour popover closed, so one open in the old editor doesn't
		// carry over.
		setEditColorPopoverOpen(false);
		setEditFormKey((k) => k + 1);
		setEditingId(id);
		setEditAnchorEl(anchorEl);
		setEditNameDraft(currentName);
		setEditColorDraft(currentColor);
		setRenameError(null);
	};
	// Immediately closes the edit flyout — see closeAddForm's note above for
	// why this is separate from the FormFlyout's own animated requestClose.
	const closeEdit = (id: number) => {
		setEditColorPopoverOpen(false);
		setEditingId((cur) => (cur === id ? null : cur));
		setEditClosing(false);
		setEditAnchorEl(null);
	};
	const commitEdit = (id: number): boolean => {
		const trimmed = editNameDraft.trim();
		if (!trimmed) { setRenameError(id); return false; }
		const lower = trimmed.toLowerCase();
		const dupCustom = segments.some((s) => s.id !== id && s.label.toLowerCase() === lower);
		const dupCatalog = organCatalog.some((o) => o.label.toLowerCase() === lower);
		if (dupCustom || dupCatalog) { setRenameError(id); return false; }
		const renamed = onRename(id, trimmed);
		if (!renamed) { setRenameError(id); return false; }
		onColorChange(id, editColorDraft);
		setRenameError(null);
		// Closing the edit row is deferred to ApplyButton's onDone (see
		// commitAdd above) so the "Saved" checkmark is visible for a beat
		// before the row collapses back to its normal state.
		return true;
	};

	const handleSelectExisting = (id: number) => {
		onSelectCatalogOrgan(id === activeCatalogOrganId ? null : id);
	};

	const isCustomActive = (id: number) => activeSegmentId === id && activeCatalogOrganId == null;


	const addClassRef = useRef<HTMLDivElement>(null);
	const tableRef = useRef<HTMLDivElement>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
	const catalogListRef = useRef<HTMLDivElement>(null);




	// Bailing out here (rather than gating mount/unmount from the parent)
	// keeps drag position, resize width, editing state, etc. alive across
	// the popup being shown and hidden.
	if (typeof document === "undefined") return null;

	// Portal to <body>, like AISidebar, since the page root has
	// overflow:hidden and would otherwise clip this fixed-position panel.
	// Slides in/out via transform rather than resizing/collapsing — `open`
	// is the same boolean that shows/hides the annotation ribbon.
	return createPortal(
			<div
				ref={containerRef}
				className={`segpop segpop--anchor-top segpop--docked ${open ? "is-open" : "is-closed"}`}
				// Position and width go through custom properties rather than
				// inline top/width, so SegmentsPopup.css can turn the dock into a
				// bottom sheet at phone width. Flush to the right edge, same as
				// AISidebar.
				style={{
					"--segpop-top": DOCK_CLEARANCE,
					"--segpop-w": `${width}px`,
				} as React.CSSProperties}
				// Slid off screen but still mounted while closed: inert keeps its
				// rows out of the tab order and the accessibility tree.
				inert={!open}
			>
				{/* Resize handle: drag left to widen, right to narrow. Absolutely
				    positioned so it does not take part in the column layout of the
				    header/tabs/body below it. */}
				<div
					className="segpop__resize-handle"
					onPointerDown={startResize}
					title="Drag to resize"
				>
					<span className="segpop__resize-grip" />
				</div>

				{/* Drag handle only now — the title text used to repeat
				    "Existing class"/"Custom classes" right below tab
				    buttons that already say the same thing, so it was
				    dropped. dragHandleRef still needs a DOM node to
				    attach to for the popup's drag behavior. */}
				<div ref={dragHandleRef} className="segpop__head" />

				<div ref={tabsRef} className="segpop__tabs" onClick={(e) => e.stopPropagation()}>
					<button className={`segpop__tab ${tab === "existing" ? "is-active" : ""}`} aria-pressed={tab === "existing"} onClick={() => switchTab("existing")}>
						<IconStack2 size={14} />
						Existing class
						{activeCatalogOrganId != null && <span className="segpop__tab-dot" />}
					</button>
					<button className={`segpop__tab ${tab === "custom" ? "is-active" : ""}`} aria-pressed={tab === "custom"} onClick={() => switchTab("custom")}>
						<IconSparkles size={14} />
						Custom
						{activeSegmentId != null && activeCatalogOrganId == null && <span className="segpop__tab-dot" />}
					</button>
				</div>

				{/* DOM order matches the visual order (header, tabs, body) so Tab
				    reaches the Existing/Custom tabs before the class list. Body is the
				    flexed, internally-scrolling region that fills the dock. */}
				<div className="segpop__body" ref={tableRef}>
						{/* Keyed on `tab` so switching between Existing/Custom plays a
						    quick fade+slide-in instead of the content just snapping to
						    the other tab's rows instantly. */}
						<div key={tab} className="segpop__tab-content">
						{tab === "existing" ? (
							<>
								<ShowOnlyTargetToggle
									checked={showOnlyTargetMask}
									onChange={onShowOnlyTargetMaskChange}
									disabled={!hasActiveTarget}
								/>
								{organCatalog.length === 0 ? (
									<div className="segpop__empty">No classes detected in this case.</div>
								) : (
									<div className="segpop__catalog-list" ref={catalogListRef}>
										{organCatalog.map((o) => (
											<button
												key={o.id}
												type="button"
												aria-pressed={activeCatalogOrganId === o.id}
												className={`segpop__catalog-row ${activeCatalogOrganId === o.id ? "is-active" : ""}`}
												onClick={() => handleSelectExisting(o.id)}
											>
												<span className="segpop__catalog-row-name">{o.label}</span>

											</button>
										))}
									</div>
								)}
							</>
						) : (
							<>
								<ShowOnlyTargetToggle
									checked={showOnlyTargetMask}
									onChange={onShowOnlyTargetMaskChange}
									disabled={!hasActiveTarget}
								/>
								{segments.map((s) => {
									const active = isCustomActive(s.id);
									const hex = colors[s.id] ?? "#ffffff";
									const isEditing = editingId === s.id;
									const isDeleting = deletingIds.has(s.id);
									// Each row's icon buttons say which class they act on, so
									// a screen reader doesn't hear "Hide, Delete" on every row.
									const name = classInSentence(s.label);
									return (
										<div
											key={s.id}
											data-segment-row={s.id}
											className={`segpop__row ${active ? "is-active" : ""} ${isDeleting ? "is-deleting" : ""} ${isEditing ? "is-editing-target" : ""}`}
											onClick={() => { if (!isDeleting) { onSelect(active ? null : s.id); } }}
										>
											<button
												className="segpop__vis"
												onClick={(e) => { e.stopPropagation(); onToggleVisibility(s.id); }}
												aria-label={`${visibility[s.id] !== false ? "Hide" : "Show"} ${name}`}
												disabled={isDeleting}
											>
												{visibility[s.id] !== false ? <IconEye size={15} /> : <IconEyeOff size={15} />}
											</button>
											<span className="segpop__swatch" style={{ background: hex }} aria-hidden="true" />
											{/* The name is the row's select control, so a class can be
											    targeted from the keyboard (Enter or Space) and screen
											    readers hear whether it is. The row's own click stays as
											    the larger mouse target. */}
											<button
												type="button"
												className="segpop__name"
												title={s.label}
												aria-pressed={active}
												disabled={isDeleting}
												onClick={(e) => { e.stopPropagation(); onSelect(active ? null : s.id); }}
											>
												{s.label}
											</button>

											{!isDeleting && (
												<button
													className={`segpop__edit-btn ${isEditing ? "is-active" : ""}`}
													onClick={(e) => { e.stopPropagation(); startEdit(s.id, s.label, hex, e.currentTarget); }}
													aria-label={`Rename or recolor ${name}`}
													title="Rename / recolor"
												>
													<IconPencil size={13} />
												</button>
											)}
											<button
												className="segpop__delete"
												onClick={(e) => { e.stopPropagation(); if (!isDeleting) setConfirmDeleteId(s.id); }}
												aria-label={isDeleting ? `Deleting ${name}` : `Delete ${name}`}
												title={isDeleting ? "Deleting…" : "Delete class"}
												disabled={isDeleting}
											>
												{isDeleting ? <IconLoader2 size={13} className="segpop__spin" /> : <IconTrash size={13} />}
											</button>
										</div>
									);
								})}

								{/* Edit flyout: a single instance, floated next to whichever
								    row's pencil icon opened it, instead of expanding inline —
								    so the rest of the list never shifts and this can never get
								    stuck the way the old inline collapse could. Keyed by class:
								    another row's pencil starts a close on the open editor (an
								    outside click) before it opens its own, so reusing that
								    instance left the new editor stuck in .is-closing. */}
								{editingId != null && (() => {
									const s = segments.find((seg) => seg.id === editingId);
									if (!s) return null;
									const remaining = MAX_SEGMENT_NAME_LENGTH - editNameDraft.length;
									return (
										<FormFlyout key={editFormKey} anchorEl={editAnchorEl} onClose={() => closeEdit(editingId)} onClosingChange={setEditClosing}>
											{(requestClose) => (
												<div className="segpop__form-flyout-inner">
													<div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
														<div className="segpop__color-anchor">
															<button
																ref={editColorBtnRef}
																type="button"
																className="segpop__color segpop__color-btn"
																style={{ background: editColorDraft }}
																aria-label="Class color"
																title="Change color"
																onClick={() => setEditColorPopoverOpen((v) => !v)}
															/>
															{editColorPopoverOpen && (
																<ColorPickerPopover
																	value={editColorDraft}
																	onChange={setEditColorDraft}
																	onClose={() => setEditColorPopoverOpen(false)}
																	anchorRef={editColorBtnRef}
																/>
															)}
														</div>
														<input
															autoFocus
															className={`segpop__name-input ${renameError === s.id ? "is-error" : ""}`}
															aria-label="Class name"
															aria-invalid={renameError === s.id}
															aria-describedby={renameError === s.id ? nameErrorId : undefined}
															value={editNameDraft}
															maxLength={MAX_SEGMENT_NAME_LENGTH}
															onChange={(e) => { setEditNameDraft(e.target.value); setRenameError(null); }}
															onKeyDown={(e) => {
																// Enter and Escape in an IME composition belong to the IME.
																if (e.nativeEvent.isComposing || e.keyCode === 229) return;
																if (e.key === "Enter") { if (commitEdit(s.id)) requestClose(); }
																if (e.key === "Escape" && !escapeWasUsed(e.nativeEvent)) requestClose();
															}}
														/>
													</div>
													{renameError === s.id && <span id={nameErrorId} role="alert" className="segpop__err segpop__err--block">{editNameDraft.trim() ? "Name in use" : "Enter a name."}</span>}
													{renameError !== s.id && remaining <= 10 && (
														<span className="segpop__err segpop__err--block segpop__char-count">{remaining} character{remaining === 1 ? "" : "s"} left</span>
													)}
													<div className="segpop__row-actions">
														<ApplyButton className="segpop__add-confirm" onApply={() => commitEdit(s.id)} onDone={requestClose} label="Save" applyingLabel="Saving…" successLabel="Saved" />
														<button className="atb-action-btn segpop__add-cancel-text" onClick={requestClose}>
															<span className="atb-action-btn__label">Cancel</span>
														</button>
													</div>
												</div>
											)}
										</FormFlyout>
									);
								})()}

								{confirmDeleteId != null && (
									<GuidedStepModal
										title="Delete this class?"
										instruction={`"${segments.find((s) => s.id === confirmDeleteId)?.label ?? "This class"}" and its segmentation will be permanently removed. This can't be undone.`}
										primaryLabel="Delete"
										onPrimary={() => {
											const id = confirmDeleteId;
											setConfirmDeleteId(null);
											handleDelete(id);
										}}
										secondaryLabel="Cancel"
										onSecondary={() => setConfirmDeleteId(null)}
										onEscape={() => setConfirmDeleteId(null)}
										initialFocus="secondary"
									/>
								)}

								{/* "Add class" trigger stays put and always renders — the form
								    itself now lives in a floating FormFlyout (below) instead of
								    swapping this button out for an inline form, so there's no
								    "form got stuck open, button never came back" failure mode. */}
								{segments.length === 0 && (
									<p className="segpop__hint segpop__hint--empty">No custom classes yet. Add one to draw your own segmentation.</p>
								)}
								<div ref={addClassRef}>
									<button className={`segpop__new ${adding ? "is-active" : ""}`} onClick={startAdd}>
										<IconPlus size={15} /> Add class
									</button>
								</div>
								{adding && (
									<FormFlyout key={addFormKey} anchorEl={addAnchorEl} onClose={closeAddForm} onClosingChange={setAddClosing}>
										{(requestClose) => (
											<div className="segpop__form-flyout-inner">
												<div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
													<div className="segpop__color-anchor">
														<button
															ref={addColorBtnRef}
															type="button"
															className="segpop__color segpop__color-btn"
															style={{ background: draftColor }}
															aria-label="Class color"
															title="Change color"
															onClick={() => setAddColorPopoverOpen((v) => !v)}
														/>
														{addColorPopoverOpen && (
															<ColorPickerPopover
																value={draftColor}
																onChange={setDraftColor}
																onClose={() => setAddColorPopoverOpen(false)}
																anchorRef={addColorBtnRef}
															/>
														)}
													</div>
													<input
														autoFocus
														className={`segpop__name-input ${createError ? "is-error" : ""}`}
														placeholder="Class name"
														aria-invalid={!!createError}
														aria-describedby={createError ? nameErrorId : undefined}
														value={draftName}
														maxLength={MAX_SEGMENT_NAME_LENGTH}
														onChange={(e) => { setDraftName(e.target.value); setCreateError(""); }}
														onKeyDown={(e) => {
															// Enter and Escape in an IME composition belong to the IME.
															if (e.nativeEvent.isComposing || e.keyCode === 229) return;
															if (e.key === "Enter") { if (commitAdd()) requestClose(); }
															if (e.key === "Escape" && !escapeWasUsed(e.nativeEvent)) requestClose();
														}}
													/>
												</div>
												{createError && <span id={nameErrorId} role="alert" className="segpop__err segpop__err--block">{createError}</span>}
												{!createError && addRemaining <= 10 && (
													<span className="segpop__err segpop__err--block segpop__char-count">{addRemaining} character{addRemaining === 1 ? "" : "s"} left</span>
												)}
												<div className="segpop__row-actions">
													<ApplyButton className="segpop__add-confirm" onApply={commitAdd} onDone={requestClose} label="Add class" applyingLabel="Adding…" successLabel="Added" />
													<button className="atb-action-btn segpop__add-cancel-text" onClick={requestClose}>
														<span className="atb-action-btn__label">Cancel</span>
													</button>
												</div>
											</div>
										)}
									</FormFlyout>
								)}
							</>
						)}
						</div>
					</div>


		</div>,
		document.body
	);
}