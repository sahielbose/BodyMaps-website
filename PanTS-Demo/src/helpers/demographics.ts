// One wording for a case's sex and tumor status wherever a card shows them
// (Dataset cards, Compare cards, the viewer's case metadata), so the same value
// is not "M" on one page and "Male" on the next. The server sends sex as "M" or "F".

/** "Male" or "Female", or null when the record has no sex (or one this does not name). */
export function formatSex(sex: string | null | undefined): string | null {
  const s = (sex ?? "").trim().toUpperCase();
  if (s === "M") return "Male";
  if (s === "F") return "Female";
  return null;
}

export function formatTumor(tumor: number | null | undefined): string {
  return tumor === 1 ? "Tumor" : tumor === 0 ? "No tumor" : "Tumor status unknown";
}

/** A row value in the viewer's case metadata panel. */
export function formatCaseMetaValue(key: string, v: unknown): string {
  if (key === "tumor") {
    if (v === 1 || v === true) return "Yes";
    if (v === 0 || v === false) return "No";
    return "Unknown";
  }
  if (v === null || v === undefined || v === "") return "Unknown";
  if (key === "sex" && typeof v === "string") {
    const named = formatSex(v);
    if (named) return named;
  }
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(1);
  return String(v);
}
