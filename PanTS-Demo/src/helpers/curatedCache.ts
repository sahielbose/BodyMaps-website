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
    fetch(`${API_BASE}/api/search?tumor=${tumor}&sort_by=quality&per_page=${HALF}`)
      .then(okJson)
      .catch(() => null);

  return Promise.all([grab(1), grab(0)]).then(([tumorRes, noTumorRes]) => {
    if (tumorRes == null && noTumorRes == null) {
      // Total failure (both requests errored/non-OK) -- don't poison the cache
      // with an empty result; let the next call retry instead of showing an
      // empty grid for the rest of the session.
      throw new Error("curated fetch failed");
    }
    const items = interleave(tumorRes?.items ?? [], noTumorRes?.items ?? []);
    if (items.length === 0) {
      // Backend reachable but returned no cases (e.g. PANTS_PATH unset, transient
      // empty response). Don't cache; let the next mount retry.
      throw new Error("curated fetch returned no items");
    }
    cachedItems = items;
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
