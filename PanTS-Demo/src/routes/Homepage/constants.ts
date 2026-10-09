import type { TumorFilter, MultiFilterKey } from "../../helpers/search";

export const FACET_GROUPS: { key: MultiFilterKey; field: string; title: string }[] = [
  { key: "manufacturer", field: "manufacturer", title: "Manufacturer" },
  { key: "ctPhase", field: "ct_phase", title: "CT phase" },
  { key: "siteNat", field: "site_nat", title: "Site" },
  { key: "year", field: "year", title: "Study year" },
];

// id of the Advanced filters panel, for the toggle's aria-controls.
export const FILTER_PANEL_ID = "dataset-filters";

// Number of cards in the curated landing strip (and skeleton placeholders).
export const CARD_COUNT = 8;
// 4 columns × 4 rows = 16 cards per page.
export const PER_PAGE = 16;

export const TUMOR_OPTIONS: { value: TumorFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "tumor", label: "Tumor" },
  { value: "no_tumor", label: "No tumor" },
];

// CancerVerse is CT-only (no masks yet), so those cases sort after PanTS cases.
export const DATASET_OPTIONS = [
  { value: "PanTS", label: "PanTS" },
  { value: "CancerVerse", label: "CancerVerse" },
];

// Values match the backend /api/search params.
export const SEX_OPTIONS = [
  { value: "M", label: "Male" },
  { value: "F", label: "Female" },
  { value: "UNKNOWN", label: "Unknown" },
];

export const AGE_OPTIONS = [
  { value: "0-9", label: "0-9" },
  { value: "10-19", label: "10-19" },
  { value: "20-29", label: "20-29" },
  { value: "30-39", label: "30-39" },
  { value: "40-49", label: "40-49" },
  { value: "50-59", label: "50-59" },
  { value: "60-69", label: "60-69" },
  { value: "70-79", label: "70-79" },
  { value: "80-89", label: "80-89" },
  { value: "90-99", label: "90-99" },
  { value: "UNKNOWN", label: "Unknown" },
];
