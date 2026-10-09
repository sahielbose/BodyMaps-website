import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { focusableWithin } from "../../hooks/useDialogFocus";
import { markEscapeUsed } from "./escapeUsed";

// Gap kept between a flyout and the viewport edge when it has to be pulled
// back on screen (a trigger near the right edge of a phone-width toolbar).
const EDGE_MARGIN = 8;

/** Where a flyout of `width` px should sit so it starts under its trigger but
 *  never runs off either side of a `viewportWidth` px window. */
export function clampFlyoutLeft(left: number, width: number, viewportWidth: number, margin = EDGE_MARGIN): number {
	const maxLeft = viewportWidth - width - margin;
	return Math.max(margin, Math.min(left, maxLeft));
}

/** Fixed position for a flyout panel at `pos`, capped to the room under its
 *  trigger so a short window (a phone held in landscape) scrolls the panel
 *  instead of cutting its last rows off. The hook's onScroll guard ignores
 *  scrolls inside the panel, so it stays open while it scrolls. */
export function flyoutPanelStyle(pos: { top: number; left: number } | null) {
	if (!pos) return undefined;
	return {
		position: "fixed" as const,
		top: pos.top,
		left: pos.left,
		maxHeight: `calc(100dvh - ${pos.top}px - ${EDGE_MARGIN}px)`,
		overflowY: "auto" as const,
		overscrollBehavior: "contain" as const,
	};
}

/** The control focus should land on when a flyout opens: its selected
 *  option if it has one (so a keyboard user starts where they left off),
 *  otherwise its first control. */
export function initialFocusTarget(panel: HTMLElement): HTMLElement {
	const items = focusableWithin(panel);
	const selected = items.find((el) =>
		el.getAttribute("aria-pressed") === "true"
		|| el.getAttribute("aria-checked") === "true"
		|| el.classList.contains("is-active"));
	return selected ?? items[0] ?? panel;
}

// One flyout group's transient UI state: whether it's open, where its portal-rendered
// panel sits (measured off the trigger button on open, then pulled back inside the
// viewport), and the refs the outside-click/reflow handler needs. Shared by every
// toolbar dropdown (Layout, Window, Adjust, Panels, ... in the single viewer; View,
// Window, Adjust, Sync in the compare viewer) so this logic isn't hand-duplicated per
// group per page.
//
// The panels are groups of controls (toggles, sliders, presets), not menus, so they
// follow the disclosure pattern rather than the menu one: the trigger reports
// aria-expanded, focus moves into the panel when it opens, Escape closes it and gives
// focus back to the trigger, and tabbing past either end of the panel closes it and
// carries on from the trigger, as if the panel sat right after it in the page.
// Nothing traps focus: the panel is portaled to <body> only so the toolbar's own
// overflow can't clip it.
export function useToolbarFlyout() {
	const [open, setOpen] = useState(false);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
	const groupRef = useRef<HTMLDivElement>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const menuRef = useRef<HTMLDivElement>(null);
	const panelId = useId();

	// Closing while focus is inside the panel (an item that closes it on pick,
	// Escape, tabbing out) hands focus back to the trigger rather than letting it
	// fall to <body> when the portal unmounts.
	const closeAndRestoreFocus = () => {
		const active = document.activeElement;
		const focusInside = active instanceof Node && Boolean(menuRef.current?.contains(active));
		setOpen(false);
		if (focusInside) btnRef.current?.focus({ preventScroll: true });
	};

	const toggle = () => {
		if (open) {
			closeAndRestoreFocus();
			return;
		}
		if (btnRef.current) {
			const r = btnRef.current.getBoundingClientRect();
			setPos({ top: r.bottom + 8, left: r.left });
		}
		setOpen(true);
	};
	const close = closeAndRestoreFocus;

	// Keep the panel inside the viewport. Its width is only known once it has
	// rendered, so measure before paint and pull it left if it would run off the
	// right edge (a trigger near the end of a phone-width toolbar). The panel is
	// laid out at its natural width (.vp-flyout is width: max-content), so one
	// measurement is right; the observer covers content that changes size while
	// the panel is open (a wrapped label, a slider readout gaining a digit).
	useLayoutEffect(() => {
		const panel = menuRef.current;
		if (!open || !pos || !panel) return;
		const fit = () => {
			const left = clampFlyoutLeft(pos.left, panel.getBoundingClientRect().width, window.innerWidth);
			if (Math.abs(left - pos.left) > 0.5) {
				// Measure-then-position is what a layout effect is for; the guard
				// above keeps it to one extra render.
				setPos({ top: pos.top, left });
			}
		};
		fit();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(fit);
		observer.observe(panel);
		return () => observer.disconnect();
	}, [open, pos]);

	// Move focus into the panel when it opens.
	useEffect(() => {
		if (!open) return;
		const panel = menuRef.current;
		if (!panel) return;
		const target = initialFocusTarget(panel);
		if (target === panel && !panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
		target.focus({ preventScroll: true });
		// Only on open: re-focusing on every render would yank focus back.
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: globalThis.MouseEvent) => {
			const t = e.target as Node;
			if (groupRef.current?.contains(t) || menuRef.current?.contains(t)) return;
			setOpen(false);
		};
		const onReflow = () => setOpen(false);
		// The listener is in the capture phase so a scrolling toolbar is heard, which
		// also delivers every other scroll on the page (a chat list, a streaming
		// reply). The panel is position: fixed from the trigger's rect, so only the
		// page or an ancestor of the trigger can move it out of place.
		const onScroll = (e: Event) => {
			const t = e.target;
			if (t instanceof Node && t !== document && !t.contains(btnRef.current)) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			const panel = menuRef.current;
			if (e.key === "Escape") {
				// A Keep / Clear question inside the panel takes the first Escape
				// itself (it backs out of the question and keeps the menu open).
				if (panel?.contains(document.activeElement) && document.activeElement?.closest("[data-flyout-confirm]")) return;
				// Escape belongs to the flyout while it is open, so the viewer's
				// own Escape (disarm the active tool) doesn't also fire.
				markEscapeUsed(e);
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
				btnRef.current?.focus({ preventScroll: true });
				return;
			}
			if (e.key !== "Tab" || !panel) return;
			const active = document.activeElement;
			if (!(active instanceof Node) || !panel.contains(active)) return;
			const items = focusableWithin(panel);
			const first = items[0];
			const last = items[items.length - 1];
			const trigger = btnRef.current;
			if (e.shiftKey && (active === first || active === panel)) {
				e.preventDefault();
				setOpen(false);
				trigger?.focus({ preventScroll: true });
			} else if (!e.shiftKey && (active === last || active === panel || items.length === 0)) {
				// The panel lives at the end of <body>; continue from whatever
				// follows the trigger in the toolbar instead of leaving the page.
				e.preventDefault();
				setOpen(false);
				const order = focusableWithin(document.body).filter((el) => !panel.contains(el));
				const next = trigger ? order[order.indexOf(trigger) + 1] : undefined;
				(next ?? trigger)?.focus({ preventScroll: true });
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onReflow);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onReflow);
		};
	}, [open]);

	// Spread onto the trigger button and the portaled panel respectively
	// (the panel only renders once `open && pos`). They carry the refs, the
	// click handler and the fixed position too, so a call site needs nothing
	// else from the hook to wire a flyout up.
	const triggerProps = {
		ref: btnRef,
		onClick: toggle,
		"aria-expanded": open,
		"aria-haspopup": "dialog" as const,
		"aria-controls": open ? panelId : undefined,
	};
	const panelStyle = flyoutPanelStyle(pos);
	const panelProps = (label: string) => ({
		ref: menuRef,
		id: panelId,
		role: "dialog" as const,
		"aria-label": label,
		style: panelStyle,
	});

	return { open, pos, groupRef, btnRef, menuRef, toggle, close, panelId, triggerProps, panelProps, panelStyle };
}
