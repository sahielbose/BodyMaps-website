import { useEffect, useRef, useState } from "react";
import Preview, { PreviewSkeleton } from "../../../../components/Preview";
import type { CaseId } from "../../../../helpers/search";
import type { SavedCase } from "../../../../helpers/savedCases";
import type { PreviewType } from "../../../../types";
import styles from "./CaseGrid.module.css";

interface Props {
  showSaved: boolean;
  savedCases: SavedCase[];
  loading: boolean;
  // How many cards the pending request will bring, so the skeleton grid has
  // the height of the grid that replaces it.
  skeletonCount: number;
  resultCount: number | null;
  // Whether the current results come from applied filters (not Browse all).
  hasFilters: boolean;
  onResetFilters: () => void;
  previewIds: CaseId[];
  previewMetadata: { [key: string]: PreviewType };
  savedIds: Set<CaseId>;
  compareIds: CaseId[];
  onToggleSave: (id: CaseId, meta?: PreviewType) => void;
  onToggleCompare: (id: CaseId) => void;
}

export default function CaseGrid({
  showSaved,
  savedCases,
  loading,
  skeletonCount,
  resultCount,
  hasFilters,
  onResetFilters,
  previewIds,
  previewMetadata,
  savedIds,
  compareIds,
  onToggleSave,
  onToggleCompare,
}: Props) {
  // Synchronized reveal: hold every card of a fresh batch hidden (spinner) until
  // they've all settled — loaded or errored — then reveal them together, so the
  // grid never pops in card-by-card at the speed of the fastest thumbnail.
  const gridIds = !showSaved && !loading ? previewIds : [];
  const idsKey = gridIds.join(",");
  const batchSize = gridIds.length;
  // Released batches are tracked by key instead of being reset in an effect.
  // Cached thumbnails can fire onLoad before the grid's effects run, and an
  // effect that cleared the count then dropped those loads and left the whole
  // batch on spinners until the safety cap.
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const settledRef = useRef<{ key: string; ids: Set<string> }>({ key: "", ids: new Set() });

  useEffect(() => {
    if (batchSize === 0) return;
    // Safety cap: never let one slow/stuck thumbnail hold the whole grid hostage.
    // Kept short since thumbnails are small, eager-loaded, and immutably cached.
    const t = setTimeout(() => setRevealedKey(idsKey), 2500);
    return () => clearTimeout(t);
  }, [idsKey, batchSize]);

  const handleSettled = (id: CaseId) => {
    if (settledRef.current.key !== idsKey) {
      settledRef.current = { key: idsKey, ids: new Set() };
    }
    settledRef.current.ids.add(String(id));
    if (settledRef.current.ids.size >= batchSize) setRevealedKey(idsKey);
  };
  const revealAll = batchSize === 0 || revealedKey === idsKey;

  // Removing a card in the Saved view takes the focused Save button with it.
  // The neighbour to hand focus to is chosen when the button is pressed and
  // focused once the list has re-rendered without the removed card.
  const gridRef = useRef<HTMLDivElement>(null);
  const emptySavedRef = useRef<HTMLDivElement>(null);
  const focusAfterRemoveRef = useRef<{ next: CaseId | null } | null>(null);
  const handleRemoveSaved = (index: number, meta: PreviewType) => {
    const c = savedCases[index];
    const focused = document.activeElement;
    if (focused && gridRef.current?.contains(focused)) {
      const neighbour = savedCases[index + 1] ?? savedCases[index - 1];
      focusAfterRemoveRef.current = { next: neighbour ? neighbour.id : null };
    }
    onToggleSave(c.id, meta);
  };
  useEffect(() => {
    const pending = focusAfterRemoveRef.current;
    if (!pending) return;
    focusAfterRemoveRef.current = null;
    if (pending.next === null) {
      emptySavedRef.current?.focus();
      return;
    }
    gridRef.current
      ?.querySelector<HTMLElement>(`button[aria-label="Save case ${pending.next}"]`)
      ?.focus();
  }, [savedCases]);

  if (showSaved && savedCases.length === 0) {
    return (
      <div className={styles.emptyState} ref={emptySavedRef} tabIndex={-1}>
        No saved cases yet. Click the bookmark on any case to save it here.
      </div>
    );
  }

  if (!showSaved && !loading && previewIds.length === 0) {
    // Filters that match nothing get a way out. With no filters applied an
    // empty answer means the dataset itself has no cases to show (the API
    // answered, so this is not a connection problem).
    return hasFilters && resultCount === 0 ? (
      <div className={styles.emptyState}>
        <p className={styles.emptyText}>No cases match these filters.</p>
        <button type="button" className={styles.emptyAction} onClick={onResetFilters}>
          Clear filters
        </button>
      </div>
    ) : (
      <div className={styles.emptyState}>
        <p className={styles.emptyText}>No cases are available right now.</p>
      </div>
    );
  }

  // Two columns, then four from tablet width up: the fixed batch sizes (8
  // featured cases, 16 per page) fill every row, where the old three-column
  // step laid 8 cards out 3 + 3 + 2.
  return (
    <div ref={gridRef} className="grid gap-4 grid-cols-2 md:grid-cols-4" aria-busy={!showSaved && loading}>
      {showSaved
        ? savedCases.map((c, i) => (
            <Preview
              key={c.id}
              id={c.id}
              previewMetadata={{ sex: c.sex, age: c.age, tumor: c.tumor }}
              saved
              onToggleSave={() =>
                handleRemoveSaved(i, { sex: c.sex, age: c.age, tumor: c.tumor })
              }
              compareSelected={compareIds.includes(c.id)}
              onToggleCompare={() => onToggleCompare(c.id)}
            />
          ))
        : loading
          ? Array.from({ length: skeletonCount }).map((_, i) => <PreviewSkeleton key={i} />)
          : previewIds.map((id) => (
              // Keyed by the batch too: a card that survives into the next batch
              // (the cached curated list is often also page 1 of Browse all) would
              // keep its settled state, never report again, and leave the new
              // batch short of its count until the safety cap.
              <Preview
                key={`${idsKey}:${id}`}
                id={id}
                previewMetadata={previewMetadata[id]}
                saved={savedIds.has(id)}
                onToggleSave={() => onToggleSave(id)}
                compareSelected={compareIds.includes(id)}
                onToggleCompare={() => onToggleCompare(id)}
                reveal={revealAll}
                onSettled={() => handleSettled(id)}
              />
            ))}
    </div>
  );
}
