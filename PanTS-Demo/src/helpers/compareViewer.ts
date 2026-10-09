// Isolated dual CT viewer for side-by-side case comparison. Deliberately does NOT reuse
// the single-case helper (CornerstoneNifti2), which is built on module-level singletons —
// this keeps its own rendering engine / tool groups / viewport ids so it can't regress the
// main viewer.
//
// Each case gets a 3-plane MPR (axial/sagittal/coronal) with its own crosshair navigation
// and segmentation overlay. A "Link" syncs proportional slice position across the two
// cases' axial views (cross-patient → proportional depth, not shared world coords). CT
// window presets apply to both cases at once.
import {
	Enums,
	RenderingEngine,
	type Types,
	cache,
	eventTarget,
	imageLoader,
	init as coreInit,
	setVolumesForViewports,
	utilities as csUtils,
	volumeLoader,
} from "@cornerstonejs/core";
import {
	cornerstoneNiftiImageLoader,
	createNiftiImageIdsAndCacheMetadata,
	init as niftiInit,
} from "@cornerstonejs/nifti-volume-loader";
import * as tools from "@cornerstonejs/tools";
import { SegmentationRepresentations } from "@cornerstonejs/tools/enums";
import type { Color, ColorLUT } from "@cornerstonejs/core/types";
import { addVolumeLabelmap } from "./viewer/addVolumeLabelmap";
import { segmentation_categories, segmentation_category_colors } from "./constants";
import { SeatedEllipticalROITool, SeatedRectangleROITool } from "./viewer/measurementTextBox";
import { addLabelmapActors } from "./viewer/labelmapActors";

const ENGINE_ID = "cmp_engine";
// Per-case: 3 viewports + a tool group + a segmentation id.
const A = { ax: "cmp_a_ax", sag: "cmp_a_sag", cor: "cmp_a_cor", tg: "cmp_tg_a", seg: "cmp_seg_a" };
const B = { ax: "cmp_b_ax", sag: "cmp_b_sag", cor: "cmp_b_cor", tg: "cmp_tg_b", seg: "cmp_seg_b" };

// Viewport ids for the UI layer (hover-identify, focus tracking) — same naming as
// CompareElements so callers can reuse the same key across both.
export const VIEWPORT_IDS = {
	aAx: A.ax, aSag: A.sag, aCor: A.cor,
	bAx: B.ax, bSag: B.sag, bCor: B.cor,
} as const;

export type CaseKey = "a" | "b";
type PaneName = "axial" | "sagittal" | "coronal";

// Reverse lookup: given a viewport id, which case + pane + tool group + segmentation
// id does it belong to. Backs hover-identify, focus tracking, and reference lines —
// all of which need to resolve a bare viewport id back to "which case is this."
function paneInfo(viewportId: string): { caseKey: CaseKey; pane: PaneName; tg: string; seg: string } | null {
	switch (viewportId) {
		case A.ax: return { caseKey: "a", pane: "axial", tg: A.tg, seg: A.seg };
		case A.sag: return { caseKey: "a", pane: "sagittal", tg: A.tg, seg: A.seg };
		case A.cor: return { caseKey: "a", pane: "coronal", tg: A.tg, seg: A.seg };
		case B.ax: return { caseKey: "b", pane: "axial", tg: B.tg, seg: B.seg };
		case B.sag: return { caseKey: "b", pane: "sagittal", tg: B.tg, seg: B.seg };
		case B.cor: return { caseKey: "b", pane: "coronal", tg: B.tg, seg: B.seg };
		default: return null;
	}
}

// Measurement tools the toolbar can switch the primary mouse button to — same set and
// meaning as the single viewer's (CornerstoneNifti2.tsx), duplicated here since this
// file deliberately doesn't import from that module-level-singleton file.
export const LENGTH_TOOL = tools.LengthTool.toolName;
export const BIDIRECTIONAL_TOOL = tools.BidirectionalTool.toolName;
export const PROBE_TOOL = tools.ProbeTool.toolName;
export const ROI_TOOL = tools.RectangleROITool.toolName;
export const ANGLE_TOOL = tools.AngleTool.toolName;
export const ELLIPSE_TOOL = tools.EllipticalROITool.toolName;
export const FREEHAND_ROI_TOOL = tools.PlanarFreehandROITool.toolName;
export const ARROW_TOOL = tools.ArrowAnnotateTool.toolName;
export const MEASUREMENT_TOOL_NAMES = [
	LENGTH_TOOL, BIDIRECTIONAL_TOOL, ANGLE_TOOL, PROBE_TOOL, ROI_TOOL, ELLIPSE_TOOL, FREEHAND_ROI_TOOL, ARROW_TOOL,
] as const;
export type MeasurementToolName = (typeof MEASUREMENT_TOOL_NAMES)[number];
// AdvancedMagnifyTool (not plain MagnifyTool, which throws on volume viewports) shares
// the same "owns the primary button" slot as the measurement tools.
export const MAGNIFY_TOOL: string = tools.AdvancedMagnifyTool.toolName;
export type PrimaryMouseToolName = MeasurementToolName | typeof MAGNIFY_TOOL;

// Cornerstone's defaults draw measurements in yellow/green, which collide with the
// colored organ overlays — same cyan override as the single viewer, for consistency.
const MEASURE_COLOR = "#22d3ee";
const MEASURE_COLOR_HI = "#67e8f9";
const MEASUREMENT_ANNOTATION_STYLE = {
	color: MEASURE_COLOR,
	colorHighlighted: MEASURE_COLOR_HI,
	colorSelected: "#ffffff",
	colorLocked: MEASURE_COLOR,
	lineWidth: "2",
	textBoxColor: MEASURE_COLOR,
	textBoxColorHighlighted: MEASURE_COLOR_HI,
	textBoxColorSelected: "#ffffff",
	textBoxLinkLineColor: MEASURE_COLOR,
	// The viewer's own UI font (the SVG attribute cannot read the --vp-font token).
	textBoxFontFamily: '"IBM Plex Sans", system-ui, sans-serif',
	textBoxFontSize: "14px",
	// Cyan text alone vanishes over the organ colours and other measurements'
	// lines, so it sits on a dark plate like the slice counter does.
	textBoxBackground: "rgba(8, 9, 11, 0.86)",
	textBoxBorderRadius: 4,
	textBoxMargin: 4,
	shadow: true,
};

const SEG_CONFIG = {
	fillAlpha: 0.6,
	fillAlphaInactive: 0.6,
	outlineOpacity: 1,
	outlineWidth: 1,
	renderOutline: false,
	outlineOpacityInactive: 0,
};

// Reference-line colours for each pane's crosshair (axial/sag/cor → red/green/blue).
const LINE_COLORS: Record<string, string> = {
	[A.ax]: "rgb(200,0,0)", [A.sag]: "rgb(200,200,0)", [A.cor]: "rgb(0,200,0)",
	[B.ax]: "rgb(200,0,0)", [B.sag]: "rgb(200,200,0)", [B.cor]: "rgb(0,200,0)",
};

export type CompareElements = {
	aAx: HTMLDivElement; aSag: HTMLDivElement; aCor: HTMLDivElement;
	bAx: HTMLDivElement; bSag: HTMLDivElement; bCor: HTMLDivElement;
};
export type CompareSources = {
	ctA: string; segA: string; ctB: string; segB: string;
};
/** One pane's slice position: the 0-based index it shows and how many slices it has. */
export type SliceReadout = { current: number; total: number };
export type CompareHandle = {
	setLinked: (linked: boolean) => void;
	setSyncCursor: (sync: boolean) => void;
	setSegVisible: (visible: boolean) => void;
	setSegOpacity: (alpha: number) => void;
	// Per-organ visibility: checkState[i] toggles segment index i (1-based) on both cases.
	setOrganVisibility: (checkState: boolean[]) => void;
	applyWindow: (width: number, center: number) => void;
	applyZoom: (zoom: number) => void;
	// Center each case's planes on that case's crosshair (mirrors the single viewer).
	centerCursor: () => void;
	// Move each case's crosshair to that organ's centroid (label = segment index). Returns
	// the cases whose mask has no such organ, which stay where they are.
	jumpToOrgan: (label: number) => ("a" | "b")[];
	// Re-fit the viewports after the surrounding grid changes size (view-mode switch).
	/** Re-measures the panes after the grid changed size. A view-mode switch refits
	 *  them from scratch; `keepView` (a dock opening or closing) keeps each pane's
	 *  slice, pan and zoom and only rescales it to its new cell. Returns true while the
	 *  panes may still be catching up (Cornerstone drops a resize while a render is
	 *  queued, or the cells moved since the last pass), so the caller refits again. */
	refit: (keepView?: boolean) => boolean;
	resetView: () => void;
	// Which viewport cine/flip/rotate act on — whichever pane was last clicked/scrolled.
	setFocusedViewport: (viewportId: string) => void;
	// Dotted line in each case's other 2 panes for whichever of that case's panes was
	// last focused — tracked independently per case, so both cases can show reference
	// lines at once even though "focus" for cine/flip/rotate is a single global value.
	setReferenceLines: (enabled: boolean) => void;
	flipFocused: () => void;
	rotateFocused90: () => void;
	startCine: (fps?: number) => boolean;
	stopCine: () => void;
	// Hands the primary mouse button (on BOTH cases at once) to a measurement tool or
	// the magnify loupe, or back to navigation (Crosshairs) when passed null.
	setActiveMeasurementTool: (toolName: PrimaryMouseToolName | null) => void;
	/** Cancels a half-drawn measurement in any pane. True when one was in progress. */
	cancelDrawing: () => boolean;
	clearMeasurements: () => void;
	getMeasurementSummaries: () => MeasurementSummary[];
	renameMeasurement: (uid: string, label: string) => void;
	removeMeasurement: (uid: string) => void;
	jumpToMeasurement: (uid: string, caseKey: CaseKey) => Vec3 | null;
	subscribeToMeasurementChanges: (
		cb: (kind: MeasurementChangeKind, summary: MeasurementSummary) => void
	) => () => void;
	/** Reports each pane's slice once straight away and again whenever its slice changes
	 *  (a scroll, Link scroll, Sync cursor, a jump). Returns the unsubscribe. */
	subscribeToSliceChanges: (cb: (viewportId: string, readout: SliceReadout) => void) => () => void;
	destroy: () => void;
};

export type MeasurementSummary = {
	uid: string;
	tool: string;
	label: string;
	value: string;
	center: Vec3 | null;
	caseKey: CaseKey;
};
export type MeasurementChangeKind = "completed" | "modified" | "removed";

/* eslint-disable @typescript-eslint/no-explicit-any -- annotation payloads are untyped */
function formatNum(n: number, digits = 1): string {
	return Number.isFinite(n) ? n.toFixed(digits) : "?";
}

// Each tool caches different stats keys; scan for the ones we know how to show.
function formatAnnotationValue(a: any): string {
	// An arrow has nothing to compute: its note is the annotation's label, which the row already shows.
	if (a?.metadata?.toolName === ARROW_TOOL) return "";
	const statsByTarget = a?.data?.cachedStats ?? {};
	for (const stats of Object.values(statsByTarget) as any[]) {
		if (!stats || typeof stats !== "object") continue;
		if (typeof stats.length === "number" && typeof stats.width === "number") {
			return `${formatNum(stats.length)} × ${formatNum(stats.width)} ${stats.unit ?? "mm"}`;
		}
		if (typeof stats.length === "number") return `${formatNum(stats.length)} ${stats.unit ?? "mm"}`;
		if (typeof stats.angle === "number") return `${formatNum(stats.angle)}°`;
		if (typeof stats.area === "number") {
			const area = `${formatNum(stats.area, 0)} ${stats.areaUnit ?? "mm²"}`;
			return typeof stats.mean === "number" ? `${area} · mean ${formatNum(stats.mean, 0)} HU` : area;
		}
		if (typeof stats.value === "number") return `${formatNum(stats.value, 0)} HU`;
		if (typeof stats.mean === "number") return `mean ${formatNum(stats.mean, 0)} HU`;
	}
	// A ROI box that runs past the edge of the scan keeps only its Modality: the tool
	// skips the area and mean when a corner lies outside the volume.
	if ((Object.values(statsByTarget) as any[]).some((stats) => typeof stats?.Modality === "string")) {
		return "Outside the scan";
	}
	// A ROI whose stats have not been calculated yet (they follow the draw).
	return "Not computed";
}

function annotationCenter(a: any): Vec3 | null {
	const pts = (a?.data?.handles?.points?.length
		? a.data.handles.points
		: a?.data?.contour?.polyline) as number[][] | undefined;
	if (!pts?.length) return null;
	const c: Vec3 = [0, 0, 0];
	for (const p of pts) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
	return [c[0] / pts.length, c[1] / pts.length, c[2] / pts.length];
}

/** Whether any measurement has a statistics text box. Boxes on automatic
 *  placement are re-seated beside their shape on the next annotation render; a
 *  box the user dragged keeps the spot they chose. */
export function hasMeasurementTextBoxes(): boolean {
	try {
		const names = MEASUREMENT_TOOL_NAMES as readonly string[];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return ((tools.annotation.state.getAllAnnotations() ?? []) as any[]).some(
			(a) => !!a?.data?.handles?.textBox && names.includes(a?.metadata?.toolName),
		);
	} catch {
		/* annotation state not initialized */
		return false;
	}
}

/** Redraws the annotation (SVG) layer of the given panes. Its canvas geometry is
 *  derived from world coordinates only on an annotation render, so it is stale
 *  after any camera change that is not one (a resize, a reset, a refit). */
export function repaintPaneAnnotations(viewportIds: string[]): void {
	if (!viewportIds.length) return;
	try {
		tools.utilities.triggerAnnotationRenderForViewportIds(viewportIds);
	} catch {
		/* annotation state or viewports not initialized yet */
	}
}

function toSummary(a: any, caseKey: CaseKey): MeasurementSummary {
	return {
		uid: String(a.annotationUID),
		tool: String(a?.metadata?.toolName ?? ""),
		label: String(a?.data?.label ?? ""),
		value: formatAnnotationValue(a),
		center: annotationCenter(a),
		caseKey,
	};
}
/* eslint-enable @typescript-eslint/no-explicit-any */

type SliceViewport = Types.IVolumeViewport & { getNumberOfSlices?: () => number };
export type Vec3 = [number, number, number];

let inited = false;
async function ensureInit() {
	if (inited) return;
	await coreInit();
	await tools.init();
	await niftiInit();
	imageLoader.registerImageLoader("nifti", cornerstoneNiftiImageLoader);
	// Merge onto the existing defaults — replacing wholesale would drop font/background/
	// shadow defaults and the value labels would stop rendering.
	const defaultStyles = tools.annotation.config.style.getDefaultToolStyles();
	tools.annotation.config.style.setDefaultToolStyles({
		...defaultStyles,
		global: { ...(defaultStyles.global ?? {}), ...MEASUREMENT_ANNOTATION_STYLE },
	});
	inited = true;
}

// Hover variant of "jump to organ": resolves the segment label under an arbitrary
// screen point in one pane, via canvasToWorld → worldToIndex on THAT pane's own case's
// volume geometry. Never touches the crosshair — safe to call on every mousemove.
export function getOrganLabelAtPoint(viewportId: string, clientX: number, clientY: number): number | undefined {
	if (!currentEngine) return undefined;
	const info = paneInfo(viewportId);
	if (!info) return undefined;
	const viewport = currentEngine.getViewport(viewportId) as unknown as
		| { getCanvas(): HTMLCanvasElement; canvasToWorld(canvasPos: [number, number]): Vec3 }
		| undefined;
	if (!viewport) return undefined;
	const volume = cache.getVolume(info.seg);
	if (!volume || !volume.voxelManager || !volume.imageData) return undefined;

	let canvas: HTMLCanvasElement;
	try {
		canvas = viewport.getCanvas();
	} catch {
		return undefined;
	}
	const rect = canvas.getBoundingClientRect();
	const canvasPos: [number, number] = [clientX - rect.left, clientY - rect.top];
	if (canvasPos[0] < 0 || canvasPos[1] < 0 || canvasPos[0] > rect.width || canvasPos[1] > rect.height) {
		return undefined;
	}

	let world: Vec3;
	try {
		world = viewport.canvasToWorld(canvasPos);
	} catch {
		return undefined;
	}

	const [i, j, k] = volume.imageData.worldToIndex(world).map((v: number) => Math.round(v));
	const [dimX, dimY, dimZ] = volume.voxelManager.dimensions;
	if (i < 0 || j < 0 || k < 0 || i >= dimX || j >= dimY || k >= dimZ) return undefined;
	const res = volume.voxelManager.getAtIJK(i, j, k);
	if (typeof res === "number") return res;
	return undefined;
}

// Dense LUT indexed by label id, from the same organ colours the single viewer uses.
function buildColorLUT(): ColorLUT {
	const colors = segmentation_category_colors as Record<number, Color>;
	const max = Math.max(0, ...Object.keys(colors).map(Number));
	const lut = Array.from({ length: max + 1 }, () => [0, 0, 0, 0] as Color) as ColorLUT;
	for (const k of Object.keys(colors)) lut[Number(k)] = colors[Number(k)];
	return lut;
}

const sliceCount = (vp: SliceViewport): number =>
	vp.getNumberOfSlices?.() ?? vp.getImageData()?.dimensions?.[2] ?? 1;

// Per-label centroids (world mm) for a segmentation volume — the "jump to organ" target.
// Same approach as the single viewer's getOrganCentroids, but keyed by segmentation id so
// each case is computed from its own volume/geometry.
function computeCentroids(segmentationId: string): Record<number, Vec3> | null {
	const volume = cache.getVolume(segmentationId);
	const vm = volume?.voxelManager;
	if (!volume || !vm) return null;

	const [dimX, dimY] = vm.dimensions;
	const sliceSize = dimX * dimY;
	const sums = new Map<number, { x: number; y: number; z: number; n: number }>();
	const add = (label: number, i: number, j: number, k: number) => {
		if (!label) return; // skip background
		let s = sums.get(label);
		if (!s) { s = { x: 0, y: 0, z: 0, n: 0 }; sums.set(label, s); }
		s.x += i; s.y += j; s.z += k; s.n++;
	};

	// Cornerstone's per-image voxel manager (what a NIfTI volume built from per-slice
	// imageIds gets) resolves BOTH its fast getCompleteScalarDataArray() path AND its
	// vm.forEach fallback via the SAME per-slice `cache.getImage(imageId)` lookup — and both
	// have failure modes we've hit in practice: forEach logs one console.warn per VOXEL for
	// every missing slice (tens of thousands of warnings for a single ~57k-pixel slice,
	// freezing the tab), while getCompleteScalarDataArray() can be worse — if even ONE
	// slice's image isn't cached it can return a totally EMPTY array instead of a partial
	// one, silently discarding every centroid for the whole volume with no error or warning
	// to explain why. So we bypass both: read each slice's image directly from `cache`
	// ourselves. A missing slice just contributes nothing to that one slice — it can't wipe
	// out the rest, and we don't call the library's warn-happy per-pixel lookup at all.
	const imageIds = (volume as unknown as { imageIds?: string[] }).imageIds;
	if (imageIds?.length) {
		for (let k = 0; k < imageIds.length; k++) {
			const image = cache.getImage(imageIds[k]) as unknown as
				{ voxelManager?: { getScalarData?: () => ArrayLike<number> } } | undefined;
			const sliceData = image?.voxelManager?.getScalarData?.();
			if (!sliceData) continue; // this slice's image isn't cached — skip it, not the whole case
			for (let idx = 0; idx < sliceData.length; idx++) {
				const label = sliceData[idx];
				if (!label) continue;
				const j = (idx / dimX) | 0;
				add(label, idx - j * dimX, j, k);
			}
		}
	} else {
		// No per-slice imageIds on the volume at all (shouldn't happen for a NIfTI-loaded
		// volume) — fall back to the volume-level accessor, same all-or-nothing risk as above.
		let data: ArrayLike<number> | undefined;
		try { data = vm.getCompleteScalarDataArray?.(); } catch { /* leave undefined */ }
		if (data && data.length) {
			for (let idx = 0; idx < data.length; idx++) {
				const label = data[idx];
				if (!label) continue;
				const k = (idx / sliceSize) | 0;
				const rem = idx - k * sliceSize;
				const j = (rem / dimX) | 0;
				add(label, rem - j * dimX, j, k);
			}
		}
	}

	const out: Record<number, Vec3> = {};
	for (const [label, s] of sums) {
		const w = volume.imageData?.indexToWorld([s.x / s.n, s.y / s.n, s.z / s.n]);
		if (w) out[label] = [w[0], w[1], w[2]];
	}
	return out;
}

// --- Landmark-based cross-case mapping -------------------------------------------------
// "Link scroll" and cursor sync need a way to translate a world-mm point in case A's space
// into the corresponding point in case B's space. Naively assuming the two scans cover the
// same anatomical range (plain proportional slice/index fractions) is wrong in general —
// different patients, different scan extents — and lands "linked" views on entirely
// different organs. Instead we fit a transform from organs present in BOTH cases' masks,
// using each shared organ's centroid as a landmark pair — the standard "landmark
// registration" approach, far cheaper than true image-intensity registration while fixing
// the dominant error (which organ/slice a view lands on).

// Generic N×N matrix inverse via Gauss-Jordan elimination with partial pivoting. Returns
// null if the matrix is singular (or too close to it) — e.g. landmarks that are collinear
// or otherwise don't span 3D space well enough to fit a unique transform.
function invertMatrix(m: number[][]): number[][] | null {
	const n = m.length;
	const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
	for (let col = 0; col < n; col++) {
		let pivot = col;
		for (let row = col + 1; row < n; row++) {
			if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
		}
		if (Math.abs(a[pivot][col]) < 1e-9) return null; // singular
		[a[col], a[pivot]] = [a[pivot], a[col]];
		const div = a[col][col];
		for (let j = 0; j < 2 * n; j++) a[col][j] /= div;
		for (let row = 0; row < n; row++) {
			if (row === col) continue;
			const factor = a[row][col];
			if (factor === 0) continue;
			for (let j = 0; j < 2 * n; j++) a[row][j] -= factor * a[col][j];
		}
	}
	return a.map((row) => row.slice(n));
}

// Least-squares affine map (3×4, homogeneous) that best sends each `a` landmark onto its
// paired `b` landmark, fit independently per output axis via normal equations. Needs at
// least 4 non-degenerate (non-coplanar) point pairs; returns null otherwise so the caller
// can fall back to a cheaper fit.
export function fitAffine(pairs: [Vec3, Vec3][]): ((p: Vec3) => Vec3) | null {
	if (pairs.length < 4) return null;
	const XtX = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
	const XtY = Array.from({ length: 4 }, () => [0, 0, 0]);
	for (const [a, b] of pairs) {
		const row = [a[0], a[1], a[2], 1];
		for (let i = 0; i < 4; i++) {
			for (let j = 0; j < 4; j++) XtX[i][j] += row[i] * row[j];
			for (let k = 0; k < 3; k++) XtY[i][k] += row[i] * b[k];
		}
	}
	const inv = invertMatrix(XtX);
	if (!inv) return null;
	// coeffs[targetAxis][4] = inv · XtY[:, targetAxis]
	const coeffs = [0, 1, 2].map((k) =>
		Array.from({ length: 4 }, (_, i) => {
			let s = 0;
			for (let j = 0; j < 4; j++) s += inv[i][j] * XtY[j][k];
			return s;
		})
	);
	return (p: Vec3): Vec3 => {
		const row = [p[0], p[1], p[2], 1];
		return coeffs.map((c) => c[0] * row[0] + c[1] * row[1] + c[2] * row[2] + c[3] * row[3]) as Vec3;
	};
}

const median = (xs: number[]): number => {
	const s = [...xs].sort((p, q) => p - q);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Median of every pairwise slope of ys against xs (Theil-Sen). null when no two xs differ.
function medianSlope(xs: number[], ys: number[]): number | null {
	const slopes: number[] = [];
	for (let i = 0; i < xs.length; i++) {
		for (let j = i + 1; j < xs.length; j++) {
			const dx = xs[j] - xs[i];
			if (Math.abs(dx) > 1e-6) slopes.push((ys[j] - ys[i]) / dx);
		}
	}
	return slopes.length ? median(slopes) : null;
}

// A robust line that is the same line whichever way round it is fit: the slope is the
// geometric mean of the Theil-Sen slope of ys on xs and the inverse of xs on ys, and the line
// runs through the medians. So fitting B from A and A from B gives exact inverses, and Link
// scroll doesn't jump when the person switches which case they scroll.
function symmetricLine(xs: number[], ys: number[]): { s: number; t: number } | null {
	const fwd = medianSlope(xs, ys);
	if (fwd === null) return null;
	const back = medianSlope(ys, xs);
	const s = back !== null && fwd * back > 0 ? Math.sign(fwd) * Math.sqrt(fwd / back) : fwd;
	return { s, t: median(ys) - s * median(xs) };
}

// Fallback for too few landmarks for a full affine fit, and Link scroll's depth mapping: an
// independent line (scale + offset) per axis. Needs at least 2 pairs, and each axis needs some
// spread across the landmarks — an axis that can't be fit rejects the whole mapping rather
// than silently degrading to a wrong-but-plausible-looking transform.
// The fit is robust on purpose. A few labels sit far from the rest in real masks (femurs and
// a bladder low in a long scan, lungs or a vessel cut off at a short scan's edge, a stray
// speck labelled femur), and a least-squares line chases them: it flattened the depth slope
// to 0.11 for cases 7 and 23, so the other case barely moved. So: a median-based line, then
// drop labels whose residual is more than 3 robust standard deviations and fit again.
export function fitPerAxisLinear(pairs: [Vec3, Vec3][]): ((p: Vec3) => Vec3) | null {
	if (pairs.length < 2) return null;
	const fits = [0, 1, 2].map((axis) => {
		const xs = pairs.map(([a]) => a[axis]);
		const ys = pairs.map(([, b]) => b[axis]);
		const first = symmetricLine(xs, ys);
		if (!first) return null; // landmarks don't spread on this axis
		const res = ys.map((y, i) => Math.abs(y - (first.s * xs[i] + first.t)));
		const cut = 3 * 1.4826 * median(res) + 1e-6;
		const keep = res.map((r, i) => (r <= cut ? i : -1)).filter((i) => i >= 0);
		if (keep.length < 2 || keep.length === xs.length) return first;
		return symmetricLine(keep.map((i) => xs[i]), keep.map((i) => ys[i])) ?? first;
	});
	if (fits.some((f) => !f)) return null;
	return (p: Vec3): Vec3 => [0, 1, 2].map((i) => fits[i]!.s * p[i] + fits[i]!.t) as Vec3;
}

// The scroll steps Cornerstone's own scroll(delta) needs to bring a volume viewport's slice
// onto world point P, from getVolumeViewportScrollInfo(vp, volumeId, true). It counts steps
// the way Cornerstone does (from the min end of the volume along the camera's
// viewPlaneNormal), so it works for any storage order and for a flipped pane, whose normal
// points the other way. The target is clamped to the volume so an end slice isn't re-scrolled.
export type ScrollInfo = {
	numScrollSteps: number;
	currentStepIndex: number;
	sliceRangeInfo: {
		sliceRange: { min: number; max: number };
		spacingInNormalDirection: number;
		camera: { viewPlaneNormal?: Vec3 };
	};
};
export function scrollDeltaToWorld(info: ScrollInfo, P: Vec3): number {
	const { sliceRange, spacingInNormalDirection: sp, camera } = info.sliceRangeInfo;
	const n = camera.viewPlaneNormal;
	const range = sliceRange.max - sliceRange.min;
	if (!n || !(sp > 0) || !(range > 0) || !(info.numScrollSteps > 0)) return 0;
	const proj = P[0] * n[0] + P[1] * n[1] + P[2] * n[2];
	// Same fraction-of-range form getVolumeViewportScrollInfo uses for currentStepIndex.
	const target = Math.round(((proj - sliceRange.min) / range) * info.numScrollSteps);
	return Math.max(0, Math.min(info.numScrollSteps, target)) - info.currentStepIndex;
}

// Sync cursor's fallback when no landmark mapping could be fit: put the point at the same
// fraction of the destination's world bounds ([xmin, xmax, ymin, ymax, zmin, zmax]) on each
// world axis, clamped to the volume. Exact for the axis-aligned volumes PanTS uses.
export function mapByBounds(p: ArrayLike<number>, src: ArrayLike<number>, dst: ArrayLike<number>): Vec3 {
	return [0, 1, 2].map((i) => {
		const lo = src[2 * i], hi = src[2 * i + 1];
		const frac = Math.min(1, Math.max(0, (p[i] - lo) / ((hi - lo) || 1)));
		return dst[2 * i] + frac * (dst[2 * i + 1] - dst[2 * i]);
	}) as Vec3;
}

// Best available A→B (or B→A) world-mm mapping from shared-organ landmark pairs: a full
// affine fit when there are enough landmarks, a per-axis linear fit as a lighter fallback,
// or null (caller falls back to the old proportional-index behavior) when the cases don't
// share enough organs to fit anything reliable — e.g. a dev checkout without segmentation
// masks, or two cases with almost no anatomical overlap.
export function fitCaseMapping(pairs: [Vec3, Vec3][]): ((p: Vec3) => Vec3) | null {
	return fitAffine(pairs) ?? fitPerAxisLinear(pairs);
}

let currentEngine: RenderingEngine | null = null;

// The tool groups, segmentation ids and engine id above are fixed names, so two overlapping
// setupCompare calls (Back then Forward while the first is still downloading) would share
// them. Each call takes a generation; a call that is no longer the latest stops at its next
// await and never touches what the newer call owns.
let setupGen = 0;
function throwIfSuperseded(gen: number) {
	if (gen !== setupGen) throw new Error("Comparison superseded by a newer load");
}

// Cornerstone's volume cache outlives the engine, and a superseded call never returns a
// handle, so nothing else would ever free the volumes it already cached. It releases them
// itself, except what the newer call can still reach: its CT ids (they include the URL, so
// Back then Forward to the same pair shares them) and any fixed-id segmentation volume the
// newer call has claimed. segOwner records which call created each fixed-id volume last.
let liveCtVolumeIds = new Set<string>();
const segOwner = new Map<string, number>();
function removeCachedVolume(id: string) {
	try {
		cache.removeVolumeLoadObject(id);
	} catch {
		/* not cached */
	}
}

// Frees one case's volumes on behalf of a superseded call `gen`, under the rule above.
function releaseSupersededCase(ctVolId: string, segmentationId: string, gen: number) {
	if (!liveCtVolumeIds.has(ctVolId)) removeCachedVolume(ctVolId);
	if (segOwner.get(segmentationId) === gen) {
		segOwner.delete(segmentationId);
		removeCachedVolume(segmentationId);
	}
}

// Deterministic reference-line tool-instance name for a case's tool group + source pane.
function refLineInstanceName(tgId: string, pane: PaneName): string {
	return `${tgId}_ref_${pane}`;
}

function makeToolGroup(id: string, panes: Record<PaneName, string>) {
	try {
		tools.ToolGroupManager.destroyToolGroup(id);
	} catch {
		/* none yet */
	}
	const tg = tools.ToolGroupManager.createToolGroup(id);
	if (!tg) throw new Error(`Failed to create tool group ${id}`);
	tools.addTool(tools.CrosshairsTool);
	tools.addTool(tools.StackScrollTool);
	tools.addTool(tools.PanTool);
	tools.addTool(tools.ZoomTool);
	tools.addTool(tools.LengthTool);
	tools.addTool(tools.BidirectionalTool);
	tools.addTool(tools.AngleTool);
	tools.addTool(tools.ProbeTool);
	tools.addTool(SeatedRectangleROITool);
	tools.addTool(SeatedEllipticalROITool);
	tools.addTool(tools.PlanarFreehandROITool);
	tools.addTool(tools.ArrowAnnotateTool);
	tools.addTool(tools.AdvancedMagnifyTool);
	tools.addTool(tools.ReferenceLinesTool);
	tg.addTool(tools.CrosshairsTool.toolName, {
		getReferenceLineColor: (vpId: string) => LINE_COLORS[vpId] ?? "rgb(200,200,200)",
		getReferenceLineControllable: () => true,
		getReferenceLineDraggableRotatable: () => true,
		getReferenceLineSlabThicknessControlsOn: () => false,
	});
	tg.addTool(tools.StackScrollTool.toolName);
	tg.addTool(tools.PanTool.toolName);
	tg.addTool(tools.ZoomTool.toolName);
	tg.addTool(tools.LengthTool.toolName);
	tg.addTool(tools.BidirectionalTool.toolName);
	tg.addTool(tools.AngleTool.toolName);
	tg.addTool(tools.ProbeTool.toolName);
	tg.addTool(tools.RectangleROITool.toolName);
	tg.addTool(tools.EllipticalROITool.toolName);
	// allowOpenContours: false — always auto-close into a polygon so it behaves like the
	// other ROI tools (area + mean/min/max HU), not an open freehand line.
	tg.addTool(tools.PlanarFreehandROITool.toolName, { calculateStats: true, allowOpenContours: false });
	tg.addTool(tools.ArrowAnnotateTool.toolName);
	tg.addTool(tools.AdvancedMagnifyTool.toolName);

	const viewportIds = [panes.axial, panes.sagittal, panes.coronal];
	viewportIds.forEach((v) => tg.addViewport(v, ENGINE_ID));

	// Reference lines: one instance per pane as the "source" within THIS case only (each
	// case's 3 panes reference each other — not across cases). Starts disabled.
	for (const [pane, sourceViewportId] of Object.entries(panes) as [PaneName, string][]) {
		const instanceName = refLineInstanceName(id, pane);
		tg.addToolInstance(instanceName, tools.ReferenceLinesTool.toolName, {
			sourceViewportId,
			enforceSameFrameOfReference: true,
			showFullDimension: false,
		});
		tg.setToolDisabled(instanceName);
	}

	const { MouseBindings } = tools.Enums;
	tg.setToolActive(tools.CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
	tg.setToolActive(tools.StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
	tg.setToolActive(tools.PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
	tg.setToolActive(tools.ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
	return tg;
}

// The NIfTI loader only settles its header promise from a successful stream: on a 404 it
// logs "Fetch error" and never resolves or rejects, so awaiting it for a case that does
// not exist left the page on "Loading both cases…" forever. Race it against a HEAD probe
// that fails fast when the file is definitely missing, and a timeout for a request that
// never answers at all. The header is the first few hundred bytes, so a healthy load
// wins the race in well under the timeout.
const HEADER_TIMEOUT_MS = 60_000;

export async function loadNiftiImageIds(
	url: string,
	load: (url: string) => Promise<string[]> = (u) => createNiftiImageIdsAndCacheMetadata({ url: u }),
	timeoutMs = HEADER_TIMEOUT_MS
): Promise<string[]> {
	const never = new Promise<never>(() => {});
	const probe = fetch(url, { method: "HEAD" }).then(
		(res) => {
			// Only a definite "not there" fails fast. Anything else (a server that refuses
			// HEAD, a rate limit) is left to the loader and the timeout.
			if (res.status === 404 || res.status === 410) throw new Error(`HTTP ${res.status} for ${url}`);
			return never;
		},
		() => never // HEAD blocked (CORS, offline): inconclusive, the timeout still guards
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`Timed out loading ${url}`)), timeoutMs);
	});
	try {
		return await Promise.race([load(url), probe, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

// NIfTI volumes carry no DICOM Modality, and the ROI tools print their unit from it (CT
// gives "HU", anything else gives nothing). Compare cases are dataset scans, CT by
// construction, so tag them. Same helper as the single viewer's _tagNiftiVolumeAsCt,
// duplicated here for the same no-import reason as the tool names above.
export function tagNiftiVolumeAsCt(volume: { metadata?: unknown }): void {
	const metadata = volume.metadata as { Modality?: string } | undefined;
	if (metadata && metadata.Modality === undefined) metadata.Modality = "CT";
}

/** A case that could not be loaded; `which` lets the page name it. */
export type CaseLoadError = Error & { which: CaseKey };
function caseLoadError(which: CaseKey, cause: unknown): CaseLoadError {
	const err = new Error(
		`Case ${which.toUpperCase()} failed to load: ${cause instanceof Error ? cause.message : String(cause)}`
	) as CaseLoadError;
	err.which = which;
	return err;
}

// Load one case's CT + segmentation into its 3 viewports. Segmentation failures are
// swallowed so the CT still shows (dev checkouts often lack masks). A call that a newer
// setupCompare has superseded stops after each await, before it touches the shared
// (fixed id) segmentation state or viewports, and its failure is never swallowed.
async function loadCase(
	engine: RenderingEngine,
	ctUrl: string,
	segUrl: string,
	viewportIds: string[],
	segmentationId: string,
	colorLUT: ColorLUT,
	gen: number
) {
	const ctVolId = `${segmentationId}_ct:${ctUrl}`;
	try {
		await loadCaseVolumes(engine, ctUrl, segUrl, viewportIds, segmentationId, ctVolId, colorLUT, gen);
	} catch (e) {
		if (gen !== setupGen) releaseSupersededCase(ctVolId, segmentationId, gen);
		throw e;
	}
}

async function loadCaseVolumes(
	engine: RenderingEngine,
	ctUrl: string,
	segUrl: string,
	viewportIds: string[],
	segmentationId: string,
	ctVolId: string,
	colorLUT: ColorLUT,
	gen: number
) {
	const ctIds = await loadNiftiImageIds(ctUrl);
	throwIfSuperseded(gen);
	const ctVol = await volumeLoader.createAndCacheVolume(ctVolId, { imageIds: ctIds });
	tagNiftiVolumeAsCt(ctVol);
	await ctVol.load();
	throwIfSuperseded(gen);
	await setVolumesForViewports(engine, [{ volumeId: ctVolId }], viewportIds);
	throwIfSuperseded(gen);
	engine.renderViewports(viewportIds);

	// An empty URL means the case has no mask (CancerVerse): show the CT alone.
	if (!segUrl) return;
	try {
		const segIds = await loadNiftiImageIds(segUrl);
		throwIfSuperseded(gen);
		if (!segIds.length) return;
		// The id is fixed, and createAndCacheVolume hands back whatever is already cached under
		// it, so a mask left by an earlier pair must go before this pair's is created.
		removeCachedVolume(segmentationId);
		segOwner.set(segmentationId, gen);
		const segVol = await volumeLoader.createAndCacheVolume(segmentationId, { imageIds: segIds });
		throwIfSuperseded(gen);
		await segVol.load();
		throwIfSuperseded(gen);
		// segVol.load() resolving only guarantees the volume's own combined scalar buffer is
		// ready — NOT that every per-slice image is individually cached (cache.getImage(id)).
		// That population can lag behind in the background; computeCentroids reading it right
		// after loadCase returns is a race it can lose (seen in practice: the case loaded
		// second, with less elapsed background time, had ZERO of its per-slice images ready).
		// Force it explicitly so centroid computation never runs against a half-populated cache.
		// loadAndCacheImages returns an ARRAY OF PROMISES, not Promise.all()'d — awaiting the
		// array itself resolves immediately without waiting for any individual image to load.
		await Promise.all(imageLoader.loadAndCacheImages(segIds));
		throwIfSuperseded(gen);
		tools.segmentation.segmentationStyle.setStyle(
			{ type: SegmentationRepresentations.Labelmap, segmentationId },
			SEG_CONFIG
		);
		// suppressEvents: no pane has this mask yet, so the render request addSegmentations
		// would queue names no viewports. Cornerstone's segmentation render queue is shared
		// by every page and stops draining at an empty batch, which stranded the colour pass
		// that unhides this case's labelmap actors (case B showed bare CT on a reopen). The
		// representation adds below still queue a render for each pane.
		tools.segmentation.addSegmentations(
			[
				{
					segmentationId,
					representation: {
						type: SegmentationRepresentations.Labelmap,
						data: { imageIds: segIds, volumeId: segmentationId },
					},
					// Every organ label is a segment, so each pane's representation gets a
					// visibility entry per organ. Without them Cornerstone only knew label 1 and
					// ignored organ toggles for every other label.
					config: { segments: ORGAN_SEGMENTS },
				},
			],
			true
		);
		await addLabelmapActors(engine, segmentationId, segmentationId, viewportIds);
		for (const vpId of viewportIds) {
			throwIfSuperseded(gen);
			await addVolumeLabelmap(engine, vpId, segmentationId, colorLUT);
			throwIfSuperseded(gen);
			tools.segmentation.activeSegmentation.setActiveSegmentation(vpId, segmentationId);
		}
	} catch (e) {
		if (gen !== setupGen) throw e;
		console.warn(`[compare] segmentation unavailable for ${segmentationId}:`, e);
	}
}

// One segment per organ label (1..N, in the Organs panel's order).
const ORGAN_SEGMENTS = Object.fromEntries(
	segmentation_categories.map((name, i) => [i + 1, { segmentIndex: i + 1, label: name }])
);

// The panes that hold a labelmap representation of the mask. A case without a mask (CancerVerse)
// or whose mask failed to load has none.
function panesWithMask(segmentationId: string, viewportIds: readonly string[]): string[] {
	const spec = { segmentationId, type: SegmentationRepresentations.Labelmap };
	return viewportIds.filter((vpId) => {
		try {
			return !!tools.segmentation.state.getSegmentationRepresentations(vpId, spec)?.length;
		} catch {
			return false;
		}
	});
}

// Tells which case a measurement belongs to from the viewport it was added to. The
// FrameOfReferenceUID cannot: the NIfTI loader gives every volume the same constant, so
// both cases share one.
export function createAnnotationCaseTracker() {
	const cases = new Map<string, CaseKey>();
	// A removal is announced to every listener, and this tracker hears it first. The panel's own
	// "removed" listener still needs the case, so the entry lingers here until the dispatch is over.
	const justRemoved = new Map<string, CaseKey>();
	return {
		onAdded: (evt: Event) => {
			const detail = (evt as CustomEvent).detail;
			const uid = detail?.annotation?.annotationUID;
			const info = typeof detail?.viewportId === "string" ? paneInfo(detail.viewportId) : null;
			if (uid && info && !cases.has(uid)) cases.set(uid, info.caseKey);
		},
		onRemoved: (evt: Event) => {
			const uid = (evt as CustomEvent).detail?.annotation?.annotationUID;
			if (!uid) return;
			const caseKey = cases.get(uid);
			cases.delete(uid);
			if (!caseKey) return;
			justRemoved.set(uid, caseKey);
			queueMicrotask(() => justRemoved.delete(uid));
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		caseKeyFor: (a: any): CaseKey | null => (a?.annotationUID && cases.get(a.annotationUID)) || null,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		caseKeyForRemoved: (a: any): CaseKey | null => (a?.annotationUID && justRemoved.get(a.annotationUID)) || null,
	};
}

// Annotation state is a module-level singleton like the volume cache: a measurement left
// behind would be listed, and drawn on the slices, in the next comparison. The single viewer
// clears its annotations on teardown for the same reason.
export function clearAllAnnotations() {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		for (const a of [...((tools.annotation.state.getAllAnnotations() ?? []) as any[])]) {
			if (a?.annotationUID) tools.annotation.state.removeAnnotation(a.annotationUID);
		}
	} catch {
		/* annotation state may not be ready — no-op */
	}
}

// Cancels the setupCompare call `gen` while it is still loading and was never handed back as a
// handle (the page was left meanwhile), so it stops downloading and frees what it built. It
// supersedes the call, which throws at its next await, and tears down the engine, tool groups
// and the two fixed-id segmentations itself, since no handle exists to do it. Unlike
// handle.destroy() it leaves every other segmentation and annotation alone: the next page (the
// single viewer) owns those by now. A call a newer one has already replaced is left alone.
function abortSetupCompare(gen: number) {
	if (gen !== setupGen) return;
	setupGen++;
	liveCtVolumeIds = new Set();
	if (!currentEngine) return;
	try {
		tools.ToolGroupManager.destroyToolGroup(A.tg);
		tools.ToolGroupManager.destroyToolGroup(B.tg);
		for (const id of [A.seg, B.seg]) tools.segmentation.removeSegmentation(id);
	} catch {
		/* nothing built yet, or already gone */
	}
	currentEngine.destroy();
	currentEngine = null;
}

// `signal` lets the page cancel a load that has not produced a handle yet (see above).
export async function setupCompare(els: CompareElements, src: CompareSources, signal?: AbortSignal): Promise<CompareHandle> {
	const gen = ++setupGen;
	const onAbort = () => abortSetupCompare(gen);
	if (signal?.aborted) onAbort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		return await buildCompare(els, src, gen);
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

async function buildCompare(els: CompareElements, src: CompareSources, gen: number): Promise<CompareHandle> {
	liveCtVolumeIds = new Set([`${A.seg}_ct:${src.ctA}`, `${B.seg}_ct:${src.ctB}`]);
	await ensureInit();
	throwIfSuperseded(gen);

	try {
		tools.ToolGroupManager.destroyToolGroup(A.tg);
		tools.ToolGroupManager.destroyToolGroup(B.tg);
	} catch {
		/* none yet */
	}
	if (currentEngine) {
		currentEngine.destroy();
		currentEngine = null;
	}
	clearAllAnnotations();

	const engine = new RenderingEngine(ENGINE_ID);
	currentEngine = engine;

	const O = Enums.OrientationAxis;
	engine.setViewports([
		{ viewportId: A.ax, type: Enums.ViewportType.ORTHOGRAPHIC, element: els.aAx, defaultOptions: { orientation: O.AXIAL } },
		{ viewportId: A.sag, type: Enums.ViewportType.ORTHOGRAPHIC, element: els.aSag, defaultOptions: { orientation: O.SAGITTAL } },
		{ viewportId: A.cor, type: Enums.ViewportType.ORTHOGRAPHIC, element: els.aCor, defaultOptions: { orientation: O.CORONAL } },
		{ viewportId: B.ax, type: Enums.ViewportType.ORTHOGRAPHIC, element: els.bAx, defaultOptions: { orientation: O.AXIAL } },
		{ viewportId: B.sag, type: Enums.ViewportType.ORTHOGRAPHIC, element: els.bSag, defaultOptions: { orientation: O.SAGITTAL } },
		{ viewportId: B.cor, type: Enums.ViewportType.ORTHOGRAPHIC, element: els.bCor, defaultOptions: { orientation: O.CORONAL } },
	]);

	// One crosshair-linked tool group per case (each case's 3 planes navigate together).
	makeToolGroup(A.tg, { axial: A.ax, sagittal: A.sag, coronal: A.cor });
	makeToolGroup(B.tg, { axial: B.ax, sagittal: B.sag, coronal: B.cor });

	const colorLUT = buildColorLUT();
	tools.segmentation.removeAllSegmentations();
	// A failed case tears down what was built so far (no handle exists yet to do it) and
	// is reported by name.
	// Cases that finished loading: loadCase releases its own volumes when it is superseded
	// mid-load, but a case that already resolved has to be released here.
	const loaded: { ctVolId: string; segmentationId: string }[] = [];
	const loadOrFail = async (which: CaseKey, ctUrl: string, load: () => Promise<void>) => {
		try {
			await load();
			const segmentationId = which === "a" ? A.seg : B.seg;
			loaded.push({ ctVolId: `${segmentationId}_ct:${ctUrl}`, segmentationId });
			throwIfSuperseded(gen);
		} catch (e) {
			// A superseded call owns nothing any more: the tool groups, segmentations and
			// engine now belong to the newer comparison, and only its cached volumes are left
			// to free.
			if (gen !== setupGen) {
				for (const c of loaded) releaseSupersededCase(c.ctVolId, c.segmentationId, gen);
				throw e;
			}
			try {
				tools.segmentation.removeAllSegmentations();
				tools.ToolGroupManager.destroyToolGroup(A.tg);
				tools.ToolGroupManager.destroyToolGroup(B.tg);
			} catch {
				/* ignore */
			}
			if (currentEngine === engine) {
				engine.destroy();
				currentEngine = null;
			}
			// No handle will ever exist to destroy() this load, so free every volume it cached
			// (the cases that finished, the failed case's partial CT and both fixed-id masks);
			// the ids are the ones destroy() frees.
			for (const id of [...loaded.map((c) => c.ctVolId), `${which === "a" ? A.seg : B.seg}_ct:${ctUrl}`, A.seg, B.seg]) {
				removeCachedVolume(id);
			}
			throw caseLoadError(which, e);
		}
	};
	await loadOrFail("a", src.ctA, () => loadCase(engine, src.ctA, src.segA, [A.ax, A.sag, A.cor], A.seg, colorLUT, gen));
	await loadOrFail("b", src.ctB, () => loadCase(engine, src.ctB, src.segB, [B.ax, B.sag, B.cor], B.seg, colorLUT, gen));

	// Centroids are computed once per case (both eagerly here, for the mapping below, and
	// lazily reused by jumpToOrgan) and cached thereafter.
	const centroidCache = new Map<string, Record<number, Vec3> | null>();
	const centroidsFor = (segId: string) => {
		if (!centroidCache.has(segId)) centroidCache.set(segId, computeCentroids(segId));
		return centroidCache.get(segId) ?? null;
	};

	// A↔B world-mm mapping, fit from organs present in both cases' masks (see
	// fitCaseMapping above). Fit independently in each direction — rather than analytically
	// inverting one fit — since each is its own best-fit least-squares approximation. null
	// when there aren't enough shared organs (e.g. no masks in a dev checkout, or the two
	// cases barely overlap anatomically); callers fall back to the old proportional-index
	// behavior in that case.
	const centroidsA = centroidsFor(A.seg);
	const centroidsB = centroidsFor(B.seg);
	const landmarkPairsAB: [Vec3, Vec3][] = [];
	if (centroidsA && centroidsB) {
		for (const label of Object.keys(centroidsA)) {
			const b = centroidsB[Number(label)];
			if (b) landmarkPairsAB.push([centroidsA[Number(label)], b]);
		}
	}
	const aToB = fitCaseMapping(landmarkPairsAB);
	const bToA = fitCaseMapping(landmarkPairsAB.map(([a, b]) => [b, a] as [Vec3, Vec3]));

	// Link Scroll's depth mapping deliberately uses the per-axis-independent fit, NOT the
	// (possibly full-affine) aToB/bToA above — axial scrolling only ever changes the source
	// pane's camera focal point along Z; X/Y stay wherever the crosshair last sat (often
	// nowhere near the anatomy at the new depth, e.g. still centered on the pancreas while
	// scrolling up to the lungs). A full affine's cross-axis coupling was fit on real
	// anatomical points where X/Y/Z all move together — querying it at a "pancreas X/Y +
	// lung Z" combination that never occurs in any real patient extrapolates wildly (measured
	// ~90-100mm off on real case data). The per-axis fit treats each axis as independent, so
	// a stale X/Y can't drag the Z answer off course; only its Z output is used below.
	const zOnlyAtoB = fitPerAxisLinear(landmarkPairsAB);
	const zOnlyBtoA = fitPerAxisLinear(landmarkPairsAB.map(([a, b]) => [b, a] as [Vec3, Vec3]));

	// --- Axial slice sync across the two cases. Prefers the landmark-fitted depth mapping
	// (maps the source pane's current world-mm depth into the destination case's space, then
	// converts that to a slice index) — falling back to the old plain proportional-index
	// fraction only when no reliable mapping could be fit. ---
	let linked = true;
	// Pane sizes at the last refit, so the next one can tell whether the cells are still moving.
	let lastRefitSizes = "";
	// Shared by Link Scroll AND Sync Cursor (and jumpToOrgan/jumpToMeasurement below) — NOT two
	// independent flags. Moving the crosshair (setToolCenter) also repositions the axial
	// camera as a side effect, firing CAMERA_MODIFIED same as a real scroll would; conversely,
	// scrolling the axial camera can move the crosshair's depth. Each mechanism maps world-mm
	// through a DIFFERENT fit (Z-only per-axis here vs full affine in Sync Cursor below), so if
	// each only guarded against its own re-entrancy, one's programmatic update would trigger
	// the other's listener, which nudges toward its own (slightly different) answer, which
	// re-triggers the first — a visible flicker as the two fight. One shared flag means
	// whichever mechanism is actively applying a change silences the other's reaction to it.
	let syncing = false;
	const mirror = (
		srcId: string,
		dstId: string,
		zMapFn: ((p: Vec3) => Vec3) | null,
		active: () => boolean = () => true
	) => () => {
		if (!linked || syncing || !active()) return;
		const s = engine.getViewport(srcId) as SliceViewport;
		const d = engine.getViewport(dstId) as SliceViewport;
		if (!s || !d) return;
		if (sliceCount(d) <= 1) return;
		// Everything below counts in Cornerstone's scroll steps, the same units d.scroll() takes.
		// They run from the min end of the volume along the camera's viewPlaneNormal (axial: head
		// to feet), NOT along the volume's storage k axis, which runs feet to head in some cases.
		// This throws when a viewport has no volume yet, so a pane mid-load is skipped.
		const info = (vp: SliceViewport): ScrollInfo | null => {
			try {
				return csUtils.getVolumeViewportScrollInfo(vp, vp.getVolumeId(), true);
			} catch {
				return null;
			}
		};
		const dInfo = info(d);
		if (!dInfo) return;

		let delta: number;
		if (zMapFn) {
			const srcWorld = s.getCamera().focalPoint as Vec3;
			const dstZ = zMapFn(srcWorld)[2];
			// Keep the destination's own X/Y and move only its depth, so the source's in-plane
			// position can't change which slice is picked.
			const dstFocal = d.getCamera().focalPoint as Vec3;
			delta = scrollDeltaToWorld(dInfo, [dstFocal[0], dstFocal[1], dstZ]);
		} else {
			const sInfo = info(s);
			if (!sInfo || sInfo.numScrollSteps < 1) return;
			let frac = sInfo.currentStepIndex / sInfo.numScrollSteps;
			// A flipped pane's normal points the other way, so its steps count from the other end.
			const sN = sInfo.sliceRangeInfo.camera.viewPlaneNormal;
			const dN = dInfo.sliceRangeInfo.camera.viewPlaneNormal;
			if (sN && dN && sN[0] * dN[0] + sN[1] * dN[1] + sN[2] * dN[2] < 0) frac = 1 - frac;
			delta = Math.round(frac * dInfo.numScrollSteps) - dInfo.currentStepIndex;
		}
		if (delta === 0) return;
		syncing = true;
		try {
			d.scroll(delta);
		} catch (e) {
			console.warn("[compare] link scroll failed:", e);
		} finally {
			// Always clear it: a stuck flag would silently switch off Link scroll and Sync cursor.
			setTimeout(() => { syncing = false; }, 0);
		}
	};
	const onA = mirror(A.ax, B.ax, zOnlyAtoB);
	const onB = mirror(B.ax, A.ax, zOnlyBtoA);
	els.aAx.addEventListener(Enums.Events.CAMERA_MODIFIED, onA);
	els.bAx.addEventListener(Enums.Events.CAMERA_MODIFIED, onB);
	// In a Sagittal or Coronal single-plane view the axial camera never moves, so the visible
	// panes need their own mirror. It follows the proportional slice position: the per-axis
	// fit above is only trusted for depth. It stays off in MPR, where moving one case's
	// crosshair re-centres its other panes and would otherwise snap the other case's panes.
	// The page hides a plane by setting display:none on its cell (it keeps the element mounted).
	const showsOnlyPane = (paneEl: HTMLElement, axialEl: HTMLElement) =>
		paneEl.parentElement?.style.display !== "none" && axialEl.parentElement?.style.display === "none";
	const onASag = mirror(A.sag, B.sag, null, () => showsOnlyPane(els.aSag, els.aAx));
	const onBSag = mirror(B.sag, A.sag, null, () => showsOnlyPane(els.bSag, els.bAx));
	const onACor = mirror(A.cor, B.cor, null, () => showsOnlyPane(els.aCor, els.aAx));
	const onBCor = mirror(B.cor, A.cor, null, () => showsOnlyPane(els.bCor, els.bAx));
	els.aSag.addEventListener(Enums.Events.CAMERA_MODIFIED, onASag);
	els.bSag.addEventListener(Enums.Events.CAMERA_MODIFIED, onBSag);
	els.aCor.addEventListener(Enums.Events.CAMERA_MODIFIED, onACor);
	els.bCor.addEventListener(Enums.Events.CAMERA_MODIFIED, onBCor);

	// --- Cross-case cursor sync: mirror one case's crosshair onto the other, via the same
	// landmark-fitted mapping (world mm → world mm directly), falling back to the old
	// voxel-index-fraction approach when no mapping could be fit. Off by default. ---
	const caseViewports: Record<string, string[]> = {
		[A.tg]: [A.ax, A.sag, A.cor],
		[B.tg]: [B.ax, B.sag, B.cor],
	};
	let syncCursor = false;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const onCrosshair = (evt: any) => {
		if (!syncCursor || syncing) return;
		const srcTg = evt?.detail?.toolGroupId as string;
		const center = evt?.detail?.toolCenter as Vec3;
		const route =
			srcTg === A.tg
				? { srcVp: A.ax, dstVp: B.ax, dstTg: B.tg, map: aToB }
				: srcTg === B.tg
					? { srcVp: B.ax, dstVp: A.ax, dstTg: A.tg, map: bToA }
					: null;
		if (!route || !center) return;
		try {
			let world: number[];
			if (route.map) {
				world = route.map(center);
			} else {
				const src = engine.getViewport(route.srcVp)?.getImageData();
				const dst = engine.getViewport(route.dstVp)?.getImageData();
				if (!src || !dst) return;
				// Fractions along each WORLD axis of each volume's bounds, not along its storage
				// axes: cases store x, y and z in different directions, and an index fraction
				// would mirror the point to the other side on every axis where they differ.
				world = mapByBounds(center, src.imageData.getBounds(), dst.imageData.getBounds());
			}
			const dstTool = tools.ToolGroupManager.getToolGroup(route.dstTg)?.getToolInstance(
				tools.CrosshairsTool.toolName
			) as { setToolCenter?: (mm: number[], suppress?: boolean) => void } | undefined;
			if (dstTool?.setToolCenter) {
				syncing = true;
				dstTool.setToolCenter(world, true); // suppressEvents → no feedback loop on THIS event;
				// repositioning still moves the axial camera as a side effect, which is exactly
				// what the shared `syncing` flag (not just this event's own suppression) guards
				// Link Scroll's mirror() against reacting to.
				engine.renderViewports(caseViewports[route.dstTg]);
				setTimeout(() => { syncing = false; }, 0);
			}
		} catch (e) {
			console.warn("[compare] cursor sync failed:", e);
			syncing = false;
		}
	};
	eventTarget.addEventListener(tools.Enums.Events.CROSSHAIR_TOOL_CENTER_CHANGED, onCrosshair);

	const allVps = [A.ax, A.sag, A.cor, B.ax, B.sag, B.cor];
	const caseTgAndVps = [
		[A.tg, [A.ax, A.sag, A.cor]] as const,
		[B.tg, [B.ax, B.sag, B.cor]] as const,
	];
	const casePanes = [
		[A.seg, [A.ax, A.sag, A.cor]] as const,
		[B.seg, [B.ax, B.sag, B.cor]] as const,
	];

	// Which case each annotation was drawn on, read from the viewport it was added to. The
	// "jump to measurement" caller needs the case to know which crosshair to move.
	const annotationCases = createAnnotationCaseTracker();
	eventTarget.addEventListener(tools.Enums.Events.ANNOTATION_ADDED, annotationCases.onAdded);
	eventTarget.addEventListener(tools.Enums.Events.ANNOTATION_REMOVED, annotationCases.onRemoved);
	const caseKeyForAnnotation = annotationCases.caseKeyFor;

	// --- Focus tracking: which viewport cine/flip/rotate act on (whichever pane was last
	// clicked/scrolled), and which pane is each case's reference-line "source" (tracked
	// independently per case so both cases can show reference lines simultaneously). ---
	let focusedViewportId: string = A.ax;
	let referenceLinesOn = false;
	let sourcePaneA: PaneName = "axial";
	let sourcePaneB: PaneName = "axial";
	const applyReferenceLines = () => {
		for (const [tgId, sourcePane] of [
			[A.tg, sourcePaneA] as const,
			[B.tg, sourcePaneB] as const,
		]) {
			const tg = tools.ToolGroupManager.getToolGroup(tgId);
			if (!tg) continue;
			for (const pane of ["axial", "sagittal", "coronal"] as PaneName[]) {
				const instanceName = refLineInstanceName(tgId, pane);
				if (referenceLinesOn && pane === sourcePane) tg.setToolEnabled(instanceName);
				else tg.setToolDisabled(instanceName);
			}
		}
		engine.renderViewports(allVps);
	};
	const setFocus = (viewportId: string) => {
		const info = paneInfo(viewportId);
		if (!info) return;
		focusedViewportId = viewportId;
		const paneChanged = info.caseKey === "a" ? sourcePaneA !== info.pane : sourcePaneB !== info.pane;
		if (info.caseKey === "a") sourcePaneA = info.pane; else sourcePaneB = info.pane;
		if (referenceLinesOn && paneChanged) applyReferenceLines();
	};
	const focusListeners = ([A.ax, A.sag, A.cor, B.ax, B.sag, B.cor] as const).map((vpId) => {
		const el = { [A.ax]: els.aAx, [A.sag]: els.aSag, [A.cor]: els.aCor, [B.ax]: els.bAx, [B.sag]: els.bSag, [B.cor]: els.bCor }[vpId];
		const handler = () => setFocus(vpId);
		el.addEventListener("mousedown", handler);
		el.addEventListener("wheel", handler, { passive: true });
		return { el, handler };
	});

	const sliceListenerTargets = [
		{ el: els.aAx, vpId: A.ax }, { el: els.aSag, vpId: A.sag }, { el: els.aCor, vpId: A.cor },
		{ el: els.bAx, vpId: B.ax }, { el: els.bSag, vpId: B.sag }, { el: els.bCor, vpId: B.cor },
	];
	// Slice-counter subscriptions still attached; destroy() drops any the caller did not.
	const sliceUnsubscribers = new Set<() => void>();

	// --- Cine playback — hand-rolled setInterval + viewport.scroll(), not
	// cornerstoneTools.utilities.cine.playClip (same rationale as the single viewer: with
	// both the CT volume and the segmentation labelmap on one viewport, that utility's
	// "smallest spacing" actor-picking heuristic can pick the wrong one). ---
	type MprViewportLike = {
		scroll(delta?: number): void;
		// Optional, same as SliceViewport above — not every viewport implementation exposes
		// this directly; sliceCount()'s getImageData() fallback covers the gap.
		getNumberOfSlices?(): number;
		getSliceIndex(): number;
		flip(flipDirection: { flipHorizontal?: boolean; flipVertical?: boolean }): void;
		getRotation(): number;
		setRotation(rotation: number): void;
		render(): void;
	};
	let cineIntervalId: number | null = null;
	const stopCineFn = () => {
		if (cineIntervalId === null) return;
		window.clearInterval(cineIntervalId);
		cineIntervalId = null;
	};
	const startCineFn = (fps = 12): boolean => {
		stopCineFn();
		const vp = engine.getViewport(focusedViewportId) as unknown as MprViewportLike | undefined;
		if (!vp) return false;
		try {
			const numSlices = sliceCount(vp as unknown as SliceViewport);
			if (!numSlices || numSlices < 2) return false;
			const clampedFps = Math.max(1, Math.min(100, fps));
			cineIntervalId = window.setInterval(() => {
				const current = vp.getSliceIndex();
				vp.scroll(current >= numSlices - 1 ? -current : 1);
			}, 1000 / clampedFps);
			return true;
		} catch (e) {
			console.warn("[compare] cine playback unavailable:", e);
			return false;
		}
	};

	// --- Measurement tools + magnify loupe: hand the primary mouse button to one at a time,
	// on BOTH cases at once (so either case can be measured while a tool is active). ---
	const removeMagnifyAnnotations = () => {
		try {
			const all = tools.annotation.state.getAllAnnotations() ?? [];
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			for (const a of [...all] as any[]) {
				if (a?.metadata?.toolName === MAGNIFY_TOOL && a.annotationUID) {
					tools.annotation.state.removeAnnotation(a.annotationUID);
				}
			}
		} catch {
			/* annotation state not ready */
		}
	};
	const setActiveMeasurementToolFn = (toolName: PrimaryMouseToolName | null) => {
		const { MouseBindings } = tools.Enums;
		for (const [tgId] of caseTgAndVps) {
			const tg = tools.ToolGroupManager.getToolGroup(tgId);
			if (!tg) continue;
			for (const name of [...MEASUREMENT_TOOL_NAMES, MAGNIFY_TOOL]) tg.setToolPassive(name);
			if (!toolName) {
				tg.setToolActive(tools.CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
				continue;
			}
			tg.setToolDisabled(tools.CrosshairsTool.toolName);
			tg.setToolActive(toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
		}
		if (toolName !== MAGNIFY_TOOL) removeMagnifyAnnotations();
		engine.renderViewports(allVps);
	};

	return {
		setLinked(next) {
			linked = next;
		},
		setSyncCursor(next) {
			syncCursor = next;
		},
		setSegVisible(visible) {
			for (const vpId of allVps) {
				try {
					tools.segmentation.config.visibility.setSegmentationRepresentationVisibility(
						vpId,
						{ segmentationId: vpId.startsWith("cmp_a") ? A.seg : B.seg, type: SegmentationRepresentations.Labelmap },
						visible
					);
				} catch {
					/* representation may be absent */
				}
			}
			engine.renderViewports(allVps);
		},
		setSegOpacity(alpha) {
			for (const [segId, vps] of casePanes) {
				// A case without a mask would only add an empty batch to the render queue.
				if (!panesWithMask(segId, vps).length) continue;
				try {
					tools.segmentation.config.style.setStyle(
						{ type: SegmentationRepresentations.Labelmap, segmentationId: segId },
						{ ...SEG_CONFIG, fillAlpha: alpha, fillAlphaInactive: alpha }
					);
				} catch {
					/* segmentation may be absent */
				}
			}
			engine.renderViewports(allVps);
		},
		setOrganVisibility(checkState) {
			// checkState[0] is the background (always on); indices 1..N are organ labels.
			// Apply the same per-organ visibility to both cases' segmentations.
			// Each setSegmentIndexVisibility queues two segmentation renders, drained one per
			// frame, so only organs that change are set (setting all ~35 on every pane queued
			// ~420 renders, seconds of lag). Panes without the mask are skipped: Cornerstone
			// still queues a render for them, an empty one that stalls the queue. The cases
			// take turns, so each one's first render is near the front of the queue and both
			// update together instead of case B waiting for all of case A's renders.
			const cases = casePanes.map(([segId, vps]) => ({
				spec: { segmentationId: segId, type: SegmentationRepresentations.Labelmap },
				panes: panesWithMask(segId, vps),
			}));
			for (let i = 1; i < checkState.length; i++) {
				for (let p = 0; p < 3; p++) {
					for (const { spec, panes } of cases) {
						const vpId = panes[p];
						if (!vpId) continue;
						try {
							if (tools.segmentation.config.visibility.getSegmentIndexVisibility(vpId, spec, i) === checkState[i]) continue;
							tools.segmentation.config.visibility.setSegmentIndexVisibility(vpId, spec, i, checkState[i]);
						} catch {
							/* segmentation may be absent (dev checkout without masks) */
						}
					}
				}
			}
			engine.renderViewports(allVps);
		},
		applyWindow(width, center) {
			const low = center - width / 2;
			const high = center + width / 2;
			for (const vpId of allVps) {
				const vp = engine.getViewport(vpId);
				const actor = vp?.getDefaultActor();
				if (!actor) continue;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const tf = (actor.actor.getProperty() as any).getRGBTransferFunction(0);
				tf.setMappingRange(low, high);
				tf.updateRange();
				vp.render();
			}
		},
		applyZoom(zoom) {
			for (const vpId of allVps) {
				// setZoom is a volume-viewport API; guard in case a viewport type lacks it.
				const vp = engine.getViewport(vpId) as { setZoom?: (z: number) => void; render?: () => void };
				vp?.setZoom?.(zoom);
				vp?.render?.();
			}
		},
		centerCursor() {
			// For each case, snap its three planes onto that case's crosshair focal point.
			for (const [tgId, vps] of [
				[A.tg, [A.ax, A.sag, A.cor]],
				[B.tg, [B.ax, B.sag, B.cor]],
			] as const) {
				const tool = tools.ToolGroupManager.getToolGroup(tgId)?.getToolInstance(
					tools.CrosshairsTool.toolName
				) as { toolCenter?: [number, number, number] } | undefined;
				const toolCenter = tool?.toolCenter;
				if (!toolCenter) continue;
				for (const vpId of vps) {
					const vp = engine.getViewport(vpId) as unknown as {
						setViewReference?: (r: { FrameOfReferenceUID: string; cameraFocalPoint: number[] }) => void;
						render?: () => void;
					};
					vp?.setViewReference?.({ FrameOfReferenceUID: "1.2.840.10008.1.4", cameraFocalPoint: toolCenter });
					vp?.render?.();
				}
			}
		},
		jumpToOrgan(label) {
			// Move each case's crosshair to that case's own centroid for the organ. Guard the
			// proportional-scroll mirror so linking doesn't drag B's axial back to A's fraction.
			syncing = true;
			const missing: ("a" | "b")[] = [];
			for (const [which, segId, tgId, vps] of [
				["a", A.seg, A.tg, [A.ax, A.sag, A.cor]],
				["b", B.seg, B.tg, [B.ax, B.sag, B.cor]],
			] as const) {
				const mm = centroidsFor(segId)?.[label];
				if (!mm) {
					missing.push(which); // organ absent in this case
					continue;
				}
				const tool = tools.ToolGroupManager.getToolGroup(tgId)?.getToolInstance(
					tools.CrosshairsTool.toolName
				) as { setToolCenter?: (mm: number[], suppress?: boolean) => void } | undefined;
				if (!tool?.setToolCenter) continue;
				tool.setToolCenter(mm, true); // suppressEvents → no crosshair/cursor-sync feedback
				engine.renderViewports([...vps]);
			}
			setTimeout(() => { syncing = false; }, 0);
			return missing;
		},
		refit(keepView = false) {
			type Pane = { element?: HTMLElement; getZoom?: () => number; setZoom?: (z: number) => void; resetCamera?: () => void };
			// The resize puts each camera back and fires its camera events; they are not user
			// scrolls, so linked scroll and the cursor sync must not map them onto the other case.
			syncing = true;
			if (keepView) {
				// A dock narrowed or widened the grid while the user may be zoomed onto a
				// measurement. Keep the cameras through the resize, then put each pane's zoom
				// (relative to the fit of its new cell) back, as the single viewer does.
				const zooms = new Map<string, number>();
				for (const vpId of allVps) {
					const z = (engine.getViewport(vpId) as Pane | undefined)?.getZoom?.();
					if (typeof z === "number" && Number.isFinite(z) && z > 0) zooms.set(vpId, z);
				}
				engine.resize(true, true);
				for (const [vpId, z] of zooms) {
					const vp = engine.getViewport(vpId) as Pane | undefined;
					if (!vp?.setZoom || (vp.element && (vp.element.clientWidth === 0 || vp.element.clientHeight === 0))) continue;
					vp.setZoom(z);
				}
			} else {
				// The grid changed size (view-mode switch) — re-measure and re-fit each pane so
				// the CT fills its (now differently sized) cell instead of staying at the old fit.
				engine.resize(true, false);
				for (const vpId of allVps) {
					(engine.getViewport(vpId) as Pane | undefined)?.resetCamera?.();
				}
			}
			setTimeout(() => { syncing = false; }, 0);
			// A resize dropped for a queued render frame changes nothing, so the caller needs
			// another pass; so does a cell that moved since the last one.
			const dropped = (engine as unknown as { _animationFrameSet?: boolean })._animationFrameSet === true;
			const sizes = allVps
				.map((vpId) => {
					const el = (engine.getViewport(vpId) as { element?: HTMLElement } | undefined)?.element;
					return el ? `${el.clientWidth}x${el.clientHeight}` : "";
				})
				.join("|");
			const moved = sizes !== lastRefitSizes;
			lastRefitSizes = sizes;
			engine.renderViewports(allVps);
			// The SVG layer (crosshairs, ROI outlines, measurement lines) only repaints on an
			// annotation render; that render also re-seats the automatically placed
			// statistics boxes for the resized cells.
			repaintPaneAnnotations(allVps);
			return dropped || moved;
		},
		resetView() {
			for (const vpId of allVps) {
				const vp = engine.getViewport(vpId);
				vp?.resetCamera();
				vp?.render();
			}
			repaintPaneAnnotations(allVps);
		},
		setFocusedViewport(viewportId) {
			setFocus(viewportId);
		},
		setReferenceLines(enabled) {
			referenceLinesOn = enabled;
			applyReferenceLines();
		},
		flipFocused() {
			const vp = engine.getViewport(focusedViewportId) as unknown as MprViewportLike | undefined;
			try {
				vp?.flip({ flipHorizontal: true });
			} catch (e) {
				console.warn("[compare] flip failed:", e);
			}
		},
		rotateFocused90() {
			const vp = engine.getViewport(focusedViewportId) as unknown as MprViewportLike | undefined;
			if (!vp) return;
			try {
				const next = (vp.getRotation() + 90) % 360;
				vp.setRotation(next);
				// setRotation only triggers CAMERA_MODIFIED — it never calls render() itself.
				vp.render();
			} catch (e) {
				console.warn("[compare] rotate failed:", e);
			}
		},
		startCine(fps) {
			return startCineFn(fps);
		},
		stopCine() {
			stopCineFn();
		},
		setActiveMeasurementTool(toolName) {
			setActiveMeasurementToolFn(toolName);
		},
		cancelDrawing() {
			let cancelled = false;
			for (const vpId of allVps) {
				const element = engine.getViewport(vpId)?.element;
				if (!element) continue;
				let uid: string | undefined;
				try {
					uid = tools.cancelActiveManipulations(element);
				} catch {
					uid = undefined;
				}
				if (!uid) continue;
				cancelled = true;
				// Cornerstone keeps a half-drawn line where the pointer left it; Freehand's own
				// cancel has already removed its open outline.
				try {
					if (tools.annotation.state.getAnnotation(uid)) tools.annotation.state.removeAnnotation(uid);
				} catch {
					/* annotation state may be gone with the engine — nothing to remove */
				}
			}
			if (cancelled) engine.renderViewports(allVps);
			return cancelled;
		},
		clearMeasurements() {
			try {
				const all = tools.annotation.state.getAllAnnotations() ?? [];
				const names = [...MEASUREMENT_TOOL_NAMES, MAGNIFY_TOOL] as readonly string[];
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				for (const a of [...all] as any[]) {
					const toolName = a?.metadata?.toolName;
					if (toolName && names.includes(toolName) && a.annotationUID) {
						tools.annotation.state.removeAnnotation(a.annotationUID);
					}
				}
			} catch {
				/* annotation state may not be ready — no-op */
			}
			engine.renderViewports(allVps);
		},
		getMeasurementSummaries() {
			try {
				const all = tools.annotation.state.getAllAnnotations() ?? [];
				const names = MEASUREMENT_TOOL_NAMES as readonly string[];
				const out: MeasurementSummary[] = [];
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				for (const a of all as any[]) {
					if (!a?.annotationUID || !names.includes(a?.metadata?.toolName)) continue;
					const caseKey = caseKeyForAnnotation(a);
					if (!caseKey) continue;
					out.push(toSummary(a, caseKey));
				}
				return out;
			} catch {
				return [];
			}
		},
		renameMeasurement(uid, label) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const a = tools.annotation.state.getAnnotation(uid) as any;
			if (!a?.data) return;
			a.data.label = label;
			engine.render();
		},
		removeMeasurement(uid) {
			try {
				tools.annotation.state.removeAnnotation(uid);
			} catch {
				/* already gone */
			}
			engine.renderViewports(allVps);
		},
		jumpToMeasurement(uid, caseKey) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const a = tools.annotation.state.getAnnotation(uid) as any;
			const c = annotationCenter(a);
			if (!c) return null;
			const tgId = caseKey === "a" ? A.tg : B.tg;
			const vps = caseKey === "a" ? [A.ax, A.sag, A.cor] : [B.ax, B.sag, B.cor];
			const tool = tools.ToolGroupManager.getToolGroup(tgId)?.getToolInstance(
				tools.CrosshairsTool.toolName
			) as { setToolCenter?: (mm: number[], suppress?: boolean) => void } | undefined;
			if (tool?.setToolCenter) {
				syncing = true; // guard the link-scroll mirror, same as jumpToOrgan
				tool.setToolCenter(c, true);
				engine.renderViewports(vps);
				setTimeout(() => { syncing = false; }, 0);
			}
			return c;
		},
		subscribeToMeasurementChanges(cb) {
			const names = MEASUREMENT_TOOL_NAMES as readonly string[];
			const make = (kind: MeasurementChangeKind) => (evt: Event) => {
				const a = (evt as CustomEvent).detail?.annotation;
				if (!a?.annotationUID || !names.includes(a?.metadata?.toolName)) return;
				const caseKey =
					caseKeyForAnnotation(a) ?? (kind === "removed" ? annotationCases.caseKeyForRemoved(a) : null);
				if (!caseKey) return;
				cb(kind, toSummary(a, caseKey));
			};
			const pairs: [string, EventListener][] = [
				[tools.Enums.Events.ANNOTATION_COMPLETED, make("completed") as EventListener],
				[tools.Enums.Events.ANNOTATION_MODIFIED, make("modified") as EventListener],
				[tools.Enums.Events.ANNOTATION_REMOVED, make("removed") as EventListener],
			];
			for (const [name, handler] of pairs) eventTarget.addEventListener(name, handler);
			return () => {
				for (const [name, handler] of pairs) eventTarget.removeEventListener(name, handler);
			};
		},
		subscribeToSliceChanges(cb) {
			const cleanups: (() => void)[] = [];
			for (const { el, vpId } of sliceListenerTargets) {
				const viewport = engine.getViewport(vpId) as SliceViewport | undefined;
				if (!viewport) continue;
				const read = (): SliceReadout => ({ current: viewport.getSliceIndex(), total: sliceCount(viewport) });
				let last = read();
				cb(vpId, last);
				// Pan, zoom and rotate fire this event too, so only a changed reading goes out.
				const handler = () => {
					const next = read();
					if (next.current === last.current && next.total === last.total) return;
					last = next;
					cb(vpId, next);
				};
				el.addEventListener(Enums.Events.CAMERA_MODIFIED, handler);
				cleanups.push(() => el.removeEventListener(Enums.Events.CAMERA_MODIFIED, handler));
			}
			const unsubscribe = () => {
				sliceUnsubscribers.delete(unsubscribe);
				cleanups.forEach((fn) => fn());
			};
			sliceUnsubscribers.add(unsubscribe);
			return unsubscribe;
		},
		destroy() {
			stopCineFn();
			for (const unsubscribe of [...sliceUnsubscribers]) unsubscribe();
			for (const { el, handler } of focusListeners) {
				el.removeEventListener("mousedown", handler);
				el.removeEventListener("wheel", handler);
			}
			els.aAx.removeEventListener(Enums.Events.CAMERA_MODIFIED, onA);
			els.bAx.removeEventListener(Enums.Events.CAMERA_MODIFIED, onB);
			els.aSag.removeEventListener(Enums.Events.CAMERA_MODIFIED, onASag);
			els.bSag.removeEventListener(Enums.Events.CAMERA_MODIFIED, onBSag);
			els.aCor.removeEventListener(Enums.Events.CAMERA_MODIFIED, onACor);
			els.bCor.removeEventListener(Enums.Events.CAMERA_MODIFIED, onBCor);
			eventTarget.removeEventListener(tools.Enums.Events.CROSSHAIR_TOOL_CENTER_CHANGED, onCrosshair);
			eventTarget.removeEventListener(tools.Enums.Events.ANNOTATION_ADDED, annotationCases.onAdded);
			eventTarget.removeEventListener(tools.Enums.Events.ANNOTATION_REMOVED, annotationCases.onRemoved);
			// A handle that a newer setupCompare has already replaced must not tear down the
			// shared tool groups, segmentations, engine or cache entries the newer one is using.
			if (currentEngine !== engine) return;
			clearAllAnnotations();
			try {
				tools.segmentation.removeAllSegmentations();
				tools.ToolGroupManager.destroyToolGroup(A.tg);
				tools.ToolGroupManager.destroyToolGroup(B.tg);
			} catch {
				/* ignore */
			}
			engine.destroy();
			currentEngine = null;
			// Cornerstone's volume cache is a module-level singleton independent of the
			// RenderingEngine — destroying the engine above does NOT free the CT/segmentation
			// volumes it was displaying. Without this, every case comparison the user opens in
			// this SPA session (no full page reload between them, unlike the single-case viewer)
			// leaves its full-resolution volumes pinned in memory, growing unbounded until the
			// tab OOMs. Same ids loadCase used to cache them (ctVolId formula must match).
			for (const id of [`${A.seg}_ct:${src.ctA}`, `${B.seg}_ct:${src.ctB}`, A.seg, B.seg]) {
				removeCachedVolume(id);
			}
		},
	};
}
