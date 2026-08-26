import { useEffect } from "react";
import { useLocation } from "react-router";

// Resets scroll on route change. BrowserRouter has no built-in scroll
// restoration, so without this a new page opens at the previous page's
// scroll offset. Most pages scroll the window; the landing page scrolls
// its own fixed root (tagged data-scroll-root), so both are reset.
// Instant scrollTo (not smooth) so the new page simply appears at the top.
// Keyed on pathname only: query-param changes (dashboard filters) and hash
// changes must not reset scroll.
export default function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document
      .querySelectorAll<HTMLElement>("[data-scroll-root]")
      .forEach((el) => el.scrollTo(0, 0));
  }, [pathname]);
  return null;
}
