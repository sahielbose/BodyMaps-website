import { PER_PAGE } from "../../constants";
import styles from "./Pagination.module.css";

const pagerBtnClass = (disabled: boolean) =>
  `${styles.pagerBtn} ${disabled ? styles.pagerBtnDisabled : ""}`;

interface Props {
  page: number;
  resultCount: number;
  pageInput: string;
  setPageInput: (s: string) => void;
  onGoToPage: (p: number) => void;
}

export default function Pagination({ page, resultCount, pageInput, setPageInput, onGoToPage }: Props) {
  const pages = Math.max(1, Math.ceil(resultCount / PER_PAGE));

  return (
    <nav aria-label="Pagination" className={styles.pager}>
      <button
        type="button"
        className={pagerBtnClass(page <= 1)}
        disabled={page <= 1}
        onClick={() => onGoToPage(page - 1)}
      >
        <span aria-hidden="true">‹</span> Prev
      </button>
      <span className={styles.pagerInfo}>
        Page {page.toLocaleString()} of {pages.toLocaleString()}
      </span>
      <button
        type="button"
        className={pagerBtnClass(page >= pages)}
        disabled={page >= pages}
        onClick={() => onGoToPage(page + 1)}
      >
        Next <span aria-hidden="true">›</span>
      </button>
      <form
        className={styles.pagerGoForm}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          const n = parseInt(pageInput, 10);
          if (!Number.isNaN(n)) {
            onGoToPage(n);
            setPageInput("");
          }
        }}
      >
        <input
          type="number"
          min={1}
          max={pages}
          value={pageInput}
          onChange={(e) => setPageInput(e.target.value)}
          placeholder={`Go to… (1–${pages})`}
          aria-label="Go to page"
          className={styles.pagerInput}
        />
        <button
          type="submit"
          disabled={pageInput.trim() === ""}
          className={pagerBtnClass(pageInput.trim() === "")}
        >
          Go
        </button>
      </form>
    </nav>
  );
}
