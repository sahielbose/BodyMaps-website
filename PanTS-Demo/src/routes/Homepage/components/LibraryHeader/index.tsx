import {
  IconArrowsShuffle,
  IconBookmark,
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
      <span>Browse the library</span>
      <div className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2">
        <button className={styles.actionBtn} onClick={onBrowseAll}>
          <IconDatabase size={14} />
          Browse all
        </button>
        <button className={styles.actionBtn} onClick={onShuffle}>
          <IconArrowsShuffle size={14} />
          Shuffle cases
        </button>
        <button
          className={`${styles.actionBtn} ${showSaved ? styles.actionBtnActive : ""}`}
          onClick={() => setShowSaved((v) => !v)}
        >
          <IconBookmark size={14} />
          {showSaved
            ? "Back to browse"
            : `Saved${savedCases.length ? ` (${savedCases.length})` : ""}`}
        </button>
      </div>
    </div>
  );
}
