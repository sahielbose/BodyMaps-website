// Derive the Organ Statistics rows once (volume + mean HU + population percentile) and
// turn them into a CSV/JSON download or an out-of-range summary. Keeping this in one
// place means the table, the summary banner, and the export all agree. The row math is
// pure + unit-tested (organStatsExport.test.ts); only downloadStats touches the DOM.
import { describeBasis, type OrganNorms, percentileForOrgan } from "./organNorms";
// The prettifying filenameToName ("adrenal_gland_left" -> "Adrenal gland left"), the same
// one the viewers use for organ names; ./utils has an older one that only strips extensions.
import { filenameToName } from "./utils.name";

// Sentinel the backend uses for an organ whose metric is unreliable (mask clipped at the
// volume edge). Mirrors NiftiProcessor.number_max.
export const INVALID_METRIC = 999999;

// Shared so every place that shows a "Kurtosis" label (viewer panel, compare table) explains
// it the same way — it's the one stat here most viewers won't already know how to read.
export const KURTOSIS_TOOLTIP =
	"Kurtosis: higher values mean more extreme outlier voxels.";

// Full shape of one entry in the backend's `organ_metrics` list (NiftiProcessor.calculate_metrics).
// Only organ_name/volume_cm3/mean_hu are guaranteed; everything else is optional/nullable so
// callers (and tests) that only have the basics keep working unchanged.
export type OrganMetric = {
	organ_name: string;
	volume_cm3: number;
	mean_hu: number;
	median?: number | null;
	standard_deviation?: number | null;
	skewness?: number | null;
	kurtosis?: number | null;
	voxel_count?: number | null;
	min_value?: number | null;
	max_value?: number | null;
	truncated?: boolean | null;
};

export type StatRow = {
	organ_name: string;
	label: string; // display name (e.g. "Kidney left")
	volume_cm3: number | null; // null when the backend flagged it invalid
	mean_hu: number | null;
	percentile: number | null; // 0–100, or null when there's no reference
	basis: string | null; // bucket key the percentile came from, e.g. "M|60-69"
	n: number | null; // sample size behind that bucket
	median: number | null;
	standard_deviation: number | null;
	skewness: number | null;
	kurtosis: number | null;
	voxel_count: number | null;
	min_value: number | null;
	max_value: number | null;
	truncated: boolean; // mask hit the volume edge on the first/last slice — metrics may be clipped
};

// An organ the scan holds no voxels of (the server still emits a record for it, with volume 0
// and a null mean HU). It was not measured, so it has no percentile and is never "out of range".
export function isAbsentOrgan(o: { voxel_count?: number | null; volume_cm3: number | null; mean_hu: number | null }): boolean {
	if (o.voxel_count === 0) return true;
	return o.volume_cm3 !== null && o.volume_cm3 <= 0 && (o.mean_hu === null || o.mean_hu === undefined);
}

// Build the display/export rows from the raw metrics + (optional) population norms.
export function computeStatRows(
	stats: OrganMetric[],
	norms: OrganNorms | null,
	sex: string | null,
	age: number | null,
): StatRow[] {
	return stats.map((o) => {
		const badVol = o.volume_cm3 === INVALID_METRIC;
		const badHu = o.mean_hu === INVALID_METRIC;
		// A clipped organ is only partly in the scan, so its volume is not comparable to whole organs;
		// like the backend assistant, give it no percentile (the table already shows its volume as n/a).
		const p = !badVol && !o.truncated && !isAbsentOrgan(o) && norms ? percentileForOrgan(norms, o.organ_name, sex, age, o.volume_cm3) : null;
		return {
			organ_name: o.organ_name,
			label: filenameToName(o.organ_name),
			volume_cm3: badVol ? null : o.volume_cm3,
			mean_hu: badHu ? null : o.mean_hu,
			percentile: p ? p.percentile : null,
			basis: p ? p.basis : null,
			n: p ? p.n : null,
			median: o.median ?? null,
			standard_deviation: o.standard_deviation ?? null,
			skewness: o.skewness ?? null,
			kurtosis: o.kurtosis ?? null,
			voxel_count: o.voxel_count ?? null,
			min_value: o.min_value ?? null,
			max_value: o.max_value ?? null,
			truncated: o.truncated ?? false,
		};
	});
}

// Organs sitting in the distribution tails (< p5 or > p95) — the panel's summary line.
export function summarizeOutOfRange(rows: StatRow[]): { label: string; percentile: number }[] {
	return rows
		.filter((r) => r.percentile !== null && (r.percentile < 5 || r.percentile > 95))
		.map((r) => ({ label: r.label, percentile: r.percentile as number }));
}

// An organ volume as every table and export prints it: one decimal under 10 cm³, so a small
// organ (a lesion, a duct) does not round to 0, and whole cm³ above that. The branch is picked
// after rounding to one decimal, so 9.96 is 10, not 10.0.
export function roundVolumeCm3(v: number): number {
	const r = Math.round(v * 10) / 10;
	return r >= 10 ? Math.round(v) : r;
}

// The same figure with its unit. Only a volume too small for one decimal reads "<0.1".
export function fmtVolumeCm3(v: number): string {
	if (v > 0 && v < 0.05) return "<0.1 cm³";
	const r = roundVolumeCm3(v);
	return r >= 10 ? `${r} cm³` : `${r.toFixed(1)} cm³`;
}

const csvCell = (v: string | number): string => {
	const s = String(v);
	// Quote if the value contains a comma, quote, or newline (RFC 4180).
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// CSV with a header row. Invalid/missing metrics render as "NA"; absent percentiles blank.
export function toCsv(rows: StatRow[]): string {
	const header = [
		"Organ",
		"Volume (cm3)",
		"Mean HU",
		"Median HU",
		"Std Dev HU",
		"Min HU",
		"Max HU",
		"Skewness",
		"Kurtosis",
		"Voxel Count",
		"Truncated",
		"Percentile",
		"Reference group",
		"n",
	];
	const lines = rows.map((r) =>
		[
			csvCell(r.label),
			r.volume_cm3 === null ? "NA" : roundVolumeCm3(r.volume_cm3),
			r.mean_hu === null ? "NA" : Math.round(r.mean_hu),
			r.median === null ? "NA" : Math.round(r.median),
			r.standard_deviation === null ? "NA" : Math.round(r.standard_deviation),
			r.min_value === null ? "NA" : Math.round(r.min_value),
			r.max_value === null ? "NA" : Math.round(r.max_value),
			r.skewness === null ? "NA" : r.skewness.toFixed(2),
			r.kurtosis === null ? "NA" : r.kurtosis.toFixed(2),
			r.voxel_count === null ? "NA" : r.voxel_count,
			r.truncated ? "Yes" : "No",
			r.percentile === null ? "" : Math.round(r.percentile),
			r.basis === null ? "" : csvCell(describeBasis(r.basis)),
			r.n === null ? "" : r.n,
		].join(",")
	);
	return [header.join(","), ...lines].join("\n");
}

// Plain JSON objects for the .json export — rounded, with a readable group label.
export function toJsonRows(rows: StatRow[]): Record<string, unknown>[] {
	return rows.map((r) => ({
		organ: r.label,
		volume_cm3: r.volume_cm3 === null ? null : roundVolumeCm3(r.volume_cm3),
		mean_hu: r.mean_hu === null ? null : Math.round(r.mean_hu),
		median_hu: r.median === null ? null : Math.round(r.median),
		standard_deviation_hu: r.standard_deviation === null ? null : Math.round(r.standard_deviation),
		min_hu: r.min_value === null ? null : Math.round(r.min_value),
		max_hu: r.max_value === null ? null : Math.round(r.max_value),
		skewness: r.skewness === null ? null : Number(r.skewness.toFixed(2)),
		kurtosis: r.kurtosis === null ? null : Number(r.kurtosis.toFixed(2)),
		voxel_count: r.voxel_count,
		truncated: r.truncated,
		percentile: r.percentile === null ? null : Math.round(r.percentile),
		reference_group: r.basis === null ? null : describeBasis(r.basis),
		n: r.n,
	}));
}

// Trigger a browser download of the rows as CSV or JSON. DOM side-effect — not unit-tested.
export function downloadStats(rows: StatRow[], format: "csv" | "json", caseId: string, fileStem?: string): void {
	const content = format === "csv" ? toCsv(rows) : JSON.stringify(toJsonRows(rows), null, 2);
	const mime = format === "csv" ? "text/csv" : "application/json";
	const blob = new Blob([content], { type: `${mime};charset=utf-8` });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileStem ? `organ-stats-${fileStem}.${format}` : `case_${caseId}_organ_stats.${format}`;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}
