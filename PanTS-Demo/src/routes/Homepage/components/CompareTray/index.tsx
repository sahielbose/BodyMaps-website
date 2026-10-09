import { forwardRef, useEffect, useId, useImperativeHandle, useRef } from "react";
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

// The tray is fixed on screen but sits last in the DOM, so the page offers a
// shortcut to it; focus() lands on the Add field, or on Compare once there are
// two ids and the field is gone.
export interface CompareTrayHandle {
  focus: () => void;
}

const CompareTray = forwardRef<CompareTrayHandle, Props>(function CompareTray(
  {
    compareIds,
    compareTyped,
    setCompareTyped,
    compareError,
    onSubmitTyped,
    onClear,
    onCompare,
  },
  handleRef,
) {
  const errorId = useId();
  const trayRef = useRef<HTMLDivElement>(null);
  const compareBtnRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(handleRef, () => ({
    focus: () => (inputRef.current ?? compareBtnRef.current)?.focus(),
  }));
  // Adding the second id unmounts the form with focus in it; Compare is what
  // comes next, so focus goes there instead of dropping to the page body.
  const submittedFromFormRef = useRef(false);
  useEffect(() => {
    const submitted = submittedFromFormRef.current;
    submittedFromFormRef.current = false;
    // Only when focus was actually dropped (an Add that failed leaves the flag
    // set with no render to clear it).
    const dropped = !document.activeElement || document.activeElement === document.body;
    if (submitted && dropped && compareIds.length === 2 && !formRef.current) {
      compareBtnRef.current?.focus();
    }
  });
  // The scroll-to-top button is a separate fixed layer above the tray (z-index
  // 90 over 60), so on a phone, where the tray is a full-width bar, it would
  // cover the Compare button. Publish how high the tray reaches so the button
  // can sit above it (see ScrollToTopButton.module.css).
  useEffect(() => {
    const tray = trayRef.current;
    if (!tray) return;
    const root = document.documentElement;
    const publish = () => {
      const top = tray.getBoundingClientRect().top;
      root.style.setProperty("--compare-tray-lift", `${Math.max(0, Math.round(window.innerHeight - top))}px`);
    };
    publish();
    window.addEventListener("resize", publish);
    // The bar grows and shrinks with the form and the error line.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(tray);
    return () => {
      window.removeEventListener("resize", publish);
      observer?.disconnect();
      root.style.removeProperty("--compare-tray-lift");
    };
  }, []);
  // The message only shows while the form does; past two ids it stays a
  // screen-reader announcement, so the field is not marked invalid then.
  const showError = compareIds.length < 2 && !!compareError;
  return (
    <div className={styles.compareTray} ref={trayRef} role="region" aria-label="Compare cases">
      <span className={styles.compareTrayIds}>
        {compareIds.map((id) => `#${id}`).join("  vs  ")}
      </span>
      {compareIds.length < 2 && (
        <form
          ref={formRef}
          className={styles.compareTrayForm}
          onSubmit={(e) => {
            e.preventDefault();
            submittedFromFormRef.current = true;
            onSubmitTyped();
          }}
        >
          <input
            ref={inputRef}
            value={compareTyped}
            // Only spaces go, as in the search box, so a card label pasted whole
            // ("PanTS_00000017") or a CancerVerse id survives; submit reads it.
            onChange={(e) => setCompareTyped(e.target.value.replace(/\s/g, ""))}
            placeholder="Case ID"
            aria-label="Add a case by ID"
            aria-invalid={showError || undefined}
            aria-describedby={showError ? errorId : undefined}
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
      {/* Mounted even when empty, so a screen reader announces the message
          when it arrives. Follows the form in the DOM so it reads with the
          field; the stylesheet puts it on its own row above the controls. */}
      <p id={errorId} aria-live="polite" className={showError ? styles.compareTrayError : "sr-only"}>
        {compareIds.length < 2 ? compareError : null}
      </p>
      <button
        type="button"
        onClick={onClear}
        aria-label="Clear compare selection"
        className={styles.compareTrayBtn}
      >
        Clear
      </button>
      <button
        type="button"
        ref={compareBtnRef}
        disabled={compareIds.length < 2}
        onClick={onCompare}
        className={styles.compareTrayCompareBtn}
      >
        Compare <span aria-hidden="true">→</span>
      </button>
    </div>
  );
});

export default CompareTray;
