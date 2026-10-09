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
import { segmentation_category_colors } from "./constants";

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
	textBoxFontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
	textBoxFontSize: "14px",
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
	// Move each case's crosshair to that organ's centroid (label = segment index).
	jumpToOrgan: (label: number) => void;
	// Re-fit the viewports after the surrounding grid changes size (view-mode switch).
	refit: () => void;
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
	clearMeasurements: () => void;
	getMeasurementSummaries: () => MeasurementSummary[];
	renameMeasurement: (uid: string, label: string) => void;
	removeMeasurement: (uid: string) => void;
	jumpToMeasurement: (uid: string, caseKey: CaseKey) => Vec3 | null;
	subscribeToMeasurementChanges: (
		cb: (kind: MeasurementChangeKind, summary: MeasurementSummary) => void
	) => () => void;
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
	const text = a?.data?.text;
	if (typeof text === "string" && text.trim()) return text.trim();
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
	return "…";
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

// Fallback for too few landmarks for a full affine fit: an independent linear regression
// (scale + offset) per axis. Needs at least 2 pairs, and each axis needs some spread across
// the landmarks — an axis that can't be fit rejects the whole mapping rather than silently
// degrading to a wrong-but-plausible-looking transform.
export function fitPerAxisLinear(pairs: [Vec3, Vec3][]): ((p: Vec3) => Vec3) | null {
	if (pairs.length < 2) return null;
	const n = pairs.length;
	const fits = [0, 1, 2].map((axis) => {
		let sumA = 0, sumB = 0, sumAA = 0, sumAB = 0;
		for (const [a, b] of pairs) {
			sumA += a[axis]; sumB += b[axis]; sumAA += a[axis] * a[axis]; sumAB += a[axis] * b[axis];
		}
		const denom = n * sumAA - sumA * sumA;
		if (Math.abs(denom) < 1e-6) return null; // landmarks don't spread on this axis
		const s = (n * sumAB - sumA * sumB) / denom;
		const t = (sumB - s * sumA) / n;
		return { s, t };
	});
	if (fits.some((f) => !f)) return null;
	return (p: Vec3): Vec3 => [0, 1, 2].map((i) => fits[i]!.s * p[i] + fits[i]!.t) as Vec3;
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
	tools.addTool(tools.RectangleROITool);
	tools.addTool(tools.EllipticalROITool);
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

// Load one case's CT + segmentation into its 3 viewports. Segmentation failures are
// swallowed so the CT still shows (dev checkouts often lack masks).
async function loadCase(
	engine: RenderingEngine,
	ctUrl: string,
	segUrl: string,
	viewportIds: string[],
	segmentationId: string,
	colorLUT: ColorLUT
) {
	const ctIds = await createNiftiImageIdsAndCacheMetadata({ url: ctUrl });
	const ctVolId = `${segmentationId}_ct:${ctUrl}`;
	const ctVol = await volumeLoader.createAndCacheVolume(ctVolId, { imageIds: ctIds });
	await ctVol.load();
	await setVolumesForViewports(engine, [{ volumeId: ctVolId }], viewportIds);
	engine.renderViewports(viewportIds);

	// An empty URL means the case has no mask (CancerVerse): show the CT alone.
	if (!segUrl) return;
	try {
		const segIds = await createNiftiImageIdsAndCacheMetadata({ url: segUrl });
		if (!segIds.length) return;
		const segVol = await volumeLoader.createAndCacheVolume(segmentationId, { imageIds: segIds });
		await segVol.load();
		// segVol.load() resolving only guarantees the volume's own combined scalar buffer is
		// ready — NOT that every per-slice image is individually cached (cache.getImage(id)).
		// That population can lag behind in the background; computeCentroids reading it right
		// after loadCase returns is a race it can lose (seen in practice: the case loaded
		// second, with less elapsed background time, had ZERO of its per-slice images ready).
		// Force it explicitly so centroid computation never runs against a half-populated cache.
		// loadAndCacheImages returns an ARRAY OF PROMISES, not Promise.all()'d — awaiting the
		// array itself resolves immediately without waiting for any individual image to load.
		await Promise.all(imageLoader.loadAndCacheImages(segIds));
		tools.segmentation.segmentationStyle.setStyle(
			{ type: SegmentationRepresentations.Labelmap, segmentationId },
			SEG_CONFIG
		);
		tools.segmentation.addSegmentations([
			{
				segmentationId,
				representation: {
					type: SegmentationRepresentations.Labelmap,
					data: { imageIds: segIds, volumeId: segmentationId },
				},
			},
		]);
		for (const vpId of viewportIds) {
			await addVolumeLabelmap(engine, vpId, segmentationId, colorLUT);
			tools.segmentation.activeSegmentation.setActiveSegmentation(vpId, segmentationId);
		}
	} catch (e) {
		console.warn(`[compare] segmentation unavailable for ${segmentationId}:`, e);
	}
}

export async function setupCompare(els: CompareElements, src: CompareSources): Promise<CompareHandle> {
	await ensureInit();

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
	await loadCase(engine, src.ctA, src.segA, [A.ax, A.sag, A.cor], A.seg, colorLUT);
	await loadCase(engine, src.ctB, src.segB, [B.ax, B.sag, B.cor], B.seg, colorLUT);

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
	const mirror = (srcId: string, dstId: string, zMapFn: ((p: Vec3) => Vec3) | null) => () => {
		if (!linked || syncing) return;
		const s = engine.getViewport(srcId) as SliceViewport;
		const d = engine.getViewport(dstId) as SliceViewport;
		if (!s || !d) return;
		const nD = sliceCount(d);
		if (nD <= 1) return;

		let target: number;
		if (zMapFn) {
			const dstImageData = d.getImageData();
			if (!dstImageData) return;
			const srcWorld = s.getCamera().focalPoint as Vec3;
			const dstZ = zMapFn(srcWorld)[2];
			// X/Y here are throwaways — for the axis-aligned volumes these viewports use, the
			// slice (k) index depends only on world Z, not X/Y, so any placeholder is fine.
			const dstIdx = csUtils.transformWorldToIndexContinuous(dstImageData.imageData, [srcWorld[0], srcWorld[1], dstZ]);
			target = Math.round(dstIdx[2]);
		} else {
			const nS = sliceCount(s);
			if (nS <= 1) return;
			target = Math.round((s.getSliceIndex() / (nS - 1)) * (nD - 1));
		}
		target = Math.max(0, Math.min(nD - 1, target));
		const delta = target - d.getSliceIndex();
		if (delta === 0) return;
		syncing = true;
		d.scroll(delta);
		setTimeout(() => { syncing = false; }, 0);
	};
	const onA = mirror(A.ax, B.ax, zOnlyAtoB);
	const onB = mirror(B.ax, A.ax, zOnlyBtoA);
	els.aAx.addEventListener(Enums.Events.CAMERA_MODIFIED, onA);
	els.bAx.addEventListener(Enums.Events.CAMERA_MODIFIED, onB);

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
				const sIdx = csUtils.transformWorldToIndexContinuous(src.imageData, center);
				const dIdx = [0, 1, 2].map((i) => {
					const frac = Math.min(1, Math.max(0, sIdx[i] / ((src.dimensions[i] - 1) || 1)));
					return frac * ((dst.dimensions[i] - 1) || 1);
				}) as Vec3;
				world = csUtils.transformIndexToWorld(dst.imageData, dIdx);
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

	// Known FrameOfReferenceUIDs for each case's volume, captured once after load — used to
	// tag which case a measurement annotation belongs to (needed since it's the caller's job
	// to know which case's crosshair to move on "jump to measurement").
	const forA = (engine.getViewport(A.ax) as unknown as { getFrameOfReferenceUID?: () => string })
		?.getFrameOfReferenceUID?.();
	const forB = (engine.getViewport(B.ax) as unknown as { getFrameOfReferenceUID?: () => string })
		?.getFrameOfReferenceUID?.();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const caseKeyForAnnotation = (a: any): CaseKey | null => {
		const f = a?.metadata?.FrameOfReferenceUID;
		if (f && f === forA) return "a";
		if (f && f === forB) return "b";
		return null;
	};

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
			for (const segId of [A.seg, B.seg]) {
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
			for (const [segId, vps] of [
				[A.seg, [A.ax, A.sag, A.cor]],
				[B.seg, [B.ax, B.sag, B.cor]],
			] as const) {
				for (let i = 1; i < checkState.length; i++) {
					for (const vpId of vps) {
						try {
							tools.segmentation.config.visibility.setSegmentIndexVisibility(
								vpId,
								{ segmentationId: segId, type: SegmentationRepresentations.Labelmap },
								i,
								checkState[i]
							);
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
			for (const [segId, tgId, vps] of [
				[A.seg, A.tg, [A.ax, A.sag, A.cor]],
				[B.seg, B.tg, [B.ax, B.sag, B.cor]],
			] as const) {
				const mm = centroidsFor(segId)?.[label];
				if (!mm) continue; // organ absent in this case
				const tool = tools.ToolGroupManager.getToolGroup(tgId)?.getToolInstance(
					tools.CrosshairsTool.toolName
				) as { setToolCenter?: (mm: number[], suppress?: boolean) => void } | undefined;
				if (!tool?.setToolCenter) continue;
				tool.setToolCenter(mm, true); // suppressEvents → no crosshair/cursor-sync feedback
				engine.renderViewports([...vps]);
			}
			setTimeout(() => { syncing = false; }, 0);
		},
		refit() {
			// The grid changed size (view-mode switch) — re-measure and re-fit each pane so
			// the CT fills its (now differently sized) cell instead of staying at the old fit.
			engine.resize(true, false);
			for (const vpId of allVps) {
				const vp = engine.getViewport(vpId) as { resetCamera?: () => void };
				vp?.resetCamera?.();
			}
			engine.renderViewports(allVps);
		},
		resetView() {
			for (const vpId of allVps) {
				const vp = engine.getViewport(vpId);
				vp?.resetCamera();
				vp?.render();
			}
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
				const caseKey = caseKeyForAnnotation(a);
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
		destroy() {
			stopCineFn();
			for (const { el, handler } of focusListeners) {
				el.removeEventListener("mousedown", handler);
				el.removeEventListener("wheel", handler);
			}
			els.aAx.removeEventListener(Enums.Events.CAMERA_MODIFIED, onA);
			els.bAx.removeEventListener(Enums.Events.CAMERA_MODIFIED, onB);
			eventTarget.removeEventListener(tools.Enums.Events.CROSSHAIR_TOOL_CENTER_CHANGED, onCrosshair);
			try {
				tools.segmentation.removeAllSegmentations();
				tools.ToolGroupManager.destroyToolGroup(A.tg);
				tools.ToolGroupManager.destroyToolGroup(B.tg);
			} catch {
				/* ignore */
			}
			if (currentEngine) {
				currentEngine.destroy();
				currentEngine = null;
			}
			// Cornerstone's volume cache is a module-level singleton independent of the
			// RenderingEngine — destroying the engine above does NOT free the CT/segmentation
			// volumes it was displaying. Without this, every case comparison the user opens in
			// this SPA session (no full page reload between them, unlike the single-case viewer)
			// leaves its full-resolution volumes pinned in memory, growing unbounded until the
			// tab OOMs. Same ids loadCase used to cache them (ctVolId formula must match).
			for (const id of [`${A.seg}_ct:${src.ctA}`, `${B.seg}_ct:${src.ctB}`, A.seg, B.seg]) {
				try {
					cache.removeVolumeLoadObject(id);
				} catch {
					/* not cached, e.g. segmentation failed to load */
				}
			}
		},
	};
}
