// Population reference for per-organ volumes, used by the viewer's Organ Statistics
// panel to show where a case sits in the dataset (e.g. "liver = p72 for 60–69 y/o
// males"). The distributions are precomputed on the server by
// `flask-server/scripts/compute_organ_norms.py` and shipped as a static
// `/organ_norms.json` (built into the site). If that file is absent — e.g. on a dev
// checkout without the image data — `loadOrganNorms()` returns null and the panel just
// omits the percentile column. The math here is pure + unit-tested (organNorms.test.ts).

import { ordinal } from "./ordinal";

export type NormBucket = {
	n: number; // sample size behind this bucket
	q: number[]; // organ volume (cm³) at each level in `percentile_grid`, ascending
};

export type OrganNorms = {
	version: number;
	min_n: number; // smallest n we trust; smaller buckets are skipped in favour of a fallback
	percentile_grid: number[]; // e.g. [0,5,10,…,100] — the levels `q` is sampled at
	organs: Record<string, Record<string, NormBucket>>; // organ -> "SEX|AGEBIN" -> bucket
	generated_at?: string;
	case_count?: number;
};

export type PercentileResult = {
	percentile: number; // 0–100
	n: number; // sample size of the bucket used
	basis: string; // the bucket key used, e.g. "M|60-69" or "ALL|ALL"
};

// Decade bin label matching the backend's age_to_bin (and the search facet bins:
// "0-9"…"90-99"). Ages ≥ 90 collapse into "90-99"; missing/invalid → "UNKNOWN".
export function ageToBin(age: number | string | null | undefined): string {
	if (age === null || age === undefined || age === "") return "UNKNOWN";
	const a = typeof age === "number" ? age : Number(age);
	if (!Number.isFinite(a) || a < 0) return "UNKNOWN";
	const lo = Math.min(Math.floor(a / 10) * 10, 90);
	return `${lo}-${lo + 9}`;
}

// "M"/"F" for a known sex, else "ALL" (so unknown sex compares against the whole cohort).
export function normalizeSex(sex: string | null | undefined): "M" | "F" | "ALL" {
	const s = String(sex ?? "").trim().toUpperCase();
	return s === "M" || s === "F" ? s : "ALL";
}

// Interpolate a value's percentile (0–100) from a bucket's quantile breakpoints. `q` are
// the volumes at the levels in `grid` (both ascending, same length). Clamps to the grid
// ends and tolerates flat/tied breakpoints (returns the lower edge on a tie).
export function percentileOf(value: number, grid: number[], q: number[]): number {
	const n = Math.min(grid.length, q.length);
	if (n === 0 || !Number.isFinite(value)) return NaN;
	if (value <= q[0]) return grid[0];
	if (value >= q[n - 1]) return grid[n - 1];
	for (let i = 0; i < n - 1; i++) {
		const lo = q[i];
		const hi = q[i + 1];
		if (value >= lo && value <= hi) {
			if (hi === lo) return grid[i];
			const frac = (value - lo) / (hi - lo);
			return grid[i] + frac * (grid[i + 1] - grid[i]);
		}
	}
	return grid[n - 1];
}

// Pick the most specific trustworthy bucket for an organ + demographics, falling back
// from sex×age → sex → age → whole dataset when a bucket is missing or too small.
export function lookupBucket(
	norms: OrganNorms,
	organ: string,
	sex: string | null | undefined,
	age: number | string | null | undefined,
): { key: string; bucket: NormBucket } | null {
	const byBucket = norms.organs?.[organ];
	if (!byBucket) return null;
	const s = normalizeSex(sex);
	const bin = ageToBin(age);
	const minN = norms.min_n ?? 1;
	const candidates =
		s === "ALL"
			? [`ALL|${bin}`, "ALL|ALL"]
			: [`${s}|${bin}`, `${s}|ALL`, `ALL|${bin}`, "ALL|ALL"];
	for (const key of candidates) {
		const b = byBucket[key];
		if (b && b.n >= minN && b.q?.length) return { key, bucket: b };
	}
	return null;
}

// Full lookup: returns the percentile of `volume` for an organ given the case's sex/age,
// or null when there's no usable reference bucket (so the caller can show "—").
export function percentileForOrgan(
	norms: OrganNorms,
	organ: string,
	sex: string | null | undefined,
	age: number | string | null | undefined,
	volume: number,
): PercentileResult | null {
	if (!Number.isFinite(volume)) return null;
	const hit = lookupBucket(norms, organ, sex, age);
	if (!hit) return null;
	const p = percentileOf(volume, norms.percentile_grid, hit.bucket.q);
	if (!Number.isFinite(p)) return null;
	return { percentile: p, n: hit.bucket.n, basis: hit.key };
}

// Human-readable description of a bucket key for tooltips, e.g. "M|60-69" → "males 60–69".
export function describeBasis(key: string): string {
	const [s, bin] = key.split("|");
	const sexLabel = s === "M" ? "males" : s === "F" ? "females" : "all cases";
	if (bin === "ALL") return s === "ALL" ? "the whole dataset" : sexLabel;
	const range = bin.replace("-", "–");
	return s === "ALL" ? `ages ${range}` : `${sexLabel} ${range}`;
}

// The tooltip on a percentile cell, e.g. "1st percentile vs males 60–69 (n=240)".
export function percentileTitle(percentile: number, basis: string, n: number | null): string {
	return `${ordinal(Math.round(percentile))} percentile vs ${describeBasis(basis)} (n=${n})`;
}

// Fetch + cache the static norms asset. Served by the frontend (not the API), so it's
// origin-relative. Returns null — once, cached — when the file is missing or malformed.
let cache: OrganNorms | null | undefined;
let inflight: Promise<OrganNorms | null> | null = null;

export async function loadOrganNorms(): Promise<OrganNorms | null> {
	if (cache !== undefined) return cache;
	if (inflight) return inflight;
	inflight = (async () => {
		try {
			const res = await fetch("/organ_norms.json", { cache: "force-cache" });
			if (!res.ok) {
				cache = null;
				return null;
			}
			const data = (await res.json()) as OrganNorms;
			cache = data && data.organs && Array.isArray(data.percentile_grid) ? data : null;
			return cache;
		} catch {
			cache = null;
			return null;
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

// Test-only: drop the in-memory cache so each test starts clean.
export function __resetOrganNormsCache(): void {
	cache = undefined;
	inflight = null;
}
