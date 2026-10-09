import { useRef } from "react";
import Header from "../../components/Header";
import { useDashboard } from "./hooks/useDashboard";
import LibraryHeader from "./components/LibraryHeader";
import SearchBar from "./components/SearchBar";
import FilterPanel from "./components/FilterPanel";
import ResultsSummary from "./components/ResultsSummary";
import CaseGrid from "./components/CaseGrid";
import Pagination from "./components/Pagination";
import CompareTray from "./components/CompareTray";
import SiteFooter from "../../components/SiteFooter";
import styles from "./Homepage.module.css";
import { PER_PAGE } from "./constants";

export default function Homepage() {
  const dash = useDashboard();
  // The buttons that replace the list (Clear filters, Retry, the tray's Clear)
  // unmount with focus on them; this region outlives the swap, so focus goes here.
  const resultsRef = useRef<HTMLDivElement>(null);
  const focusResults = () => resultsRef.current?.focus({ preventScroll: true });
  const resetFilters = () => {
    dash.handleResetFilters();
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
            showFilters={dash.showFilters}
            setShowFilters={dash.setShowFilters}
            activeFilterCount={dash.activeFilterCount}
            onSearch={dash.handleSearch}
          />

          {dash.showFilters && (
            <FilterPanel
              filters={dash.filters}
              setFilters={dash.setFilters}
              facetData={dash.facetData}
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
          compareIds={dash.compareIds}
          compareTyped={dash.compareTyped}
          setCompareTyped={dash.setCompareTyped}
          onSubmitTyped={dash.submitTypedCompare}
          onClear={clearCompare}
          onCompare={dash.handleCompare}
        />
      )}
      <SiteFooter />
    </div>
  );
}
