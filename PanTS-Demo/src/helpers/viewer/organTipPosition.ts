// Hover-identify tip placement. The tip is position:fixed and keeps to one line, so it
// must be flipped to the other side of the pointer when it would run past the window.
const OFFSET = 14;
const EDGE = 8;
// 11px monospace is about 6.6px a character; the rest is swatch, gap, padding and border.
const CHAR_WIDTH = 6.6;
const CHROME_WIDTH = 37;
const TIP_HEIGHT = 28;

export function organTipPosition(
	clientX: number,
	clientY: number,
	text: string,
	viewportWidth: number = window.innerWidth,
	viewportHeight: number = window.innerHeight,
) {
	const width = Math.ceil(text.length * CHAR_WIDTH + CHROME_WIDTH);
	let x = clientX + OFFSET;
	if (x + width > viewportWidth - EDGE) x = clientX - OFFSET - width;
	let y = clientY + OFFSET;
	if (y + TIP_HEIGHT > viewportHeight - EDGE) y = clientY - OFFSET - TIP_HEIGHT;
	return { x: Math.max(EDGE, x), y: Math.max(EDGE, y) };
}
