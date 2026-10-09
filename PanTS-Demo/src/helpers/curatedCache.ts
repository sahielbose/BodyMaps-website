import { API_BASE } from "./constants";
import { itemToId, type SearchItem } from "./search";

// Shared, in-memory (module-scope, survives route unmount/remount) cache for the
// curated Dataset landing grid (tumor / no-tumor, sort_by=quality, interleaved).
//
// Why this exists: /api/search sends no Cache-Control, so the browser HTTP cache
// never reuses the request, and Homepage is a plain top-level route that fully
// unmounts on tab switch — so without this, EVERY Overview/Team -> Dataset switch
// paid a fresh network round trip + a loading-spinner flash, even though the data
// is deterministic and was already fetched moments earlier by the idle warm-up.
// This module is the single source of truth for that fetch; both the App-level
// warm-up and useDashboard's mount effect read/write it, so whichever runs first
// wins and the other gets an instant synchronous hit.
let cachedItems: SearchItem[] | null = null;
let inFlight: Promise<SearchItem[]> | null = null;

const HALF = 4; // mirrors CARD_COUNT / 2 in the dashboard's loadCurated
const CURATED_CANDIDATES = HALF * 2;

const UNKNOWN_DEMOGRAPHIC_VALUES = new Set([
  "",
  "-",
  "--",
  "—",
  "n/a",
  "na",
  "none",
  "null",
  "unknown",
]);

/** False for the placeholder values the metadata uses when a field was not recorded. */
export function hasKnownDemographicValue(value: string | number | null | undefined): boolean {
  if (value == null) return false;
  return !UNKNOWN_DEMOGRAPHIC_VALUES.has(String(value).trim().toLowerCase());
}

/** Return gallery items with complete age and sex information first, preserving ties. */
export function prioritizeKnownDemographics(items: SearchItem[]): SearchItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aKnown = hasKnownDemographicValue(a.item.age) && hasKnownDemographicValue(a.item.sex);
      const bKnown = hasKnownDemographicValue(b.item.age) && hasKnownDemographicValue(b.item.sex);
      return Number(bKnown) - Number(aKnown) || a.index - b.index;
    })
    .map(({ item }) => item);
}

function interleave(tumorItems: SearchItem[], noTumorItems: SearchItem[]): SearchItem[] {
  const out: SearchItem[] = [];
  for (let i = 0; i < Math.max(tumorItems.length, noTumorItems.length); i++) {
    if (tumorItems[i]) out.push(tumorItems[i]);
    if (noTumorItems[i]) out.push(noTumorItems[i]);
  }
  return out;
}

function doFetch(): Promise<SearchItem[]> {
  const okJson = (r: Response) => (r.ok ? r.json() : null);
  const grab = (tumor: 0 | 1) =>
    fetch(`${API_BASE}/api/search?tumor=${tumor}&sort_by=quality&per_page=${CURATED_CANDIDATES}`)
      .then(okJson)
      .catch(() => null);

  return Promise.all([grab(1), grab(0)]).then(([tumorRes, noTumorRes]) => {
    if (tumorRes == null || noTumorRes == null) {
      // Either request errored or came back non-OK. Caching the half that did
      // arrive would pin a lopsided grid (say 4 tumor-only cards) for the whole
      // session, with no error and no Retry. Throw so nothing is cached, the page
      // shows its error card, and the next call retries both.
      throw new Error("curated fetch failed");
    }
    const tumorItems = prioritizeKnownDemographics(tumorRes?.items ?? []).slice(0, HALF);
    const noTumorItems = prioritizeKnownDemographics(noTumorRes?.items ?? []).slice(0, HALF);
    const items = interleave(tumorItems, noTumorItems);
    // Backend reachable but returned no cases (e.g. PANTS_PATH unset, transient
    // empty response). That is an empty dataset, not a failure, so resolve to an
    // empty list the page can say so about, but don't cache it; let the next
    // mount retry.
    if (items.length > 0) cachedItems = items;
    return items;
  });
}

/** Synchronous read — null if nothing has resolved yet. */
export function getCachedCurated(): SearchItem[] | null {
  return cachedItems;
}

/**
 * Kick off (or join) the curated fetch. Safe to call repeatedly — de-duped via
 * `inFlight` so the idle warm-up and an impatient mount effect never double-fetch.
 */
export function fetchCurated(): Promise<SearchItem[]> {
  if (cachedItems) return Promise.resolve(cachedItems);
  if (inFlight) return inFlight;
  inFlight = doFetch().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Warm the cache and preload preview images. Called once shortly after app boot
 * (idle time) so a later Dataset tab visit renders from memory.
 */
let warmStarted = false;
export function warmCuratedCache(): void {
  if (warmStarted || typeof window === "undefined" || typeof fetch === "undefined") {
    return;
  }
  warmStarted = true;
  fetchCurated()
    .then((items) => {
      for (const it of items) {
        const id = itemToId(it);
        if (!id) continue;
        const img = new Image();
        img.src = `${API_BASE}/api/get_image_preview/${id}`;
      }
    })
    .catch(() => {});
}
