// helpers/routeSurface.ts
//
// Which routes paint on a dark surface: the case viewer and the other
// full-screen dark tools (live rooms, quiz practice, the compare page and
// the compare viewer). Every other page is light. index.html runs this same
// pattern inline before the first paint, so a hard load never flashes the
// wrong colour; keep the two in sync (src/test/chrome.test.tsx checks it).
// Each pattern needs the segment shape its route needs (see App.tsx), so a
// path that only starts like a viewer route ("/case/", "/learn/x",
// "/case/12/extra") stays on the light not-found page. The patterns ignore
// case because the router does ("/Case/35" renders the viewer).

export const DARK_ROUTE_PATTERN =
	/\/(case|session|reconstruction|live)\/[^/]+\/*$|\/live\/challenge\/[^/]+\/*$|\/learn\/quiz\/[^/]+\/*$|\/(dicom|local-nifti|compare|compare-viewer)\/*$/i;

/** Class on <html> while a dark route is showing. */
export const DARK_ROUTE_CLASS = "bm-dark-route";

export function isDarkRoute(pathname: string): boolean {
	return DARK_ROUTE_PATTERN.test(pathname);
}

/**
 * The dark routes whose page is fixed to the window: the case viewer and the
 * tools built on it, plus the compare viewer. Nothing there scrolls the
 * document. The compare page is dark too but is an ordinary scrolling page,
 * so it is not in this list. Every route here must also match
 * DARK_ROUTE_PATTERN (src/test/regressRound1.test.tsx checks it).
 */
export const FIXED_VIEWER_ROUTE_PATTERN =
	/\/(case|session|reconstruction|live)\/[^/]+\/*$|\/live\/challenge\/[^/]+\/*$|\/learn\/quiz\/[^/]+\/*$|\/(dicom|local-nifti|compare-viewer)\/*$/i;

export function isFixedViewerRoute(pathname: string): boolean {
	return FIXED_VIEWER_ROUTE_PATTERN.test(pathname);
}
