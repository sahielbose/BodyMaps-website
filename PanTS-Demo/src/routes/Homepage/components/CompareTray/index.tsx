import type { CaseId } from "../../../../helpers/search";
import styles from "./CompareTray.module.css";

interface Props {
  compareIds: CaseId[];
  compareTyped: string;
  setCompareTyped: (s: string) => void;
  compareError: string | null;
  onSubmitTyped: () => void;
  onClear: () => void;
  onCompare: () => void;
}

export default function CompareTray({
  compareIds,
  compareTyped,
  setCompareTyped,
  compareError,
  onSubmitTyped,
  onClear,
  onCompare,
}: Props) {
  return (
    <div className={styles.compareTray}>
      <span className={styles.compareTrayIds}>
        {compareIds.map((id) => `#${id}`).join("  vs  ")}
      </span>
      {compareIds.length < 2 && (
        <form
          className={styles.compareTrayForm}
          onSubmit={(e) => {
            e.preventDefault();
            onSubmitTyped();
          }}
        >
          <input
            value={compareTyped}
            // Digits for PanTS ids plus C/V/_ so CancerVerse ids ("CV_00000001")
            // can be typed; uppercased on submit.
            onChange={(e) => setCompareTyped(e.target.value.replace(/[^0-9CVcv_]/g, ""))}
            placeholder="type case #"
            aria-label="Add a case by ID"
            className={styles.compareTrayInput}
          />
          <button
            type="submit"
            disabled={compareTyped.trim() === ""}
            className={styles.compareTrayAddBtn}
          >
            Add
          </button>
        </form>
      )}
      <button onClick={onClear} className={styles.compareTrayBtn}>
        Clear
      </button>
      <button
        disabled={compareIds.length < 2}
        onClick={onCompare}
        className={styles.compareTrayCompareBtn}
      >
        Compare →
      </button>
      {compareIds.length < 2 && compareError && (
        <p aria-live="polite" className={styles.compareTrayError}>
          {compareError}
        </p>
      )}
    </div>
  );
}
