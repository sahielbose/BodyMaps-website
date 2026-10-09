import {
  IconArrowsShuffle,
  IconBookmark,
  IconBookmarkFilled,
  IconDatabase,
} from "@tabler/icons-react";
import type { SavedCase } from "../../../../helpers/savedCases";
import styles from "./LibraryHeader.module.css";

interface Props {
  showSaved: boolean;
  setShowSaved: React.Dispatch<React.SetStateAction<boolean>>;
  savedCases: SavedCase[];
  onBrowseAll: () => void;
  onShuffle: () => void;
}

export default function LibraryHeader({
  showSaved,
  setShowSaved,
  savedCases,
  onBrowseAll,
  onShuffle,
}: Props) {
  return (
    <div className={styles.sectionHeader}>
      <h1 className={styles.title}>Browse the library</h1>
      <div className={styles.actions}>
        <button type="button" className={styles.actionBtn} onClick={onBrowseAll}>
          <IconDatabase size={14} aria-hidden="true" />
          Browse all
        </button>
        <button type="button" className={styles.actionBtn} onClick={onShuffle}>
          <IconArrowsShuffle size={14} aria-hidden="true" />
          Shuffle cases
        </button>
        {/* A toggle: the label is the same in both states (only the count
            changes with the list), so the row never reflows when it flips.
            The open state is the pressed style and a filled bookmark. */}
        <button
          type="button"
          className={`${styles.actionBtn} ${showSaved ? styles.actionBtnActive : ""}`}
          aria-pressed={showSaved}
          onClick={() => setShowSaved((v) => !v)}
        >
          {showSaved ? (
            <IconBookmarkFilled size={14} aria-hidden="true" />
          ) : (
            <IconBookmark size={14} aria-hidden="true" />
          )}
          Saved{savedCases.length ? ` (${savedCases.length})` : ""}
        </button>
      </div>
    </div>
  );
}
