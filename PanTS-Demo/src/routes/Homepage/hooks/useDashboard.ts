import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  buildSearchParams,
  type CaseId,
  caseIdToApiId,
  countActiveFilters,
  EMPTY_FILTERS,
  itemToId,
  type MultiFilterKey,
  parseFiltersFromParams,
  type SearchFilters as Filters,
  type SearchItem,
} from "../../../helpers/search";
import { prefetchViewer } from "../../../helpers/prefetchViewer";
import { fetchCurated, getCachedCurated } from "../../../helpers/curatedCache";
import {
  loadSavedCases,
  SAVED_CASES_EVENT,
  type SavedCase,
  toggleSavedCase,
} from "../../../helpers/savedCases";
import type { PreviewType } from "../../../types";
import { API_BASE } from "../../../helpers/constants";
import { CARD_COUNT, PER_PAGE } from "../constants";
import type { FacetData } from "../types";
import { track } from "../../../helpers/analytics";

// Pure so it can seed both the lazy initial state (skips the first-paint skeleton
// entirely when the curated cache is already warm) and the post-fetch ingest path.
function toPreviewData(items: SearchItem[]) {
  const ids: CaseId[] = [];
  const meta: { [key: string]: PreviewType } = {};
  for (const it of items) {
    const id = itemToId(it);
    if (!id) continue;
    ids.push(id);
    meta[id] = {
      sex: it.sex ?? "",
      age: Number(it.age) || 0,
      tumor: it.tumor === 1 ? 1 : it.tumor === 0 ? 0 : null,
    };
  }
  return { ids, meta };
}

export function useDashboard() {
  const navigation = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => parseFiltersFromParams(searchParams));
  // Only the curated (no-filter) view is cacheable; a filtered/deep-linked URL
  // always does a live fetch, same as before. `filters` was just initialized from
  // the same searchParams, so reuse it instead of re-parsing.
  const initialCached = countActiveFilters(filters) === 0 ? getCachedCurated() : null;
  const initialData = initialCached ? toPreviewData(initialCached) : null;
  const [previewIds, setPreviewIds] = useState<CaseId[]>(initialData?.ids ?? []);
  const [previewMetadata, setPreviewMetadata] = useState<{ [key: string]: PreviewType }>(
    initialData?.meta ?? {},
  );
  const [loading, setLoading] = useState(!initialData);
  const [searchId, setSearchId] = useState<number>(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [facetError, setFacetError] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [facetData, setFacetData] = useState<FacetData | null>(null);
  const [matchTotal, setMatchTotal] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [recentShuffleIds, setRecentShuffleIds] = useState<CaseId[]>([]);

  const [savedCases, setSavedCases] = useState<SavedCase[]>(loadSavedCases);
  const [showSaved, setShowSaved] = useState(false);
  const savedIds = new Set(savedCases.map((c) => c.id));

  // Keep in sync when a bookmark is toggled here or in another tab.
  useEffect(() => {
    const refresh = () => setSavedCases(loadSavedCases());
    window.addEventListener(SAVED_CASES_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SAVED_CASES_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const handleToggleSave = (id: CaseId, meta?: PreviewType) => {
    const m = meta ?? previewMetadata[id];
    toggleSavedCase({ id, sex: m?.sex ?? "", age: m?.age ?? 0, tumor: m?.tumor ?? null });
  };

  // Cases picked for side-by-side comparison (max 2). Adding a third drops the oldest.
  const [compareIds, setCompareIds] = useState<CaseId[]>([]);
  const [compareTyped, setCompareTyped] = useState("");
  const [compareError, setCompareError] = useState<string | null>(null);

  const toggleCompare = (id: CaseId) => {
    setCompareIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id].slice(-2),
    );
  };

  const addCompareId = (id: CaseId) => {
    setCompareIds((prev) => (prev.includes(id) ? prev : [...prev, id].slice(-2)));
  };

  // Clear any stale validation error as soon as the user edits the tray input.
  const handleSetCompareTyped = (s: string) => {
    setCompareError(null);
    setCompareTyped(s);
  };

  const submitTypedCompare = () => {
    // Uppercase so "cv_00000001" matches the canonical CancerVerse id form.
    const raw = compareTyped.trim().toUpperCase();
    if (!raw) return;
    if (raw.startsWith("CV")) {
      // CancerVerse ids keep their prefix so they route to the CV endpoints.
      addCompareId(raw);
    } else {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 1 || n > 9901) {
        setCompareError("Case IDs are 1 to 9901.");
        return;
      }
      addCompareId(n);
    }
    setCompareError(null);
    setCompareTyped("");
  };

  const handleClearCompare = () => setCompareIds([]);

  const ingestItems = (items: SearchItem[]) => {
    const { ids, meta } = toPreviewData(items);
    setPreviewMetadata(meta);
    setPreviewIds(ids);
    setLoading(false);
    return ids;
  };

  // Monotonic sequence shared by every grid fetch (curated / search / shuffle) so
  // a slow, superseded response can never overwrite a newer request's results.
  const requestSeq = useRef(0);
  // The last APPLIED filter set. Pill edits mutate `filters` immediately (they're
  // draft state until Apply/Search), so pagination must not read `filters` directly.
  const appliedFiltersRef = useRef<Filters>(filters);
  // The most recent grid fetch, so an inline error banner can offer Retry.
  const lastFetchRef = useRef<() => void>(() => {});
  const retryLast = () => lastFetchRef.current();

  // Curated cases: fullest-body scans split half tumor / half no-tumor, interleaved.
  // Reads the shared module-scope cache first: if the app-boot idle warm-up (or an
  // earlier mount) already resolved it, this renders synchronously from memory with
  // no spinner and no network round trip -- the fix for Team/Overview -> Dataset
  // tab switches paying a full refetch every time despite the data being static.
  const loadCurated = async () => {
    const reqId = ++requestSeq.current;
    setFetchError(null);
    const cached = getCachedCurated();
    if (cached) {
      ingestItems(cached);
      return;
    }
    lastFetchRef.current = () => void loadCurated();
    setLoading(true);
    setPreviewMetadata({});
    try {
      const items = await fetchCurated();
      if (reqId !== requestSeq.current) return;
      ingestItems(items);
    } catch (e) {
      if (reqId !== requestSeq.current) return;
      console.error(e);
      setFetchError("Could not load cases. Check your connection and try again.");
      setLoading(false);
    }
  };

  const runSearch = async (f: Filters, p = 1) => {
    const reqId = ++requestSeq.current;
    setFetchError(null);
    lastFetchRef.current = () => void runSearch(f, p);
    setLoading(true);
    setPreviewMetadata({});
    try {
      const params = buildSearchParams(f, { sortBy: "quality", perPage: PER_PAGE });
      params.set("page", String(p));
      const res = await fetch(`${API_BASE}/api/search?${params.toString()}`);
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      if (reqId !== requestSeq.current) return;
      const total = data.total ?? 0;
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));
      const serverPage = data.page ?? p;
      setResultCount(total);
      // Clamp against the fresh total so a page past the end can't render
      // summaries like "5 results, page 2 of 1".
      setPage(Math.min(serverPage, pages));
      ingestItems(data.items ?? []);
    } catch (e) {
      if (reqId !== requestSeq.current) return;
      console.error(e);
      setFetchError("Could not load cases. Check your connection and try again.");
      setLoading(false);
    }
  };

  const goToPage = (p: number) => {
    const pages = resultCount ? Math.max(1, Math.ceil(resultCount / PER_PAGE)) : 1;
    const next = Math.min(Math.max(1, p), pages);
    // Paginate with the last-applied filters, never with un-applied pill edits.
    runSearch(appliedFiltersRef.current, next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Facet option lists + baseline counts — fetched once, unfiltered, so available
  // pills and their counts stay stable regardless of which filter is active.
  const loadFacetOptions = async () => {
    try {
      setFacetError(false);
      const params = new URLSearchParams();
      params.set("fields", "tumor,sex,manufacturer,ct_phase,site_nat,year");
      params.set("top_k", "8");
      const res = await fetch(`${API_BASE}/api/facets?${params.toString()}`);
      const data = await res.json();
      setFacetData({
        counts: data.facets ?? {},
        unknown: data.unknown_counts ?? {},
        total: data.total ?? 0,
        datasetCounts: data.dataset_counts ?? {},
      });
    } catch (e) {
      console.error(e);
      setFacetError(true);
    }
  };

  const loadMatchTotal = async (f: Filters) => {
    try {
      const params = buildSearchParams(f, { perPage: 1 });
      const res = await fetch(`${API_BASE}/api/search?${params.toString()}`);
      const data = await res.json();
      setMatchTotal(data.total ?? 0);
    } catch (e) {
      console.error(e);
    }
  };

  // On mount: restore URL filters if present, otherwise show curated grid.
  useEffect(() => {
    const urlFilters = parseFiltersFromParams(searchParams);
    if (countActiveFilters(urlFilters) > 0) {
      setShowFilters(true);
      appliedFiltersRef.current = urlFilters;
      runSearch(urlFilters);
    } else {
      loadCurated();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch static option lists the first time the filter panel opens.
  useEffect(() => {
    if (showFilters && !facetData) loadFacetOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showFilters]);

  // Keep the "cases match" total in sync with the current filters (debounced).
  useEffect(() => {
    const t = setTimeout(() => loadMatchTotal(filters), 200);
    return () => clearTimeout(t);
  }, [filters]);

  // Warm the code-split viewer chunk while idle so the first case-open is instant.
  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const ric = w.requestIdleCallback;
    const id = ric ? ric(() => prefetchViewer()) : window.setTimeout(prefetchViewer, 1500);
    return () => {
      if (ric) w.cancelIdleCallback?.(id as number);
      else window.clearTimeout(id as number);
    };
  }, []);

  const handleShuffle = async () => {
    const reqId = ++requestSeq.current;
    setShowSaved(false);
    setFetchError(null);
    lastFetchRef.current = () => void handleShuffle();
    setLoading(true);
    setPreviewMetadata({});
    setResultCount(null);
    setPage(1);
    setFilters(EMPTY_FILTERS);
    appliedFiltersRef.current = EMPTY_FILTERS;
    setSearchParams({}, { replace: true });
    try {
      const params = new URLSearchParams({
        n: String(CARD_COUNT),
        k: "120",
        scope: "all",
      });
      if (recentShuffleIds.length) {
        params.set("recent", recentShuffleIds.map(caseIdToApiId).join(","));
      }
      const res = await fetch(`${API_BASE}/api/random?${params.toString()}`);
      if (!res.ok) throw new Error(`Shuffle failed (${res.status})`);
      const data = await res.json();
      if (reqId !== requestSeq.current) return;
      const ids = ingestItems(data.items ?? []);
      setRecentShuffleIds((previous) => {
        const deduped: CaseId[] = [];
        for (const id of [...previous, ...ids]) {
          const existing = deduped.findIndex((candidate) => candidate === id);
          if (existing >= 0) deduped.splice(existing, 1);
          deduped.push(id);
        }
        return deduped.slice(-32);
      });
    } catch (e) {
      if (reqId !== requestSeq.current) return;
      console.error(e);
      setFetchError("Could not load cases. Check your connection and try again.");
      setLoading(false);
    }
  };

  const handleBrowseAll = () => {
    setShowSaved(false);
    setFilters(EMPTY_FILTERS);
    appliedFiltersRef.current = EMPTY_FILTERS;
    setSearchParams({}, { replace: true });
    runSearch(EMPTY_FILTERS, 1);
  };

  const activeFilterCount = countActiveFilters(filters);

  const toggleMulti = (key: MultiFilterKey, value: string) => {
    setFilters((f) => {
      const has = f[key].includes(value);
      return { ...f, [key]: has ? f[key].filter((v) => v !== value) : [...f[key], value] };
    });
  };

  const handleApplyFilters = () => {
    setShowSaved(false);
    appliedFiltersRef.current = filters;
    setSearchParams(buildSearchParams(filters), { replace: true });
    runSearch(filters, 1);
    setShowFilters(false);
  };

  const handleResetFilters = () => {
    setFilters(EMPTY_FILTERS);
    appliedFiltersRef.current = EMPTY_FILTERS;
    setResultCount(null);
    setPage(1);
    setSearchParams({}, { replace: true });
    loadCurated();
  };

  const handleSetSearchId = (n: number) => {
    setSearchError(null);
    setSearchId(n);
  };

  const handleSearch = () => {
    track("dataset_search");
    if (searchId) {
      if (searchId < 1 || searchId > 9901) {
        setSearchError("Case IDs are 1 to 9901.");
        return;
      }
      setSearchError(null);
      navigation("/case/" + searchId);
      return;
    }
    handleApplyFilters();
  };

  const handleCompare = () => {
    track("dataset_open_compare");
    navigation(`/compare?a=${compareIds[0]}&b=${compareIds[1]}`);
  };

  return {
    previewIds,
    previewMetadata,
    loading,
    searchId,
    setSearchId: handleSetSearchId,
    searchError,
    fetchError,
    facetError,
    retryLast,
    retryFacets: loadFacetOptions,
    showFilters,
    setShowFilters,
    filters,
    setFilters,
    facetData,
    matchTotal,
    activeFilterCount,
    page,
    pageInput,
    setPageInput,
    resultCount,
    savedCases,
    showSaved,
    setShowSaved,
    savedIds,
    compareIds,
    compareTyped,
    setCompareTyped: handleSetCompareTyped,
    compareError,
    handleToggleSave,
    toggleCompare,
    submitTypedCompare,
    handleClearCompare,
    handleShuffle,
    handleBrowseAll,
    handleResetFilters,
    handleSearch,
    handleCompare,
    goToPage,
    toggleMulti,
  };
}
