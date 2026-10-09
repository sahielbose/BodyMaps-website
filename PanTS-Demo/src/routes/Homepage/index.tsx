import { useRef } from "react";
import Header from "../../components/Header";
import { useDashboard } from "./hooks/useDashboard";
import LibraryHeader from "./components/LibraryHeader";
import SearchBar from "./components/SearchBar";
import FilterPanel from "./components/FilterPanel";
import ResultsSummary from "./components/ResultsSummary";
import CaseGrid from "./components/CaseGrid";
import Pagination from "./components/Pagination";
import CompareTray, { type CompareTrayHandle } from "./components/CompareTray";
import SiteFooter from "../../components/SiteFooter";
import styles from "./Homepage.module.css";
import { FILTER_PANEL_ID, PER_PAGE } from "./constants";
import { scrollBehavior } from "../../helpers/motion";

export default function Homepage() {
  const dash = useDashboard();
  // The buttons that replace the list (Clear filters, Retry, the tray's Clear)
  // unmount with focus on them; this region outlives the swap, so focus goes here.
  const resultsRef = useRef<HTMLDivElement>(null);
  const trayRef = useRef<CompareTrayHandle>(null);
  const focusResults = () => resultsRef.current?.focus({ preventScroll: true });
  const resetFilters = () => {
    dash.handleResetFilters();
    focusResults();
  };
  // Apply closes the panel, which shortens the page under the scroll position
  // (the panel is several screens tall on a phone), so bring the top back like
  // goToPage does; focus then goes to the results it just changed.
  const applyFilters = () => {
    dash.handleApplyFilters();
    window.scrollTo({ top: 0, behavior: scrollBehavior() });
    focusResults();
  };
  const retry = () => {
    dash.retryLast();
    focusResults();
  };
  // Paging swaps the cards and scrolls to the top, so focus follows it rather
  // than staying on the pager at the bottom.
  const goToPage = (p: number) => {
    dash.goToPage(p);
    focusResults();
  };
  const clearCompare = () => {
    dash.handleClearCompare();
    focusResults();
  };

  // Always mounted, so the first pick is announced too (the tray itself only
  // exists once something is picked).
  const compareStatus =
    dash.compareIds.length === 0
      ? ""
      : dash.compareIds.length === 1
        ? "1 of 2 cases selected"
        : "2 cases selected, Compare is ready";

  // overflow-x-clip, not hidden: hidden makes this wrapper a scroll container
  // and stops the sticky header from sticking.
  return (
    <div
      className={`min-h-screen bg-white text-black relative overflow-x-clip flex flex-col ${
        dash.compareIds.length > 0 ? styles.pageTrayOpen : ""
      }`}
    >
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className={styles.orb1} />
        <div className={styles.orb2} />
        <div className={styles.orb3} />
      </div>

      <Header />

      <main
        className={`mx-auto w-full max-w-6xl flex-1 ${styles.main} ${
          dash.compareIds.length > 0 ? styles.mainTrayOpen : ""
        }`}
      >
        <div className={styles.libraryCard}>
          <LibraryHeader
            showSaved={dash.showSaved}
            setShowSaved={dash.setShowSaved}
            savedCases={dash.savedCases}
            onBrowseAll={dash.handleBrowseAll}
            onShuffle={dash.handleShuffle}
          />

          <SearchBar
            searchId={dash.searchId}
            setSearchId={dash.setSearchId}
            searchError={dash.searchError}
            rejectCount={dash.searchRejectCount}
            showFilters={dash.showFilters}
            setShowFilters={dash.setShowFilters}
            activeFilterCount={dash.activeFilterCount}
            filterPanelId={FILTER_PANEL_ID}
            onSearch={dash.handleSearch}
          />

          {dash.showFilters && (
            <FilterPanel
              id={FILTER_PANEL_ID}
              filters={dash.filters}
              setFilters={dash.setFilters}
              facetData={dash.facetData}
              facetError={dash.facetError}
              onRetryFacets={dash.retryFacets}
              onApply={applyFilters}
              toggleMulti={dash.toggleMulti}
            />
          )}

        </div>

        {!dash.showSaved && dash.resultCount !== null && dash.resultCount > 0 && (
          <ResultsSummary
            resultCount={dash.resultCount}
            page={dash.page}
            hasFilters={dash.appliedFilterCount > 0}
            onReset={resetFilters}
          />
        )}

        <div ref={resultsRef} tabIndex={-1} role="region" aria-label="Cases" className={styles.results}>
          {dash.compareIds.length > 0 && (
            <button
              type="button"
              onClick={() => trayRef.current?.focus()}
              className={styles.trayShortcut}
            >
              Go to compare bar
            </button>
          )}
          {!dash.showSaved && !dash.loading && dash.fetchError ? (
            <div className={styles.fetchError} role="alert">
              <p className={styles.fetchErrorText}>{dash.fetchError}</p>
              <button type="button" onClick={retry} className={styles.retryBtn}>
                Retry
              </button>
            </div>
          ) : (
            <CaseGrid
              showSaved={dash.showSaved}
              savedCases={dash.savedCases}
              loading={dash.loading}
              skeletonCount={dash.skeletonCount}
              resultCount={dash.resultCount}
              hasFilters={dash.appliedFilterCount > 0}
              onResetFilters={resetFilters}
              previewIds={dash.previewIds}
              previewMetadata={dash.previewMetadata}
              savedIds={dash.savedIds}
              compareIds={dash.compareIds}
              onToggleSave={dash.handleToggleSave}
              onToggleCompare={dash.toggleCompare}
            />
          )}
        </div>

        {!dash.showSaved && dash.resultCount !== null && dash.resultCount > PER_PAGE && (
          <Pagination
            page={dash.page}
            resultCount={dash.resultCount}
            pageInput={dash.pageInput}
            setPageInput={dash.setPageInput}
            onGoToPage={goToPage}
          />
        )}
      </main>

      {dash.compareIds.length > 0 && (
        <CompareTray
          ref={trayRef}
          compareIds={dash.compareIds}
          compareTyped={dash.compareTyped}
          setCompareTyped={dash.setCompareTyped}
          compareError={dash.compareError}
          onSubmitTyped={dash.submitTypedCompare}
          onClear={clearCompare}
          onCompare={dash.handleCompare}
        />
      )}
      <p role="status" className="sr-only">
        {compareStatus}
      </p>
      <SiteFooter />
    </div>
  );
}
