import { useEffect, useId, useRef } from "react";
import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
} from "@tabler/icons-react";
import styles from "./SearchBar.module.css";

interface Props {
  // Whatever is in the field: an empty value (0 or "") means no ID typed.
  searchId: number | string;
  setSearchId: (id: number | string) => void;
  searchError: string | null;
  // Bumps on every rejected Search, even when the message is unchanged.
  rejectCount?: number;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  activeFilterCount: number;
  // id of the filter panel the Advanced filters button opens and closes.
  filterPanelId: string;
  onSearch: () => void;
}

export default function SearchBar({
  searchId,
  setSearchId,
  searchError,
  rejectCount = 0,
  showFilters,
  setShowFilters,
  activeFilterCount,
  filterPanelId,
  onSearch,
}: Props) {
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // A rejected ID puts the cursor back in the field that needs changing, on
  // every rejected Search and not only when the message changes.
  useEffect(() => {
    if (searchError) inputRef.current?.focus();
  }, [searchError, rejectCount]);
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          ref={inputRef}
          type="text"
          aria-label="Search by case ID"
          aria-invalid={searchError ? true : undefined}
          aria-describedby={searchError ? errorId : undefined}
          placeholder="Search by case ID, e.g. 17, 35, 121"
          className={styles.searchInput}
          value={searchId || ""}
          // Keep pasted card labels (PanTS_00000017, CV_00000001); Search checks
          // the format and says what is wrong rather than the field eating it.
          onChange={(e) => setSearchId(e.target.value.replace(/\s/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSearch();
          }}
        />
        <button
          type="button"
          aria-expanded={showFilters}
          aria-controls={showFilters ? filterPanelId : undefined}
          onClick={() => setShowFilters((v) => !v)}
          className={`${styles.filterToggle} ${showFilters ? styles.filterToggleOpen : ""}`}
        >
          <span className="flex items-center gap-2">
            <IconAdjustmentsHorizontal size={15} aria-hidden="true" />
            Advanced filters
            {activeFilterCount > 0 && (
              <span className={styles.filterBadge}>
                {activeFilterCount}
                <span className="sr-only"> selected</span>
              </span>
            )}
          </span>
          <IconChevronDown
            size={15}
            aria-hidden="true"
            className={`${styles.chevron} ${showFilters ? styles.chevronOpen : ""}`}
          />
        </button>
        {/* When an ID is typed, the button navigates to that case and filters are
            not applied; the label makes that explicit. Both labels share one grid
            cell, so the button keeps the width of the longer one and the row does
            not reflow while an ID is typed. */}
        <button type="button" className={styles.searchBtn} onClick={onSearch}>
          <span className={searchId ? styles.labelHidden : undefined} aria-hidden={searchId ? true : undefined}>
            Search
          </span>
          <span className={searchId ? undefined : styles.labelHidden} aria-hidden={searchId ? undefined : true}>
            Go to case
          </span>
        </button>
      </div>
      {/* Mounted even when empty, so a screen reader announces the message
          when it arrives. */}
      <p id={errorId} aria-live="polite" className={searchError ? styles.searchError : "sr-only"}>
        {/* A repeat of the same message gets a trailing non-breaking space on
            alternate rejections, so the live region's text changes and it is read again. */}
        {searchError ? searchError + (rejectCount > 0 && rejectCount % 2 === 0 ? "\u00a0" : "") : searchError}
      </p>
    </div>
  );
}
