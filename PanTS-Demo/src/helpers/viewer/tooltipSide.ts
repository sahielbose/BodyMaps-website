// helpers/viewer/tooltipSide.ts
//
// Which side of its icon a ribbon tooltip goes on. Above by default, so it
// reads as a note on the icon rather than colliding with the settings flyout
// that opens below the ribbon, but a tall tooltip on a ribbon near the top
// of the window would run off screen there, so it flips below when above
// doesn't fit and below has at least as much room. Room above is counted from
// `ceiling` (the bottom of the viewer's main toolbar), not from the top of the
// window, so on a phone it flips below the icon instead of covering that toolbar's buttons.

const GAP = 10;
const MARGIN = 8;

export function tooltipSide(
	anchor: { top: number; bottom: number },
	tipHeight: number,
	viewportHeight: number,
	gap = GAP,
	margin = MARGIN,
	ceiling = 0,
): "above" | "below" {
	const roomAbove = anchor.top - gap - margin - ceiling;
	if (tipHeight <= roomAbove) return "above";
	const roomBelow = viewportHeight - anchor.bottom - gap - margin;
	return roomBelow >= roomAbove ? "below" : "above";
}
