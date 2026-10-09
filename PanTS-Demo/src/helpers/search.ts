// Helpers for the dashboard's advanced search against the backend /api/search.
// Extracted from Homepage so the query-building and id-parsing can be unit-tested.

export type TumorFilter = "any" | "tumor" | "no_tumor";

export type SearchFilters = {
	tumor: TumorFilter;
	dataset: string[]; // "PanTS" / "CancerVerse"; empty = both (Any)
	sex: string[]; // M / F / UNKNOWN
	age: string[]; // "0-9" … "90-99" / "UNKNOWN"
	manufacturer: string[]; // scanner manufacturer (from facets)
	ctPhase: string[]; // CT phase, e.g. Arterial (from facets)
	siteNat: string[]; // site nationality, e.g. US (from facets)
	year: string[]; // study year (from facets)
};

export const EMPTY_FILTERS: SearchFilters = {
	tumor: "any",
	dataset: [],
	sex: [],
	age: [],
	manufacturer: [],
	ctPhase: [],
	siteNat: [],
	year: [],
};

// The multi-select array keys (everything except `tumor`).
export type MultiFilterKey = "dataset" | "sex" | "age" | "manufacturer" | "ctPhase" | "siteNat" | "year";

// A case id as used across the UI: a bare number for PanTS (e.g. 8854) or the full
// prefixed string for CancerVerse (e.g. "CV_00000001"). CancerVerse ids MUST keep
// their prefix so they route to the CV endpoints instead of being mistaken for PanTS.
export type CaseId = number | string;

// Minimal shape of an item returned by /api/search and /api/random. The id fields can
// be a PanTS id ("PanTS_00008854") or a CancerVerse id ("CV_00000001").
export type SearchItem = {
	case_id?: string | number;
	"PanTS ID"?: string | number;
	id?: string | number;
	tumor?: number | null;
	sex?: string | null;
	age?: number | string | null;
};

// Resolve a card id from any of the id-ish fields. PanTS → the bare number
// ("PanTS_00008854" → 8854); CancerVerse → the full string kept as-is
// ("CV_00000001") so it hits the CV endpoints. Returns 0 when nothing usable.
export const itemToId = (it: SearchItem): CaseId => {
	const raw = String(it.case_id ?? it["PanTS ID"] ?? it.id ?? "").trim();
	if (!raw) return 0;
	if (raw.toUpperCase().startsWith("CV")) return raw; // keep "CV_00000001" as-is
	const m = raw.match(/\d+/);
	return m ? Number(m[0]) : 0;
};

// Canonical id sent back to backend exclusion filters.
export const caseIdToApiId = (id: CaseId): string =>
	typeof id === "string" && id.toUpperCase().startsWith("CV")
		? id
		: `PanTS_${String(id).padStart(8, "0")}`;

// Build the /api/search (and URL) query string from the active filters. The
// /api/facets request never carries filters: the pill counts stay the unfiltered
// baseline on purpose (see loadFacetOptions in useDashboard). Mirrors the backend
// params accepted by apply_filters: sex[]/age_bin[]/manufacturer[]/ct_phase[]/
// site_nat[]/year[] (multi), tumor (1/0, omitted for "any"), plus optional
// sort_by / per_page.
export const buildSearchParams = (
	filters: SearchFilters,
	opts: { sortBy?: string; perPage?: number } = {}
): URLSearchParams => {
	const params = new URLSearchParams();
	// Dataset dispatch → backend ?dataset=. Empty or both = all (show PanTS + CancerVerse);
	// exactly one selected restricts to that dataset.
	const ds = filters.dataset ?? [];
	const hasPanTS = ds.includes("PanTS");
	const hasCV = ds.includes("CancerVerse");
	if (hasCV && !hasPanTS) params.set("dataset", "cancerverse");
	else if (hasPanTS && !hasCV) params.set("dataset", "pants");
	else params.set("dataset", "all"); // both or neither → everything
	filters.sex.forEach((v) => params.append("sex[]", v));
	if (filters.tumor === "tumor") params.set("tumor", "1");
	else if (filters.tumor === "no_tumor") params.set("tumor", "0");
	filters.age.forEach((v) => params.append("age_bin[]", v));
	(filters.manufacturer ?? []).forEach((v) => params.append("manufacturer[]", v));
	(filters.ctPhase ?? []).forEach((v) => params.append("ct_phase[]", v));
	(filters.siteNat ?? []).forEach((v) => params.append("site_nat[]", v));
	(filters.year ?? []).forEach((v) => params.append("year[]", v));
	if (opts.sortBy) params.set("sort_by", opts.sortBy);
	if (opts.perPage) params.set("per_page", String(opts.perPage));
	return params;
};

// Reconstruct filters from a URL query string — the inverse of buildSearchParams,
// so a shared/bookmarked link restores the same filtered cohort.
export const parseFiltersFromParams = (params: URLSearchParams): SearchFilters => {
	const tumorRaw = params.get("tumor");
	const tumor: TumorFilter = tumorRaw === "1" ? "tumor" : tumorRaw === "0" ? "no_tumor" : "any";
	const datasetRaw = (params.get("dataset") || "").toLowerCase();
	const dataset =
		datasetRaw === "pants" ? ["PanTS"] :
		datasetRaw === "cancerverse" || datasetRaw === "cv" ? ["CancerVerse"] :
		[]; // "all"/absent → both (Any)
	return {
		tumor,
		dataset,
		sex: params.getAll("sex[]"),
		age: params.getAll("age_bin[]"),
		manufacturer: params.getAll("manufacturer[]"),
		ctPhase: params.getAll("ct_phase[]"),
		siteNat: params.getAll("site_nat[]"),
		year: params.getAll("year[]"),
	};
};

export const countActiveFilters = (f: SearchFilters): number =>
	(f.tumor !== "any" ? 1 : 0) +
	// dataset only counts as an active filter when it restricts to a single dataset
	// (empty or both = "Any", i.e. no restriction).
	((f.dataset?.length ?? 0) === 1 ? 1 : 0) +
	f.sex.length +
	f.age.length +
	f.manufacturer.length +
	f.ctPhase.length +
	f.siteNat.length +
	f.year.length;
