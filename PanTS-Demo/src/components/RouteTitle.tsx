// components/RouteTitle.tsx
//
// Gives every route its own document title, so browser tabs, history,
// bookmarks and screen readers (which announce the title on navigation) can
// tell pages apart. One mapping (helpers/routeTitles) instead of an effect in
// every page.
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { SITE_TITLE } from "../helpers/copy";
import { titleForPath } from "../helpers/routeTitles";

export default function RouteTitle() {
	const { pathname } = useLocation();
	useEffect(() => {
		// A title must never take the page down, so fall back to the site title.
		try {
			document.title = titleForPath(pathname);
		} catch {
			document.title = SITE_TITLE;
		}
	}, [pathname]);
	return null;
}
