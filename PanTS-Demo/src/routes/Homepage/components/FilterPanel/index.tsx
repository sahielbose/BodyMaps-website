import { useId, useRef, type ReactNode } from "react";
import {
  countActiveFilters,
  EMPTY_FILTERS,
  type SearchFilters as Filters,
  type MultiFilterKey,
} from "../../../../helpers/search";
import type { FacetData } from "../../types";
import {
  TUMOR_OPTIONS,
  DATASET_OPTIONS,
  SEX_OPTIONS,
  AGE_OPTIONS,
  FACET_GROUPS,
} from "../../constants";
import styles from "./FilterPanel.module.css";

// An option toggle. aria-pressed carries the chosen state that the blue
// border and text show, so it is not conveyed by colour alone.
function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={`${styles.pill} ${active ? styles.pillActive : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// A titled row of pills, exposed as a group named by its title.
function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} className="flex flex-col gap-2.5">
      <span id={titleId} className={styles.filterLabel}>{title}</span>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function CountBadge({ count }: { count: number | null }) {
  if (count == null) return null;
  // The visible badge is hidden from assistive tech and spoken in words
  // instead, so the pill's name does not run label and count together
  // ("2015" + "4,200" would read as "20154,200").
  return (
    <>
      <span className={styles.countBadge} aria-hidden="true">
        {count.toLocaleString()}
      </span>
      <span className="sr-only">
        {` (${count.toLocaleString()} ${count === 1 ? "case" : "cases"})`}
      </span>
    </>
  );
}

interface Props {
  id: string;
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  facetData: FacetData | null;
  facetError: boolean;
  onRetryFacets: () => void;
  // Pill picks are staged: this runs the search with them, so a long panel
  // does not send people back up to the Search button.
  onApply: () => void;
  toggleMulti: (key: MultiFilterKey, value: string) => void;
}

export default function FilterPanel({
  id,
  filters,
  setFilters,
  facetData,
  facetError,
  onRetryFacets,
  onApply,
  toggleMulti,
}: Props) {
  const applyRef = useRef<HTMLButtonElement>(null);
  // Both dataset pills picked reads as "Any" to the search, so countActiveFilters
  // skips it, but the panel is still off its default and needs a way back.
  const hasSelection = countActiveFilters(filters) > 0 || filters.dataset.length > 0;

  const facetCount = (field: string, value: string | number): number | null => {
    const rows = facetData?.counts[field];
    if (!rows) return null;
    const row = rows.find((r) => String(r.value) === String(value));
    return row ? row.count : 0;
  };

  return (
    <div id={id} className={styles.filterPanel}>
      {facetError && !facetData && (
        <p role="alert" className={styles.facetsError}>
          Couldn't load options.
          <button type="button" onClick={onRetryFacets} className={styles.retryBtn}>
            Retry
          </button>
        </p>
      )}
      <FilterGroup title="Dataset">
        <Pill
          active={filters.dataset.length === 0}
          onClick={() => setFilters((f) => ({ ...f, dataset: [] }))}
        >
          Any
        </Pill>
        {DATASET_OPTIONS.map((opt) => (
          <Pill
            key={opt.value}
            active={filters.dataset.includes(opt.value)}
            onClick={() => toggleMulti("dataset", opt.value)}
          >
            {opt.label}
            <CountBadge count={facetData?.datasetCounts[opt.value] ?? null} />
          </Pill>
        ))}
      </FilterGroup>

      <FilterGroup title="Tumor">
        {TUMOR_OPTIONS.map((opt) => (
          <Pill
            key={opt.value}
            active={filters.tumor === opt.value}
            onClick={() => setFilters((f) => ({ ...f, tumor: opt.value }))}
          >
            {opt.label}
            <CountBadge
              count={
                opt.value === "tumor"
                  ? facetCount("tumor", 1)
                  : opt.value === "no_tumor"
                    ? facetCount("tumor", 0)
                    : null
              }
            />
          </Pill>
        ))}
      </FilterGroup>

      <FilterGroup title="Sex">
        <Pill
          active={filters.sex.length === 0}
          onClick={() => setFilters((f) => ({ ...f, sex: [] }))}
        >
          Any
        </Pill>
        {SEX_OPTIONS.map((opt) => (
          <Pill
            key={opt.value}
            active={filters.sex.includes(opt.value)}
            onClick={() => toggleMulti("sex", opt.value)}
          >
            {opt.label}
            <CountBadge
              count={
                opt.value === "UNKNOWN"
                  ? (facetData?.unknown.sex ?? null)
                  : facetCount("sex", opt.value)
              }
            />
          </Pill>
        ))}
      </FilterGroup>

      <FilterGroup title="Age">
        <Pill
          active={filters.age.length === 0}
          onClick={() => setFilters((f) => ({ ...f, age: [] }))}
        >
          Any
        </Pill>
        {AGE_OPTIONS.map((opt) => (
          <Pill
            key={opt.value}
            active={filters.age.includes(opt.value)}
            onClick={() => toggleMulti("age", opt.value)}
          >
            {opt.label}
          </Pill>
        ))}
      </FilterGroup>

      {/* Metadata facets: manufacturer / CT phase / site / year */}
      {FACET_GROUPS.map((g) => {
        const rows = facetData?.counts[g.field] ?? [];
        const selected = filters[g.key];
        return (
          <FilterGroup key={g.key} title={g.title}>
            <Pill
              active={selected.length === 0}
              onClick={() => setFilters((f) => ({ ...f, [g.key]: [] }))}
            >
              Any
            </Pill>
            {rows.length === 0 ? (
              facetError && !facetData ? null : (
                <span className={styles.facetsLoading}>
                  {facetData ? "None recorded" : "Loading…"}
                </span>
              )
            ) : (
              rows.map((r) => {
                const val = String(r.value);
                return (
                  <Pill
                    key={val}
                    active={selected.includes(val)}
                    onClick={() => toggleMulti(g.key, val)}
                  >
                    {r.label ?? val}
                    <CountBadge count={r.count} />
                  </Pill>
                );
              })
            )}
          </FilterGroup>
        );
      })}

      <div className={styles.actions}>
        <button type="button" ref={applyRef} onClick={onApply} className={styles.applyBtn}>
          Apply filters
        </button>
        {hasSelection && (
          <button
            type="button"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              // The button unmounts once nothing is selected, so keep focus in the panel.
              applyRef.current?.focus();
            }}
            className={styles.clearSelectionBtn}
          >
            Clear selection
          </button>
        )}
      </div>
    </div>
  );
}
