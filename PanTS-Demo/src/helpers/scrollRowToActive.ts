/**
 * Scrolls a sideways-scrolling row so its selected child (aria-pressed="true")
 * is in view, clear of `edge` px at the right where a fade may hide it. Only the
 * row scrolls, never the page (unlike scrollIntoView).
 */
export function scrollRowToActive(row: HTMLElement | null, edge = 24): void {
	const active = row?.querySelector<HTMLElement>("[aria-pressed='true']");
	if (!row || !active) return;
	const r = row.getBoundingClientRect();
	const b = active.getBoundingClientRect();
	if (b.left < r.left) row.scrollLeft -= r.left - b.left + 8;
	else if (b.right > r.right - edge) row.scrollLeft += b.right - (r.right - edge);
}
