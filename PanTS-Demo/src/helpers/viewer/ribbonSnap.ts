// helpers/viewer/ribbonSnap.ts
//
// Where the phone annotate ribbon should rest after it is scrolled to bring
// a tool into view. Centring on the tool alone can stop anywhere, which cuts
// the neighbouring tool group mid-way: the edge fade washes out its icon but
// leaves its little settings chevron peeking in at the edge. So the scroll
// position is moved on to the nearest one that starts a whole tool group
// (an icon and its chevron) at the edge fade's inner side, the same stops
// the row's scroll-snap-align gives when it is scrolled by hand.
//
// The furthest the row scrolls cannot be moved on to a group start, so there
// the start edge can still cut a group. ribbonHiddenStrip finds how much of
// that edge to hide outright, whatever the scroll position.

/**
 * `wanted` is the scrollLeft that centres the tool, `starts` the scrollLeft at
 * which each group would sit at the scroll padding, `max` the furthest the row
 * scrolls. Returns the nearest of those stops (the earlier one on a tie),
 * inside [0, max]; with no groups it just clamps `wanted`.
 */
export function snapRibbonScroll(wanted: number, starts: number[], max: number): number {
	const clamp = (n: number) => Math.min(Math.max(n, 0), Math.max(max, 0));
	const target = clamp(wanted);
	let best = target;
	let bestGap = Infinity;
	for (const start of starts) {
		const stop = clamp(start);
		const gap = Math.abs(stop - target);
		if (gap < bestGap) {
			best = stop;
			bestGap = gap;
		}
	}
	return best;
}

/**
 * How far in from the row's start edge the fade should stay fully hidden.
 * `lefts` is where each tool group begins relative to the row's start edge
 * (negative when scrolled past), `min` the closest a group may sit to that
 * edge and still be shown whole (the edge fade's inner side), `gap` the space
 * between groups. Everything before the first group at or beyond `min` is
 * hidden, so a group cut by the edge is gone entirely (icon and its settings
 * chevron together) instead of showing as a half tile or a lone chevron.
 * Returns null when no group qualifies, which leaves the CSS default.
 */
export function ribbonHiddenStrip(lefts: number[], min: number, gap: number): number | null {
	let first = Infinity;
	for (const left of lefts) if (left >= min - 0.5 && left < first) first = left;
	return first === Infinity ? null : Math.max(first - gap, 0);
}
