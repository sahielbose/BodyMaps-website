// Serialize/deserialize the viewer's view state to/from URL query params so a link
// reproduces the exact view (orientation, windowing, segmentation opacity, which organs
// are shown, the crosshair focal point, and the HD flag). Pure functions — unit-tested in
// viewerShareState.test.ts. The viewer reads these on load and the "Share" button writes
// them. Defaults are omitted so a plain /case/:id link stays clean.

export type ViewerView = "mpr" | "axial" | "sagittal" | "coronal" | "3d";
const VIEWS: readonly ViewerView[] = ["mpr", "axial", "sagittal", "coronal", "3d"];

export type ViewerShareState = {
	view?: ViewerView;
	ww?: number; // window width (HU)
	wc?: number; // window center (HU)
	opacity?: number; // segmentation opacity, 0–100 (same unit the slider uses)
	hidden?: number[]; // organ segment ids that are toggled off
	crosshair?: [number, number, number]; // focal point in world mm
	hd?: boolean; // full-resolution flag (mirrors the existing ?hd=1)
};

// Every query key encodeViewerState can write, so a caller can clear them before writing fresh ones.
export const VIEWER_STATE_PARAMS = ["view", "ww", "wc", "op", "hide", "c", "hd"] as const;

const round = (n: number, dp = 1) => {
	const f = 10 ** dp;
	return Math.round(n * f) / f;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const numParam = (p: URLSearchParams, key: string): number | null => {
	const raw = p.get(key);
	if (raw == null || raw.trim() === "") return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
};

// Build query params from the current state. Only non-default values are written.
export function encodeViewerState(s: ViewerShareState): URLSearchParams {
	const p = new URLSearchParams();
	if (s.view && s.view !== "mpr") p.set("view", s.view);
	if (typeof s.ww === "number" && Number.isFinite(s.ww)) p.set("ww", String(Math.round(s.ww)));
	if (typeof s.wc === "number" && Number.isFinite(s.wc)) p.set("wc", String(Math.round(s.wc)));
	if (typeof s.opacity === "number" && Number.isFinite(s.opacity)) {
		p.set("op", String(Math.round(clamp(s.opacity, 0, 100))));
	}
	if (s.hidden && s.hidden.length) {
		const ids = [...new Set(s.hidden.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
		if (ids.length) p.set("hide", ids.join(","));
	}
	if (s.crosshair && s.crosshair.length === 3 && s.crosshair.every((n) => Number.isFinite(n))) {
		p.set("c", s.crosshair.map((n) => round(n)).join(","));
	}
	if (s.hd) p.set("hd", "1");
	return p;
}

// Parse query params into a partial state. Unknown/invalid values are dropped so a
// hand-edited or stale link can't crash the viewer.
export function decodeViewerState(p: URLSearchParams): ViewerShareState {
	const out: ViewerShareState = {};

	const view = p.get("view");
	if (view && (VIEWS as readonly string[]).includes(view)) out.view = view as ViewerView;

	const ww = numParam(p, "ww");
	if (ww != null && ww > 0) out.ww = ww;

	const wc = numParam(p, "wc");
	if (wc != null) out.wc = wc;

	const op = numParam(p, "op");
	if (op != null) out.opacity = clamp(op, 0, 100);

	const hide = p.get("hide");
	if (hide) {
		const ids = hide
			.split(",")
			.map((x) => parseInt(x, 10))
			.filter((n) => Number.isInteger(n) && n > 0);
		if (ids.length) out.hidden = [...new Set(ids)].sort((a, b) => a - b);
	}

	const c = p.get("c");
	if (c) {
		const parts = c.split(",").map(Number);
		if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
			out.crosshair = [parts[0], parts[1], parts[2]];
		}
	}

	if (p.get("hd") === "1") out.hd = true;

	return out;
}
