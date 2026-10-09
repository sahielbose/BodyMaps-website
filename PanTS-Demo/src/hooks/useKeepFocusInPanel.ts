import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

// A dock whose rows or chips can disappear from outside (Ctrl+Z, or a live room
// peer's delete) would drop keyboard focus to <body> when the element holding it
// is unmounted. Call `noteFocus` just before the list state changes: it records
// whether focus is inside the panel. After the list renders, if that focus fell
// to the page, the panel itself takes it, so the next Tab starts from the panel
// and not from the top of the page. Focus that was elsewhere is left alone.
export function useKeepFocusInPanel(panelRef: RefObject<HTMLElement | null>, items: unknown): () => void {
	const focusInside = useRef(false);

	const noteFocus = useCallback(() => {
		focusInside.current = !!panelRef.current?.contains(document.activeElement);
	}, [panelRef]);

	useLayoutEffect(() => {
		if (!focusInside.current) return;
		focusInside.current = false;
		const panel = panelRef.current;
		const active = document.activeElement;
		if (!panel || (active && active !== document.body)) return;
		if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;
		panel.focus({ preventScroll: true });
	}, [items, panelRef]);

	return noteFocus;
}
