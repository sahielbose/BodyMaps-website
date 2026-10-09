import { EllipticalROITool, RectangleROITool } from "@cornerstonejs/tools";

// Placement for the statistics box of the ROI tools (rectangle, ellipse).
// Cornerstone seats a box with getTextBoxCoordsCanvas, which assumes 8px per
// character plus 25px of padding on every side. In a narrow pane that
// overestimate flips the box to the far side of the shape, clamps it, and the
// overlap pass then drops it below a neighbouring label, so it ends up ~100px
// from its rectangle. The box is seated here from its measured size instead.

type Box = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };

// drawTextBox draws the text this far inside the position it is given.
const TEXT_BOX_PADDING = 25;
const CHAR_WIDTH = 7.5; // 14px UI font, mostly digits
const LINE_HEIGHT = 17;
const PLATE_MARGIN = 4; // textBoxMargin in the viewer's tool style
const GAP_TO_SHAPE = 8;
const GAP_TO_BOX = 6;
const PANE_MARGIN = 4;

export function estimateTextBoxSize(textLines: string[]): Size {
	const longest = textLines.reduce((max, line) => Math.max(max, line?.length ?? 0), 0);
	return {
		width: Math.ceil(longest * CHAR_WIDTH) + PLATE_MARGIN * 2,
		height: Math.max(textLines.length, 1) * LINE_HEIGHT + PLATE_MARGIN * 2,
	};
}

const overlaps = (a: Box, b: Box, gap = GAP_TO_BOX) =>
	a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;

/** Top-left of the box that sits next to `shape`, in canvas pixels: right of
 *  it if it fits, else left, else below, else above, nudged along the shape's
 *  edge past `blockers` (other labels). Falls back to the right or left side
 *  even over a blocker rather than leaving the shape. */
export function placeTextBox(
	shape: { minX: number; minY: number; maxX: number; maxY: number },
	size: Size,
	pane: Size,
	blockers: Box[]
): { x: number; y: number } {
	const { width, height } = size;
	const maxX = pane.width - PANE_MARGIN - width;
	const maxY = pane.height - PANE_MARGIN - height;
	const clampX = (x: number) => Math.max(PANE_MARGIN, Math.min(x, maxX));
	const clampY = (y: number) => Math.max(PANE_MARGIN, Math.min(y, maxY));
	const centerX = (shape.minX + shape.maxX) / 2 - width / 2;
	const centerY = (shape.minY + shape.maxY) / 2 - height / 2;
	const free = (x: number, y: number) => !blockers.some((b) => overlaps({ x, y, width, height }, b));

	// Sides run along the shape's edge: slide vertically to the nearest free spot.
	const alongEdge = (x: number) => {
		const ys = [centerY, ...blockers.flatMap((b) => [b.y + b.height + GAP_TO_BOX, b.y - height - GAP_TO_BOX])]
			.filter((y) => y >= PANE_MARGIN && y <= maxY && free(x, y))
			.sort((a, b) => Math.abs(a - centerY) - Math.abs(b - centerY));
		return ys.length && Math.abs(ys[0] - centerY) <= height * 2 ? { x, y: ys[0] } : null;
	};
	const right = shape.maxX + GAP_TO_SHAPE;
	const left = shape.minX - GAP_TO_SHAPE - width;
	const rightSpot = right <= maxX ? alongEdge(right) : null;
	if (rightSpot) return rightSpot;
	const leftSpot = left >= PANE_MARGIN ? alongEdge(left) : null;
	if (leftSpot) return leftSpot;

	const below = { x: clampX(centerX), y: shape.maxY + GAP_TO_SHAPE };
	if (below.y <= maxY && free(below.x, below.y)) return below;
	const above = { x: clampX(centerX), y: shape.minY - GAP_TO_SHAPE - height };
	if (above.y >= PANE_MARGIN && free(above.x, above.y)) return above;

	// No free spot: stay next to the shape on the side with more room.
	const roomRight = pane.width - shape.maxX;
	return roomRight >= shape.minX ? { x: clampX(right), y: clampY(centerY) } : { x: clampX(left), y: clampY(centerY) };
}

/** The other annotations' statistics plates drawn in `element`'s SVG layer. */
function neighbourBoxes(element: HTMLElement, ownUid: string): Box[] {
	const pane = element.getBoundingClientRect();
	const boxes: Box[] = [];
	element.querySelectorAll("g[data-annotation-uid]").forEach((group) => {
		if (group.getAttribute("data-annotation-uid") === ownUid) return;
		const plate = group.querySelector("rect.background")?.getBoundingClientRect();
		if (plate && plate.width > 0 && plate.height > 0) {
			boxes.push({ x: plate.left - pane.left, y: plate.top - pane.top, width: plate.width, height: plate.height });
		}
	});
	return boxes;
}

type LinkedTextBoxOptions = {
	enabledElement: { viewport: { element: HTMLElement; canvasToWorld: (p: [number, number]) => number[] } };
	annotation: { annotationUID?: string; data: { handles: { textBox?: { hasMoved?: boolean; worldPosition?: number[] } } } };
	textLines: string[];
	canvasCoordinates: number[][];
	placementPoints?: number[][];
};

/** Renders a linked statistics box with `render` (the tool's own
 *  renderLinkedTextBoxAnnotation), first putting an unmoved box where
 *  placeTextBox says. The box is handed over as moved for that one call so
 *  Cornerstone keeps the position, then goes back to automatic so it is
 *  seated again on the next render, after a zoom, pan or resize. */
export function renderSeated(options: LinkedTextBoxOptions, render: () => boolean): boolean {
	const { viewport } = options.enabledElement;
	const { element } = viewport;
	const points = (options.placementPoints ?? options.canvasCoordinates).filter(Boolean);
	const textBox = options.annotation.data.handles.textBox;
	if (textBox?.hasMoved || !points.length || !element.clientWidth || !element.clientHeight) return render();
	const shape = {
		minX: Math.min(...points.map((p) => p[0])),
		maxX: Math.max(...points.map((p) => p[0])),
		minY: Math.min(...points.map((p) => p[1])),
		maxY: Math.max(...points.map((p) => p[1])),
	};
	const spot = placeTextBox(
		shape,
		estimateTextBoxSize(options.textLines),
		{ width: element.clientWidth, height: element.clientHeight },
		neighbourBoxes(element, String(options.annotation.annotationUID ?? ""))
	);
	const world = viewport.canvasToWorld([spot.x - TEXT_BOX_PADDING, spot.y - TEXT_BOX_PADDING]);
	const box = (options.annotation.data.handles.textBox ??= { hasMoved: false, worldPosition: world });
	box.worldPosition = world;
	box.hasMoved = true;
	try {
		return render();
	} finally {
		box.hasMoved = false;
	}
}

// Same tools and tool names as the stock ones; only the statistics box placement differs.
export class SeatedRectangleROITool extends RectangleROITool {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected renderLinkedTextBoxAnnotation(options: any): boolean {
		return renderSeated(options, () => super.renderLinkedTextBoxAnnotation(options));
	}
}

export class SeatedEllipticalROITool extends EllipticalROITool {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	protected renderLinkedTextBoxAnnotation(options: any): boolean {
		return renderSeated(options, () => super.renderLinkedTextBoxAnnotation(options));
	}
}
