import {
  IconAdjustmentsHorizontal,
  IconChevronDown,
} from "@tabler/icons-react";
import styles from "./SearchBar.module.css";

interface Props {
  searchId: number;
  setSearchId: (n: number) => void;
  searchError: string | null;
  showFilters: boolean;
  setShowFilters: React.Dispatch<React.SetStateAction<boolean>>;
  activeFilterCount: number;
  onSearch: () => void;
}

export default function SearchBar({
  searchId,
  setSearchId,
  searchError,
  showFilters,
  setShowFilters,
  activeFilterCount,
  onSearch,
}: Props) {
  return (
    <div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          placeholder="Search by case ID, e.g. 17, 35, 121"
          className={styles.searchInput}
          value={searchId || ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "" || /^\d+$/.test(val)) {
              setSearchId(val ? Number(val) : 0);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSearch();
          }}
        />
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={`${styles.filterToggle} ${showFilters ? styles.filterToggleOpen : ""}`}
        >
          <span className="flex items-center gap-2">
            <IconAdjustmentsHorizontal size={15} />
            Advanced filters
            {activeFilterCount > 0 && (
              <span className={styles.filterBadge}>{activeFilterCount}</span>
            )}
          </span>
          <IconChevronDown
            size={15}
            className={`${styles.chevron} ${showFilters ? styles.chevronOpen : ""}`}
          />
        </button>
        {/* When an ID is typed, the button navigates to that case and filters are
            not applied; the label makes that explicit. */}
        <button className={styles.searchBtn} onClick={onSearch}>
          {searchId ? `Go to case ${searchId}` : "Search"}
        </button>
      </div>
      {searchError && (
        <p aria-live="polite" className="mt-2 text-sm text-red-600">
          {searchError}
        </p>
      )}
    </div>
  );
}
