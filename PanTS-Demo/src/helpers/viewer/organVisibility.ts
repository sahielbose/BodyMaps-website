/** What a pane's labelmap representation records about its organs: its own visibility and one
 *  entry per segment index it knows about. */
export type OrganRepresentation = {
  visible?: boolean;
  segments?: Record<number, { visible?: boolean } | undefined>;
};

export type OrganVisibilityApi = {
  representation: (viewportId: string) => OrganRepresentation | undefined;
  /** Cornerstone's setActiveSegmentIndex, which also adds a missing segment entry to every
   *  pane's representation (setSegmentIndexVisibility ignores a segment without one). */
  setActiveSegmentIndex: (segmentIndex: number) => void;
  setSegmentIndexVisibility: (viewportId: string, segmentIndex: number, visible: boolean) => void;
  /** Queues one segmentation render for every pane that holds the mask. */
  requestRender: () => void;
};

// Whether setSegmentIndexVisibility would change anything on this pane. It sets the segment's
// flag and turns a hidden representation back on when an organ is shown.
function needsUpdate(rep: OrganRepresentation | undefined, segmentIndex: number, visible: boolean): boolean {
  if (!rep) return false;
  const entry = rep.segments?.[segmentIndex];
  if (!entry || !!entry.visible !== visible) return true;
  return visible && !rep.visible;
}

/**
 * Sets each organ's visibility (checkState[i] for segment index i, slot 0 being the background)
 * on the given panes. Each setSegmentIndexVisibility queues two segmentation renders, drained one
 * per frame, so only organs that change are set: setting every organ on every pane queued about
 * 210 renders per call and the overlay lagged behind a toggle. An organ that changes nowhere is
 * left alone entirely, including the setActiveSegmentIndex call that queues a render of its own.
 * When nothing changes, one render is still requested, so a call made to repaint rebuilt
 * labelmap actors still gets its colour pass.
 */
export function applyOrganVisibility(api: OrganVisibilityApi, panes: readonly string[], checkState: readonly boolean[]): void {
  let changed = false;
  for (let i = 1; i < checkState.length; i++) {
    const visible = checkState[i];
    if (!panes.some((viewportId) => needsUpdate(api.representation(viewportId), i, visible))) continue;
    api.setActiveSegmentIndex(i);
    for (const viewportId of panes) {
      if (!needsUpdate(api.representation(viewportId), i, visible)) continue;
      api.setSegmentIndexVisibility(viewportId, i, visible);
      changed = true;
    }
  }
  if (!changed) api.requestRender();
}
