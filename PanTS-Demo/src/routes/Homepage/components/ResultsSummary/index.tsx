import { IconX } from "@tabler/icons-react";
import { PER_PAGE } from "../../constants";
import styles from "./ResultsSummary.module.css";

interface Props {
  resultCount: number;
  page: number;
  // Only applied filters can be cleared; after Browse all there are none.
  hasFilters: boolean;
  onReset: () => void;
}

// Shown only when there are results: a search that matches nothing is
// explained once, by the grid's empty state, which carries its own Clear
// filters button.
export default function ResultsSummary({ resultCount, page, hasFilters, onReset }: Props) {
  const pages = Math.max(1, Math.ceil(resultCount / PER_PAGE));
  return (
    <div className={styles.resultsSummary}>
      <span className={styles.resultsText} aria-live="polite">
        {`${resultCount.toLocaleString()} ${
          resultCount === 1 ? "result" : "results"
        } · page ${page.toLocaleString()} of ${pages.toLocaleString()}`}
      </span>
      {hasFilters && (
        <button type="button" onClick={onReset} className={styles.clearBtn}>
          <IconX size={13} aria-hidden="true" />
          Clear filters
        </button>
      )}
    </div>
  );
}
