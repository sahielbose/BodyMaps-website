// Shared building blocks for every "click a tool icon -> settings flyout"
// surface in the annotation toolbar, plus the text-menu rows used inside
// those flyouts (Margin, Hollow, Islands, Scissors' operation picker,
// etc). Nothing tool-specific lives here — see GrowFromSeedFlyout.tsx,
// HollowFlyout.tsx, MarginPanel.tsx, etc. for the per-tool panels built
// out of these pieces.
import { Children, cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconChevronDown, IconChevronRight, IconCheck } from "@tabler/icons-react";
import { focusableWithin } from "../../hooks/useDialogFocus";
import { escapeWasUsed, markEscapeUsed } from "../../helpers/viewer/escapeUsed";
import { initialFocusTarget } from "../../helpers/viewer/useToolbarFlyout";
import { prefersReducedMotion } from "../../helpers/motion";
import "../viewer/FlyoutPrimitives.css";

export interface FlyoutState {
	open: boolean;
	setOpen: React.Dispatch<React.SetStateAction<boolean>>;
	/** The element the panel is anchored to/positioned relative to. Also
	 *  used as the "click here doesn't count as outside" boundary. */
	anchorRef: React.RefObject<HTMLElement | null>;
	/** The portaled panel's own root — also part of the outside-click
	 *  boundary, so clicking inside the open panel never closes it. */
	panelRef: React.RefObject<HTMLDivElement | null>;
	/** Closes the panel the way an outside click does, onOutsideClose
	 *  included. Pass it to FlyoutPanel's `onDismiss` so Escape and tabbing
	 *  out of the panel leave it the same way. */
	dismiss: () => void;
}

// Every currently-mounted flyout registers itself here so opening one can
// close every other registered flyout within the same `scope`, keeping at
// most one panel open per scope at a time (e.g. one grandchild row open in
// Margin/Hollow/Islands/Logical Operators). Different scopes don't affect
// each other — this is what lets a top-level tool-settings flyout ("top")
// stay open while a grandchild option panel ("grandchild") opens inside
// it. Not used to detect outside clicks — see the
// `.atb-pop__panel`/`.atb-pop__overlay` class check below for that.
let flyoutIdCounter = 0;
const openFlyouts = new Set<{ id: number; scope: string; close: () => void }>();

/** One open/closed flyout's worth of state — anchor a MenuRow/tool icon to
 *  `anchorRef`, pass `open`/`panelRef` straight into a <FlyoutPanel>, and
 *  it closes itself on an outside click automatically.
 *
 *  `closeOnOutsideClick` (default true) can be set to false for a flyout
 *  whose content drives interaction OUT on the CT canvas itself (guided
 *  slice-anchor picks, grow-from-seeds scribbling, island picking) — for
 *  those, every click on the viewer is a legitimate "outside" click by
 *  position, but closing the flyout would unmount the very walkthrough
 *  state that click was meant to feed. Those tools close only in response
 *  to an explicit action (re-clicking the tool icon, Apply, Start over,
 *  cancel), never from an incidental outside click.
 *
 *  `scope` (default "default") groups flyouts for the "opening one closes
 *  its siblings" behavior — see the comment on `openFlyouts` above. Pass
 *  "top" for a tool's own top-level settings flyout and "grandchild" for
 *  any panel opened from a MenuRow inside it, so the two never fight. */

// eslint-disable-next-line react-refresh/only-export-components
export function useFlyout(initialOpen = false, options?: { closeOnOutsideClick?: boolean; scope?: string; onOutsideClose?: () => void }): FlyoutState {
	const closeOnOutsideClick = options?.closeOnOutsideClick ?? true;
	const scope = options?.scope ?? "default";
	const onOutsideClose = options?.onOutsideClose;
	const id = useRef(0);
	if (id.current === 0) id.current = ++flyoutIdCounter;
	const [open, setOpenState] = useState(initialOpen);
	const anchorRef = useRef<HTMLElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	// Latest onOutsideClose, so a dismissal reads the caller's current state
	// (the active tool can change while the panel stays open).
	const onOutsideCloseRef = useRef(onOutsideClose);
	useEffect(() => {
		onOutsideCloseRef.current = onOutsideClose;
	}, [onOutsideClose]);
	// Distinct from other ways this flyout closes (Apply, Exit, re-clicking
	// the tool icon, ...). This is "clicked away from it" (or Escape, or
	// tabbed out of it), which should also fully deselect the owning tool.
	// Callers wire that up in onOutsideClose rather than this hook reaching
	// into tool-selection state itself.
	const dismiss = useCallback(() => {
		setOpenState(false);
		onOutsideCloseRef.current?.();
	}, []);

	const setOpen = useCallback<React.Dispatch<React.SetStateAction<boolean>>>((value) => {
		setOpenState((prev) => {
			const next = typeof value === "function" ? (value as (p: boolean) => boolean)(prev) : value;
			if (next) {
				// Close every other flyout in the same scope, without
				// affecting a different-scope parent/ancestor flyout.
				openFlyouts.forEach((entry) => { if (entry.id !== id.current && entry.scope === scope) entry.close(); });
			}
			return next;
		});
	}, [scope]);

	useEffect(() => {
		const entry = { id: id.current, scope, close: () => setOpenState(false) };
		openFlyouts.add(entry);
		return () => { openFlyouts.delete(entry); };
	}, [scope]);

	useEffect(() => {
		if (!open || !closeOnOutsideClick) return;
		const onPointerDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (anchorRef.current?.contains(t) || panelRef.current?.contains(t)) return;
			// A grandchild panel is portaled to <body> as a DOM sibling of
			// this flyout's panelRef, not a descendant, so without this
			// check a click inside an open grandchild would register as an
			// outside click on the parent and close it before the row's
			// own onClick fires.
			if (t instanceof Element && (t.closest(".atb-pop__panel") || t.closest(".atb-pop__overlay"))) return;
			// The settings arrow sits outside anchorRef/panelRef (the panel
			// anchors to the tool's icon), so its press is skipped here rather
			// than stopped at the button. Pressing it to CLOSE an open flyout
			// would otherwise dismiss it on mousedown and the arrow's own
			// onClick would reopen it. Leaving the event to bubble still lets
			// every other document-level closer (class editor, colour popover,
			// top-bar flyouts) see the press.
			if (t instanceof Element && t.closest(".atb-pop__arrow")) return;
			dismiss();
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, closeOnOutsideClick]);

	return { open, setOpen, anchorRef, panelRef, dismiss };
}

/** The small standalone downward-chevron trigger that sits directly next to
 *  a tool icon in the ribbon (paint/erase/scissors/level-tracing — the
 *  "equip and use" tools that keep a separate settings arrow). Every other
 *  tool opens its settings straight from the icon click, so this is only
 *  ever used for that one group. */
export function FlyoutArrow({
	open, onClick, label,
}: {
	open: boolean;
	onClick: () => void;
	label: string;
}) {
	return (
		<button
			type="button"
			className={`atb-pop__arrow ${open ? "is-open" : ""}`}
			onClick={onClick}
			aria-label={label}
			aria-expanded={open}
			aria-haspopup="dialog"
		>
			<IconChevronDown size={14} stroke={2.25} />
		</button>
	);
}

/** Body class set while an open flyout sits against the right edge of the
 *  screen. The panes' slice-slider thumbs live in that outer strip, so
 *  the stylesheet hides them while it is set rather than let their tips show
 *  beside the panel's rounded corner. A set of panels, so one closing never
 *  clears the class for another that is still at the edge. */
const EDGE_CLASS = "atb-flyout-at-edge";
const panelsAtEdge = new Set<object>();

/** The portaled popup rectangle itself — positioned against `anchorRef`,
 *  either directly below it (a tool's top-level settings flyout) or to its
 *  right (a grandchild opened from a MenuRow inside another flyout).
 *  Opening and closing are the caller's job via `useFlyout`; this component
 *  handles "where does the box go", "render it above everything" and
 *  keyboard focus in and out of it. */
export function FlyoutPanel({
	open,
	anchorRef,
	panelRef,
	placement = "below",
	minWidth,
	children,
	keepMounted = false,
	anchorKey,
	label,
	onDismiss,
}: {
	open: boolean;
	anchorRef: React.RefObject<HTMLElement | null>;
	panelRef: React.RefObject<HTMLDivElement | null>;
	placement?: "below" | "right";
	minWidth?: number;
	children: React.ReactNode;
	/** Accessible name, e.g. "Brush settings". The panel is a dialog only
	 *  when it has one. */
	label?: string;
	/** Escape, or tabbing past either end of the panel, calls this (pass
	 *  useFlyout's `dismiss`). Without it the panel ignores those keys. */
	onDismiss?: () => void;
	/** Bump this (e.g. pass the active tool's id) whenever `anchorRef.current`
	 *  is swapped to point at a DIFFERENT element while the panel is already
	 *  open. `anchorRef` is a plain ref — mutating `.current` doesn't change
	 *  its identity, so the position effect below (keyed on `[open, anchorRef,
	 *  placement]`) would never re-run and the panel would stay glued to the
	 *  OLD icon's position (e.g. Hollow's flyout appearing to open under
	 *  Brush after switching tools without ever closing first). Including
	 *  `anchorKey` in the effect's dependencies forces a reposition any time
	 *  the caller tells us the anchor target actually changed. */
	anchorKey?: string | number | null;
	/** When true, children stay MOUNTED in the DOM (just visually hidden via
	 *  `display:none`) instead of being torn down whenever `open` goes
	 *  false. Required for any flyout whose content owns state/portals that
	 *  must survive a settings-close — GrowFromSeeds, CopyAcrossSlices,
	 *  FillBetweenSlices, and Islands all call `onCloseSettings` (which sets
	 *  `open` false) the INSTANT their guided full-screen overlay takes
	 *  over. Without `keepMounted`, that close was unmounting the component
	 *  (and its portaled overlay, and its picker hook state) before the
	 *  overlay ever had a chance to render — the overlay simply never
	 *  appeared. With `keepMounted`, the panel box hides but the component
	 *  tree — and the overlay it portals to <body> — stays alive. */
	keepMounted?: boolean;
}) {
	// `pointer` is the offset (along the panel's top edge for "below", or
	// its left edge for "right") of the little blue-bordered arrow that
	// connects the panel back to the ribbon icon it opened from — see
	// .atb-pop__pointer. Computed off the anchor's own center, same
	// approach as SegmentsPopup's FormFlyout arrowLeft.
	const [pos, setPos] = useState<{ top: number; left: number; pointer: number } | null>(null);
	// The latest position calculation, for the size observer below.
	const computeRef = useRef<() => void>(() => {});

	// How long the panel's grow-in/shrink-out transition takes — mirrors the
	// entrance animation's own duration (see .atb-pop__panel's
	// atb-pop-grow-in keyframes) so opening and closing feel symmetric.
	const PANEL_ANIM_MS = 160;
	// True from the render where `open` goes false until the shrink/fade-out
	// has had time to play, so the panel stays shown (and a non-keepMounted
	// one stays mounted) while it eases out. Set during that same render, not
	// in an effect: an effect only ran after the first closed commit had
	// already hidden (display:none) or unmounted the panel, which then came
	// back already faded with nothing left to transition.
	const [closing, setClosing] = useState(false);
	const [prevOpen, setPrevOpen] = useState(open);
	// The anchorKey the panel last showed while open, to tell when a close
	// also swaps the content for another tool's.
	const [shownKey, setShownKey] = useState(anchorKey);
	// A static copy of the panel's last content, faded out in place of the
	// live children when a close also takes that content away: a deselected
	// tool (Apply, Escape, an outside click) leaves no children, and a switch
	// to a tool whose settings stay shut brings that tool's instead. A copy
	// of the DOM rather than the old React children, so the departing tool
	// still unmounts at once and its cleanup (window listeners, guided
	// controls) runs exactly when it always did.
	const [departing, setDeparting] = useState<Node[] | null>(null);
	// Whether focus was inside the panel when it began to close. A one-shot
	// action (Smooth, Grow, Hollow...) deselects its tool, which unmounts the
	// focused button with the panel's content, so by the time the focus effect
	// runs the active element is already <body> and `panel.contains` says no.
	const focusWasInsideRef = useRef(false);
	if (open !== prevOpen) {
		if (!open) {
			// Read during render, before this commit unmounts what has focus.
			// eslint-disable-next-line react-hooks/refs
			focusWasInsideRef.current = !!panelRef.current?.contains(document.activeElement);
		}
		setPrevOpen(open);
		setClosing(!open);
		setDeparting(null);
	}
	if (open && anchorKey !== shownKey) setShownKey(anchorKey);
	const contentLeaves = children == null || children === false || anchorKey !== shownKey;
	if (closing && !open && contentLeaves && departing === null) {
		// Read during render, before this commit replaces what's on screen.
		// eslint-disable-next-line react-hooks/refs
		setDeparting(copyPanelContent(panelRef.current));
	}

	useEffect(() => {
		if (!closing) return;
		// A timer, not transitionend, which never fires when the transition
		// is skipped (reduced motion, a panel that never painted) and would
		// leave the panel stuck closing.
		const id = window.setTimeout(() => {
			setClosing(false);
			setDeparting(null);
			if (!keepMounted) setPos(null);
		}, prefersReducedMotion() ? 0 : PANEL_ANIM_MS);
		return () => window.clearTimeout(id);
	}, [closing, keepMounted]);

	useEffect(() => {
		if (!open) {
			// Position is now cleared by the close-timer above (once the
			// shrink/fade-out transition finishes) rather than instantly here,
			// so a non-keepMounted panel keeps rendering at its correct spot
			// for the duration of that transition instead of jumping to
			// top:-9999 the instant `open` flips false.
			return;
		}
		const compute = () => {
			const el = anchorRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			const margin = 8;
			const vw = typeof window !== "undefined" ? window.innerWidth : 1024;
			const vh = typeof window !== "undefined" ? window.innerHeight : 768;
			// The panel's real width once it has rendered (the pass below re-runs
			// this whenever its size changes), so the clamp keeps it fully on
			// screen whatever its content. Before its first render there is no
			// width to read, so estimate from minWidth — every caller passes one
			// for panels that could realistically hit an edge.
			const measured = panelRef.current?.offsetWidth ?? 0;
			const estWidth = measured || (minWidth ?? 240);
			let left: number;
			let top: number;
			if (placement === "right") {
				left = r.right + margin;
				top = r.top;
				if (left + estWidth > vw - margin) {
					// Not enough room to the right of the anchor — flip to its left.
					left = Math.max(margin, r.left - estWidth - margin);
				}
			} else {
				left = r.left;
				top = r.bottom + margin;
				if (left + estWidth > vw - margin) left = Math.max(margin, vw - estWidth - margin);
			}
			left = Math.max(margin, left);
			top = Math.min(top, vh - margin - 40);
			// Point the arrow at the anchor's own center, clamped to stay
			// within the panel's (estimated) bounds — same clamping idea as
			// SegmentsPopup's FormFlyout arrowLeft, just axis-swapped for
			// "right" panels (offset down their left edge instead of across
			// their top edge).
			const pointer = placement === "right"
				? Math.max(14, Math.min(r.top + r.height / 2 - top, (panelRef.current?.offsetHeight ?? 200) - 14))
				: Math.max(14, Math.min(r.left + r.width / 2 - left, estWidth - 14));
			// Same spot as last time: keep the state (and skip a render), so
			// measuring after every size change can't loop.
			setPos((cur) => (cur && cur.top === top && cur.left === left && cur.pointer === pointer ? cur : { top, left, pointer }));
		};
		computeRef.current = compute;
		compute();
		window.addEventListener("resize", compute);
		window.addEventListener("scroll", compute, true);
		return () => {
			window.removeEventListener("resize", compute);
			window.removeEventListener("scroll", compute, true);
		};
	}, [open, anchorRef, placement, anchorKey]);

	// The first pass positions the panel before it exists, so its width is
	// unknown: once it renders, and again whenever its content resizes,
	// place it from its real width so it never runs off the screen edge.
	const placed = pos !== null;
	useLayoutEffect(() => {
		const panel = panelRef.current;
		if (!open || !placed || !panel) return;
		computeRef.current();
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => computeRef.current());
		ro.observe(panel);
		return () => ro.disconnect();
	}, [open, placed, anchorKey, panelRef]);

	// The panel reaches the screen's right edge (the clamp in compute() stops
	// it 8px short): flag the body so the slice sliders under that strip hide.
	const [edgeToken] = useState(() => ({}));
	useEffect(() => {
		const panel = panelRef.current;
		const atEdge = open && pos !== null && !!panel && pos.left + panel.offsetWidth >= window.innerWidth - 9;
		if (atEdge) panelsAtEdge.add(edgeToken);
		else panelsAtEdge.delete(edgeToken);
		document.body.classList.toggle(EDGE_CLASS, panelsAtEdge.size > 0);
		return () => {
			panelsAtEdge.delete(edgeToken);
			document.body.classList.toggle(EDGE_CLASS, panelsAtEdge.size > 0);
		};
	}, [open, pos, panelRef, edgeToken]);

	// Keyboard access, the same disclosure pattern as the viewer toolbar's
	// flyouts (see useToolbarFlyout): focus moves into the panel when it
	// opens, Escape dismisses it, and tabbing past either end dismisses it and
	// carries on from the control that opened it, as if the panel sat right
	// after that control. Without this the panel, portaled to the end of
	// <body>, was only reachable by tabbing through the rest of the page.
	const openerRef = useRef<HTMLElement | null>(null);
	const onDismissRef = useRef(onDismiss);
	useEffect(() => {
		onDismissRef.current = onDismiss;
	}, [onDismiss]);
	const shown = open && pos !== null;
	useEffect(() => {
		const panel = panelRef.current;
		if (!panel) return;
		const active = document.activeElement;
		if (!shown) {
			// Closed while focus was still inside (a mode picked with the
			// keyboard): hand it back rather than lose it with the panel.
			// The same goes for focus the closing panel already dropped to
			// <body> (its focused button unmounted with the content).
			const wasInside = focusWasInsideRef.current;
			focusWasInsideRef.current = false;
			if (
				active instanceof Node
				&& (panel.contains(active) || (wasInside && (active === document.body || !active.isConnected)))
			) openerRef.current?.focus({ preventScroll: true });
			return;
		}
		// Safari doesn't focus a clicked button, so fall back to the anchor's.
		const anchor = anchorRef.current;
		openerRef.current = active instanceof HTMLElement && active !== document.body && !panel.contains(active)
			? active
			: anchor?.closest<HTMLElement>("button") ?? anchor?.querySelector<HTMLElement>("button") ?? null;
		const target = initialFocusTarget(panel);
		if (target === panel && !panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
		target.focus({ preventScroll: true });
		// Only on open (or a switch to another tool's settings), not on every
		// render, which would pull focus back into the panel.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [shown, anchorKey]);

	useEffect(() => {
		if (!shown) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const panel = panelRef.current;
			const dismiss = onDismissRef.current;
			if (!panel || !dismiss) return;
			const active = document.activeElement;
			const inside = active instanceof Node && panel.contains(active);
			const opener = openerRef.current;
			if (e.key === "Escape") {
				// Bubble phase plus the used check, so a popover or dialog in or
				// over the panel takes its own Escape first. Marked as used, so
				// the viewer doesn't also disarm the tool with it.
				if (escapeWasUsed(e)) return;
				markEscapeUsed(e);
				dismiss();
				if (inside || active === document.body) opener?.focus({ preventScroll: true });
				return;
			}
			if (e.key !== "Tab" || !inside) return;
			// Radios that are not their group's Tab stop (tabindex -1) are left
			// out: the browser skips them, so they are not where Tab leaves from.
			const items = focusableWithin(panel).filter((el) => el.getAttribute("tabindex") !== "-1");
			// A radio focused with the arrow keys is not the group's Tab stop;
			// treat the group as one stop so Tab still leaves from its end.
			const stop = active instanceof HTMLElement && active.getAttribute("role") === "radio"
				? active.closest('[role="radiogroup"]')?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]') ?? active
				: active;
			if (e.shiftKey && (stop === items[0] || stop === panel)) {
				e.preventDefault();
				dismiss();
				opener?.focus({ preventScroll: true });
			} else if (!e.shiftKey && (stop === items[items.length - 1] || stop === panel || items.length === 0)) {
				e.preventDefault();
				const order = focusableWithin(document.body).filter((el) => !panel.contains(el));
				const next = opener ? order[order.indexOf(opener) + 1] : undefined;
				dismiss();
				(next ?? opener)?.focus({ preventScroll: true });
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [shown, panelRef]);

	// Non-persistent flyouts: stay mounted through `closing` so the
	// shrink/fade-out transition can play, and unmount once it's done (pos
	// gets cleared by the timer above at that point).
	if (!keepMounted && (!(open || closing) || !pos || typeof document === "undefined")) return null;
	// Persistent flyouts: nothing to portal yet if it's never been opened
	// (no anchor position computed) — still fine to unmount in that case,
	// there's no state to lose.
	if (keepMounted && (!pos || typeof document === "undefined")) return null;
	if (!pos || typeof document === "undefined") return null;

	return createPortal(
		<div
			ref={panelRef}
			role={label ? "dialog" : undefined}
			aria-label={label}
			className={`atb-pop__panel ${placement === "right" ? "atb-pop__panel--right" : "atb-pop__panel--below"} ${!open ? "is-closing" : ""}`}
			style={{
				position: "fixed",
				top: pos.top,
				left: pos.left,
				// What a short viewport has left under the panel's top edge, for
				// the scroll cap on its content (see FlyoutPrimitives.css).
				["--atb-pop-top" as string]: `${pos.top}px`,
				minWidth,
				// Keep-mounted panels fade/scale out via the is-closing CSS
				// class instead of vanishing behind display:none — but once
				// that transition has actually finished (closing === false
				// and still not open), fall back to display:none so the
				// invisible box can't intercept clicks meant for the canvas
				// underneath it.
				display: keepMounted && !open && !closing ? "none" : undefined,
			}}
		>
			{/* Blue-bordered pointer connecting this panel back to the
			 *  ribbon icon (or row) it opened from — same rotated-square
			 *  technique as SegmentsPopup's .segpop__form-flyout-arrow,
			 *  but with a Hopkins-blue border so it doubles as a clear
			 *  "this panel belongs to that button" cue. Sits on the top
			 *  edge for a "below" panel, the left edge for a "right" one. */}
			<span
				className={`atb-pop__pointer ${placement === "right" ? "atb-pop__pointer--left" : "atb-pop__pointer--top"}`}
				style={placement === "right" ? { top: pos.pointer } : { left: pos.pointer }}
			/>
			{closing && departing ? <DepartingCopy nodes={departing} /> : children}
		</div>,
		document.body
	);
}

/** Copies a panel's content (everything but its pointer) for DepartingCopy,
 *  ids dropped so no id is on the page twice while the copy fades. */
function copyPanelContent(panel: HTMLElement | null): Node[] {
	if (!panel) return [];
	return Array.from(panel.children)
		.filter((el) => !el.classList.contains("atb-pop__pointer"))
		.map((el) => {
			const copy = el.cloneNode(true) as Element;
			copy.removeAttribute("id");
			copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
			return copy;
		});
}

/** The copy a closing panel fades out once its live content has gone (see
 *  `departing` in FlyoutPanel). Inert and hidden from assistive tech: it
 *  only looks like the panel that just closed. */
function DepartingCopy({ nodes }: { nodes: Node[] }) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		host.replaceChildren(...nodes);
		return () => host.replaceChildren();
	}, [nodes]);
	return <div ref={hostRef} className="atb-pop__departing" aria-hidden="true" inert />;
}

/** A vertical stack of MenuRows — the Google-Docs-style column layout used
 *  by Margin, Hollow, Islands, and the Scissors operation picker. */
export function MenuColumn({ children, role, ariaLabel }: { children: React.ReactNode; role?: "radiogroup"; ariaLabel?: string }) {
	let rows = children;
	if (role === "radiogroup") {
		// With nothing checked the group would have no Tab stop; the first
		// radio takes it, as in the ARIA radio pattern.
		const list = Children.toArray(children);
		const isRadio = (c: React.ReactNode): c is React.ReactElement<{ open?: boolean }> =>
			isValidElement(c) && c.type === MenuRow && !!(c.props as { radio?: boolean }).radio;
		const firstRadio = list.findIndex(isRadio);
		if (firstRadio >= 0 && !list.some((c) => isRadio(c) && c.props.open)) {
			rows = list.map((c, i) => (i === firstRadio && isValidElement(c) ? cloneElement(c, { tabStop: true } as object) : c));
		}
	}
	return (
		<div className="atb-menu-col" role={role} aria-label={ariaLabel} onKeyDown={role === "radiogroup" ? moveRadioFocus : undefined}>
			{rows}
		</div>
	);
}

/** The arrow keys, Home and End move focus between the radios of a group,
 *  wrapping at the ends. They only move focus: picking stays with Space,
 *  Enter or a click, so a flyout that closes on a pick (Scissors) does not
 *  close on every arrow press. */
function moveRadioFocus(e: React.KeyboardEvent<HTMLDivElement>) {
	if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
	const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)'));
	const at = radios.indexOf(e.target as HTMLElement);
	if (at < 0) return;
	let next: number;
	if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (at + 1) % radios.length;
	else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (at - 1 + radios.length) % radios.length;
	else if (e.key === "Home") next = 0;
	else if (e.key === "End") next = radios.length - 1;
	else return;
	e.preventDefault();
	radios[next].focus({ preventScroll: true });
}

/** One row of plain text inside a MenuColumn. Two roles, distinguished by
 *  whether `rowRef` is passed:
 *   - with `rowRef`: this row opens a grandchild flyout to its right
 *     (`open` = whether that grandchild is currently open) — gets a
 *     trailing chevron.
 *   - without `rowRef`: a direct one-shot action row (e.g. Islands' "Keep
 *     largest", a Scissors operation choice) — `open` just marks it as the
 *     current selection, no chevron since there's nothing to open. */
export function MenuRow({
	label,
	onClick,
	onHover,
	onLeave,
	open,
	rowRef,
	disabled,
	expandIcon,
	pill,
	radio,
	tabStop,
}: {
	label: string;
	onClick?: () => void;
	/** Called on mouseenter — for rows that open a grandchild, pass
	 *  `() => grandchild.setOpen(true)` so hovering (not just clicking)
	 *  opens it, matching how Google Docs' own nested menus behave. */
	onHover?: () => void;
	/** Called on mouseleave — paired with `onHover` for rows whose
	 *  grandchild should close again once the pointer isn't over the row
	 *  (or the grandchild panel itself) anymore, instead of staying open
	 *  indefinitely after a single hover. See `GrandchildRow` below, which
	 *  wires this up for you. */
	onLeave?: () => void;
	open?: boolean;
	rowRef?: React.Ref<HTMLButtonElement>;
	disabled?: boolean;
	/** This row expands its own extra settings as a card that opens to its
	 *  RIGHT (see GrandchildRow / .atb-menu-expand__body), not an inline
	 *  accordion — the chevron reflects that: it points right at rest (the
	 *  direction the card will open) and rotates to point left once
	 *  expanded, echoing "this is where it opened from, click to send it
	 *  back". Rendered inside its own small rounded chip (see
	 *  `.atb-menu-row__expand-chip`) rather than a bare inline glyph — that
	 *  chip is what keeps this reading as a distinct "opens a panel"
	 *  affordance instead of being mistaken for ActionButton's plain
	 *  trailing arrow (Islands' "Remove picked" etc.), which performs an
	 *  edit immediately and never rotates. */
	expandIcon?: boolean;
	/** Draw the row as a bordered pill like an ActionButton, for a row that
	 *  sits among ActionButtons (Islands' "Remove small") instead of a plain
	 *  list of rows. */
	pill?: boolean;
	/** Expose the row as one choice of a radio group (inside a MenuColumn with
	 *  role="radiogroup"); `open` then also means checked. */
	radio?: boolean;
	/** Make this radio the group's Tab stop although it is not checked (set by
	 *  MenuColumn on the first radio when none is checked). */
	tabStop?: boolean;
}) {
	return (
		<button
			ref={rowRef}
			type="button"
			className={`atb-menu-row ${pill ? "atb-menu-row--pill" : ""} ${open ? "is-active" : ""}`}
			onClick={onClick}
			onMouseEnter={onHover}
			onMouseLeave={onLeave}
			disabled={disabled}
			aria-expanded={expandIcon ? !!open : undefined}
			aria-pressed={!radio && !expandIcon && !rowRef && open !== undefined ? open : undefined}
			role={radio ? "radio" : undefined}
			aria-checked={radio ? !!open : undefined}
			// One Tab stop per group, on the checked choice; the arrow keys
			// reach the rest (see MenuColumn).
			tabIndex={radio ? (open || tabStop ? 0 : -1) : undefined}
		>
			<span className="atb-menu-row__label">{label}</span>
			{expandIcon ? (
				<span className={`atb-menu-row__expand-chip ${open ? "is-open" : ""}`} aria-hidden="true">
					<IconChevronRight
						size={12}
						stroke={2.25}
						className={`atb-menu-row__expand-chevron ${open ? "is-open" : ""}`}
					/>
				</span>
			) : (
				<>
					{/* Leaf rows (no rowRef) show a check when selected; rows that
					 *  open a further grandchild show a chevron instead. */}
					{!rowRef && open && <IconCheck size={14} stroke={2.5} className="atb-menu-row__check" />}
					{rowRef && <IconChevronRight size={13} stroke={2.25} className="atb-menu-row__chevron" />}
				</>
			)}
		</button>
	);
}

/** Added to a GrandchildRow's card when it would run off the right edge of the
 *  screen beside its row; the stylesheet then lays it out in the column. */
const CARD_INLINE_CLASS = "atb-menu-expand__body--inline";
/** How close to the screen's edge the card may get, matching FlyoutPanel's margin. */
const CARD_EDGE_GAP = 8;

/** A MenuRow that reveals its extra settings INLINE, directly beneath
 *  itself in the same column — a plain accordion, like a nested item in a
 *  Google Docs / Notion menu, rather than a second floating rectangle
 *  popped out to the side. Click to expand/collapse; only ever one flat
 *  surface on screen, indented and rail-marked so the hierarchy still
 *  reads clearly without needing its own box, border, or shadow.
 *
 *  This used to portal a separate `.atb-pop__panel` off to the right,
 *  independently positioned via `getBoundingClientRect`. That's what
 *  produced the "rectangle inside a rectangle" look, and — since its
 *  position was computed from a live anchor element — was also the thing
 *  that ended up stranded in the top-left corner if that anchor ever
 *  unmounted (e.g. the whole toolbar closing) while it was open. Going
 *  fully inline removes both problems: there's no separate position to
 *  compute, and nothing to get orphaned. */
export function GrandchildRow({
	label,
	children,
	expanded: expandedProp,
	onToggle,
	pill,
}: {
	label: string;
	children: React.ReactNode;
	/** Style the row like an ActionButton — see MenuRow's `pill`. */
	pill?: boolean;
	/** Controlled mode — pass both together. Lets a parent coordinate
	 *  several GrandchildRows so opening one closes any other that's
	 *  already open (see LogicalOperatorsPanel, which has one row per
	 *  operation). When omitted, the row falls back to managing its own
	 *  open/closed state internally, as before — fine for a lone row
	 *  like Islands' "Remove small". */
	expanded?: boolean;
	onToggle?: () => void;
	/** @deprecated no longer used now that this renders inline — kept so
	 *  existing call sites don't need to change. */
	minWidth?: number;
}) {
	const [internalExpanded, setInternalExpanded] = useState(false);
	const isControlled = expandedProp !== undefined && !!onToggle;
	const expanded = isControlled ? expandedProp : internalExpanded;
	const toggle = isControlled ? onToggle! : () => setInternalExpanded((v) => !v);

	// The card hangs off the right of its row, and FlyoutPanel clamps the panel
	// by the panel's own width only, so between phone and desktop widths the
	// card can end past the screen's edge (a fixed panel cannot be scrolled to
	// it). When it would, it drops into the column beneath its row instead, as
	// it already does on a phone (see the media queries in the stylesheet). A
	// flip to the left would not help: there is no room on that side either.
	const anchorRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		if (!expanded) return;
		const fit = () => {
			const anchor = anchorRef.current;
			const body = bodyRef.current;
			// A card in a closed (display:none) panel has no box to measure; keep
			// the layout it had until the panel is shown again (see the observer).
			if (!anchor || !body || body.offsetWidth === 0) return;
			// Measure where the card sits beside the row, not where it sits now.
			// offsetLeft/offsetWidth ignore the slide-in transform.
			body.classList.remove(CARD_INLINE_CLASS);
			const right = anchor.getBoundingClientRect().left + body.offsetLeft + body.offsetWidth;
			body.classList.toggle(CARD_INLINE_CLASS, right > window.innerWidth - CARD_EDGE_GAP);
		};
		fit();
		// FlyoutPanel re-places itself on a resize in its own listener, so the
		// row has only moved by the time this second pass runs.
		let later = 0;
		const onResize = () => {
			fit();
			window.clearTimeout(later);
			later = window.setTimeout(fit, 120);
		};
		window.addEventListener("resize", onResize);
		// The Islands panel stays mounted while closed, so a resize in that time
		// was skipped above; the card gets its box back when the panel reopens.
		const bodyEl = bodyRef.current;
		const ro = typeof ResizeObserver === "undefined" || !bodyEl ? null : new ResizeObserver(fit);
		ro?.observe(bodyEl!);
		return () => {
			window.removeEventListener("resize", onResize);
			window.clearTimeout(later);
			ro?.disconnect();
		};
	}, [expanded]);

	return (
		<div className="atb-menu-expand" ref={anchorRef}>
			<MenuRow
				label={label}
				open={expanded}
				expandIcon
				pill={pill}
				onClick={toggle}
			/>
			{expanded && <div className="atb-menu-expand__body" ref={bodyRef}>{children}</div>}
		</div>
	);
}
/** A thin horizontal rule for separating a slider from the button/row
 *  group beneath it inside a flyout — the one line every flyout with both
 *  a numeric field and a set of actions should carry between them, so the
 *  two groups read as distinct steps instead of running together. */
export function MenuDivider() {
	return <div className="atb-menu-divider" role="separator" />;
}

/** A vertical stack of ActionButtons — same column shape as MenuColumn,
 *  used specifically for one-shot "do this now" actions (Margin's Grow/
 *  Shrink, Smoothing's Smooth, Islands' direct/pick operations, Grow-from-
 *  Seeds' scope pick) so they're visually distinct from a MenuColumn of
 *  MODE rows (Scissors' operation, Level Tracing's mode) even though both
 *  are plain vertical lists. */
export function ActionList({ children }: { children: React.ReactNode }) {
	return <div className="atb-action-list">{children}</div>;
}

/** A one-shot action row styled like ApplyButton (solid white pill, black
 *  text) rather than a plain menu row — used for anything that PERFORMS an
 *  edit immediately when clicked (Margin's Grow/Shrink, Smoothing's Smooth,
 *  Islands' operations, Grow-from-Seeds' scope pick), as opposed to picking
 *  a persistent MODE (Scissors' operation, Level Tracing's mode — those stay
 *  MenuRow with a trailing check). A trailing arrow marks it as "runs the
 *  action", swapping for a small spinner while `busy` is true — the same
 *  affordance ApplyButton uses, just laid out to sit naturally in a column
 *  instead of standing alone. */
export function ActionButton({
	label,
	runningLabel,
	busy,
	success,
	successLabel,
	disabled,
	onClick,
	title,
}: {
	label: string;
	/** Shown instead of `label` while `busy` is true — e.g. "Growing…". */
	runningLabel?: string;
	busy?: boolean;
	/** True for a brief beat right after the action commits — swaps the
	 *  trailing arrow/spinner for a Hopkins-blue checkmark and the label
	 *  for `successLabel` (falls back to "Done"), so the person sees an
	 *  explicit confirmation instead of the button just quietly vanishing
	 *  as the flyout closes underneath it. Caller owns the timing: flip
	 *  this true once the op resolves, hold it for ~500-700ms, THEN call
	 *  onApplied — the flyout's own close transition (see FlyoutPanel's
	 *  `closing` state) takes it from there, so the checkmark is visibly
	 *  on screen for a beat before the whole panel fades/shrinks away
	 *  instead of the two happening in the same instant. */
	success?: boolean;
	successLabel?: string;
	disabled?: boolean;
	onClick: () => void;
	/** Optional native hover tooltip — for a longer explanation that
	 *  doesn't fit in the button's own (short, verb-first) label. */
	title?: string;
}) {
	return (
		<>
			<button
				type="button"
				className={`atb-action-btn ${success ? "is-success" : ""}`}
				// Busy and success are aria-disabled, not disabled, so a focused
				// button keeps focus through the beat (see ApplyButton). Callers
				// also fold their own busy state into `disabled` to lock the
				// sibling buttons, so it only counts when this one is idle.
				onClick={busy || success ? undefined : onClick}
				disabled={disabled && !busy && !success}
				aria-disabled={busy || success || undefined}
				aria-busy={busy || undefined}
				title={title}
			>
				<span className="atb-action-btn__label">
					{success ? (successLabel ?? "Done") : busy ? (runningLabel ?? label) : label}
				</span>
				{success ? (
					<IconCheck size={14} stroke={3} className="atb-action-btn__check" />
				) : busy ? (
					<span className="atb-action-btn__spinner" aria-hidden="true" />
				) : (
					<IconChevronRight size={14} stroke={2.5} className="atb-action-btn__arrow" />
				)}
			</button>
			{/* The button disables itself while it works, so its changing label
			 *  is not read out; this stays mounted so the change is announced. */}
			<span className="sr-only" role="status">
				{success ? (successLabel ?? "Done") : busy ? (runningLabel ?? label) : ""}
			</span>
		</>
	);
}
/** What a millimetre slider really does on this scan. Edits move in whole
 *  voxels per axis, so on thick slices an axis can round well past the
 *  requested size; showing the result keeps the label from overpromising. */
export function EffectiveSizeNote({ requestedMm, actual }: { requestedMm: number; actual: { mm: [number, number, number] } | null }) {
	if (!actual) return null;
	const [x, y, z] = actual.mm;
	const roundedUp = actual.mm.some((v) => v > requestedMm * 1.25 + 0.05);
	return (
		<p className="atb-flyout-note" data-testid="effective-size-note">
			{`About ${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} mm.`}
			{roundedUp ? " The scan's voxels are coarser than this along some axes, so the edit moves in whole voxels." : ""}
		</p>
	);
}
