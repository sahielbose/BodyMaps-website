// hooks/useDialogFocus.ts
//
// What role="dialog" aria-modal="true" promises a keyboard or screen-reader
// user, done once for every overlay on the site (sign-in modal, mobile nav
// drawer, upgrade, batch-details and compare-stats dialogs): focus moves
// into the dialog when it opens, Tab and Shift+Tab stay inside it, Escape
// closes it, the page behind stops scrolling, and focus returns to whatever
// opened it when it closes.
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
	"a[href]",
	"area[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"iframe",
	"[contenteditable='true']",
	"[tabindex]:not([tabindex='-1'])",
].join(",");

// The element that last held focus anywhere on the page. A dialog that hides
// its own opener in the same render (the report hides the viewer's toolbar)
// mounts after the browser has already moved focus to <body>, so
// document.activeElement alone would hand focus back to nothing on close.
let lastFocused: HTMLElement | null = null;
let lastFocusedAt = 0;
// The button, link or summary the pointer last went down on, and when.
// Safari and Firefox on Mac don't focus a button when it is clicked, so a
// dialog opened by a mouse click finds <body> focused and no opener; without
// this it would hand focus back to whatever was focused before the click.
let lastPressed: HTMLElement | null = null;
let lastPressedAt = 0;
const PRESS_WINDOW_MS = 1000;
if (typeof document !== "undefined") {
	document.addEventListener(
		"focusin",
		(e) => {
			if (e.target instanceof HTMLElement) {
				lastFocused = e.target;
				lastFocusedAt = Date.now();
			}
		},
		true,
	);
	document.addEventListener(
		"pointerdown",
		(e) => {
			const hit = e.target instanceof Element ? e.target.closest("button, a[href], [role='button'], summary") : null;
			lastPressed = hit instanceof HTMLElement ? hit : null;
			lastPressedAt = Date.now();
		},
		true,
	);
}

// Open dialogs, oldest first. Every one listens on document, so without this
// one Escape would close a hint and the step card under it together; only
// the newest open dialog takes Escape, and the newest one that traps focus
// takes Tab.
const openDialogs: { trapFocus: boolean }[] = [];

/** Keyboard-reachable elements inside `root`, in tab order, skipping hidden ones. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
	// Without a layout engine (jsdom) nothing has a box, so the box check
	// below would drop everything.
	const hasLayout = document.documentElement.getClientRects().length > 0;
	return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
		if (el.closest("[inert], [hidden], [aria-hidden='true']")) return false;
		const style = window.getComputedStyle(el);
		if (style.display === "none" || style.visibility === "hidden") return false;
		// Inside a display:none ancestor or a closed <details>: no box.
		return !hasLayout || el.getClientRects().length > 0 || el === document.activeElement;
	});
}

interface DialogFocusOptions {
	/** Element to focus on open; defaults to the first focusable inside. */
	initialFocus?: RefObject<HTMLElement | null>;
	/** Called on Escape. Leave out when the dialog handles Escape itself. */
	onEscape?: () => void;
	/** Stop the page behind from scrolling while open (default true). */
	lockScroll?: boolean;
	/** Keep Tab inside the dialog (default true). A non-modal hint that asks
	 *  the person to go and use a control elsewhere on the page sets false. */
	trapFocus?: boolean;
	/** Elements outside the container that stay on screen above it and belong
	 *  in the Tab ring (the REC pill above the report). They must come earlier
	 *  in the document than the container, and are put first in the ring. */
	extraRing?: () => HTMLElement[];
}

export function useDialogFocus(
	open: boolean,
	containerRef: RefObject<HTMLElement | null>,
	{ initialFocus, onEscape, lockScroll = true, trapFocus = true, extraRing }: DialogFocusOptions = {},
): void {
	// Latest callback without re-running the effect (which would re-focus).
	const onEscapeRef = useRef(onEscape);
	const openerRef = useRef<HTMLElement | null>(null);
	const extraRingRef = useRef(extraRing);
	useEffect(() => {
		onEscapeRef.current = onEscape;
		extraRingRef.current = extraRing;
	}, [onEscape, extraRing]);

	useEffect(() => {
		if (!open) return;
		const container = containerRef.current;
		if (!container) return;
		const outside = (el: Element | null): el is HTMLElement =>
			el instanceof HTMLElement && el !== document.body && !container.contains(el);
		const active = document.activeElement;
		// StrictMode runs this effect twice in development; by the second run
		// focus is already inside the dialog, so keep the opener the first found.
		// A press just before the dialog opened names the opener when focus
		// didn't follow the click; a focus older than that press is stale.
		const pressedJustNow = Date.now() - lastPressedAt < PRESS_WINDOW_MS;
		if (outside(active)) openerRef.current = active;
		else if (pressedJustNow && outside(lastPressed)) openerRef.current = lastPressed;
		else if (outside(lastFocused) && !(pressedJustNow && lastFocusedAt < lastPressedAt)) openerRef.current = lastFocused;
		const opener = openerRef.current;

		const target = initialFocus?.current ?? focusableWithin(container)[0] ?? container;
		if (target === container && !container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
		target.focus({ preventScroll: true });

		const entry = { trapFocus };
		openDialogs.push(entry);

		const onKeyDown = (e: KeyboardEvent) => {
			// An IME's own Escape (cancelling a candidate window) and Tab (picking
			// a candidate) belong to the composition, not to the dialog.
			if (e.isComposing || e.keyCode === 229) return;
			if (e.key === "Escape") {
				if (openDialogs[openDialogs.length - 1] !== entry || !onEscapeRef.current) return;
				e.stopPropagation();
				onEscapeRef.current();
				return;
			}
			if (e.key !== "Tab" || !trapFocus) return;
			if (openDialogs.filter((d) => d.trapFocus).pop() !== entry) return;
			const extras = (extraRingRef.current?.() ?? []).filter((el) => el.isConnected && !el.hasAttribute("disabled") && !el.closest("[inert], [hidden], [aria-hidden='true']"));
			const items = [...extras, ...focusableWithin(container)];
			if (items.length === 0) {
				e.preventDefault();
				container.focus({ preventScroll: true });
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			const inside = active instanceof Node && (container.contains(active) || extras.some((el) => el === active));
			// The card itself (tabindex -1) and any other untabbable element sit
			// in the DOM order outside the ring: the browser would step from
			// them to a tabbable element behind the backdrop, so wrap instead. The
			// container itself counts even when an extra comes earlier in the DOM.
			const before = active instanceof Node && (active === container || !!(first.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_PRECEDING));
			const after = active instanceof Node && !!(last.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING);
			// The extras sit outside the container in the DOM, so the browser's own
			// next stop from one of them is whatever lies between it and the dialog
			// (the viewer stage). Step through the ring explicitly from there.
			const at = extras.findIndex((el) => el === active);
			if (at !== -1) {
				e.preventDefault();
				items[(at + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
			} else if (e.shiftKey && (active === first || !inside || before)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || !inside || after)) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown, true);

		const body = document.body;
		const prevOverflow = body.style.overflow;
		const prevPaddingRight = body.style.paddingRight;
		if (lockScroll) {
			// Hiding a classic (Windows, Linux) window scrollbar widens the page
			// by its width and everything centred jumps sideways behind the
			// backdrop; pad the body by the same width while locked. Overlay
			// scrollbars, and jsdom with no layout at all, measure nothing.
			const root = document.documentElement;
			const gutter = root.clientWidth > 0 ? window.innerWidth - root.clientWidth : 0;
			body.style.overflow = "hidden";
			if (gutter > 0) body.style.paddingRight = `${gutter}px`;
		}

		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			openDialogs.splice(openDialogs.indexOf(entry), 1);
			if (lockScroll) {
				body.style.overflow = prevOverflow;
				body.style.paddingRight = prevPaddingRight;
			}
			// Give focus back to the opener if it is still on the page, and only
			// while focus is still in the dialog (or was dropped on <body> when
			// the dialog left the page): a hint that closes because the person
			// went and did what it asked mustn't pull focus back from there.
			const now = document.activeElement;
			const focusStayed = !now || now === document.body || container.contains(now);
			if (focusStayed && opener && opener.isConnected && typeof opener.focus === "function") {
				opener.focus({ preventScroll: true });
			}
		};
		// initialFocus is a ref: reading .current at open time is intended.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, containerRef, lockScroll, trapFocus]);
}

/**
 * Click-outside-to-close for a backdrop, but only for a click that started
 * AND ended on the backdrop itself. A plain onClick also fires when a drag
 * that began inside the dialog (selecting text in a field) is released over
 * the backdrop, which closed the sign-in modal and threw away what was typed.
 * The reverse drag (pressed on the backdrop, released over the card) clicks the
 * backdrop too, since that is the nearest common ancestor, so the release is
 * checked as well.
 * Spread the result onto the backdrop element.
 */
export function useBackdropDismiss(onDismiss: () => void) {
	const pressedOnBackdrop = useRef(false);
	const releasedOffBackdrop = useRef(false);
	const onDismissRef = useRef(onDismiss);
	useEffect(() => {
		onDismissRef.current = onDismiss;
	}, [onDismiss]);
	return {
		onMouseDown: (e: { target: EventTarget; currentTarget: EventTarget }) => {
			pressedOnBackdrop.current = e.target === e.currentTarget;
			releasedOffBackdrop.current = false;
		},
		onMouseUp: (e: { target: EventTarget; currentTarget: EventTarget }) => {
			releasedOffBackdrop.current = e.target !== e.currentTarget;
		},
		onClick: (e: { target: EventTarget; currentTarget: EventTarget }) => {
			const releasedOnBackdrop = e.target === e.currentTarget && !releasedOffBackdrop.current;
			if (pressedOnBackdrop.current && releasedOnBackdrop) onDismissRef.current();
			pressedOnBackdrop.current = false;
			releasedOffBackdrop.current = false;
		},
	};
}
