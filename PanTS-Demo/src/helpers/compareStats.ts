// Align two cases' organ-stat rows into one comparison table (union of organs, in first-
// seen order) with per-organ volume + percentile deltas (B − A). Pure + unit-tested; the
// /compare view renders straight from this. Reuses StatRow from the export helper so the
// single-case panel and the comparison agree on how metrics are derived.
import { roundVolumeCm3, type StatRow } from "./organStatsExport";

export type CompareRow = {
	organ_name: string;
	label: string;
	a: StatRow | null; // null when only the other case has this organ
	b: StatRow | null;
	deltaVolume: number | null; // b − a between the volumes as displayed (one decimal under 10 cm³), null unless both are valid
	deltaPercentile: number | null; // b − a in whole percentile points as displayed
};

// A value as the table prints it: rounded to `digits` places, with -0 folded into 0.
export const roundTo = (v: number, digits = 0): number => Number(v.toFixed(digits)) + 0;

// b − a taken between the two values as printed, so a delta always equals the difference of
// the figures beside it (raw subtraction gives -396 next to 1,204 and 808 cm³, a 397 gap).
export function roundedDelta(a: number | null | undefined, b: number | null | undefined, digits = 0): number | null {
	return a != null && b != null ? roundTo(roundTo(b, digits) - roundTo(a, digits), digits) : null;
}

export function alignStatRows(a: StatRow[], b: StatRow[]): CompareRow[] {
	const byA = new Map(a.map((r) => [r.organ_name, r]));
	const byB = new Map(b.map((r) => [r.organ_name, r]));

	// Union of organ names, preserving first-seen order (A's order, then any B-only organs).
	const organs: string[] = [];
	const seen = new Set<string>();
	for (const r of [...a, ...b]) {
		if (!seen.has(r.organ_name)) {
			seen.add(r.organ_name);
			organs.push(r.organ_name);
		}
	}

	return organs.map((organ) => {
		const ra = byA.get(organ) ?? null;
		const rb = byB.get(organ) ?? null;
		const bothVol = ra?.volume_cm3 != null && rb?.volume_cm3 != null;
		const bothPct = ra?.percentile != null && rb?.percentile != null;
		return {
			organ_name: organ,
			label: ra?.label ?? rb?.label ?? organ,
			a: ra,
			b: rb,
			deltaVolume: bothVol ? roundTo(roundVolumeCm3(rb!.volume_cm3!) - roundVolumeCm3(ra!.volume_cm3!), 1) : null,
			deltaPercentile: bothPct ? roundedDelta(ra!.percentile, rb!.percentile) : null,
		};
	});
}
