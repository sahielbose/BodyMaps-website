import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { flush, routePattern, trackPageView } from "../helpers/analytics";

// A foreground stretch shorter than this isn't a visit: a window switch that
// bounced straight back, or pagehide arriving just after the tab was hidden.
const MIN_STRETCH_MS = 1000;

// Turns navigation into "time spent here" numbers. Mounted once, inside the
// router, renders nothing.
//
// Time is only counted while the tab is actually in front. Without that, a tab
// left open overnight would report the viewer as the most-used feature in the
// product by a wide margin, which is true of the tab and false of the person.
const AnalyticsRouteTracker: React.FC = () => {
	const { pathname } = useLocation();
	// Held in refs, not state: this component must never re-render anything.
	const route = useRef<string | null>(null);
	// Set when a stretch starts (the route effect below runs before any read).
	const since = useRef<number>(0);
	// Whether a foreground stretch is running. Each stretch is recorded once,
	// when it ends: on leaving the route, or when the tab goes to the
	// background (visibilitychange, then pagehide, both report that).
	const running = useRef(false);

	const endStretch = () => {
		if (!running.current) return;
		running.current = false;
		const ms = Date.now() - since.current;
		if (route.current && ms >= MIN_STRETCH_MS) trackPageView(route.current, ms);
	};

	useEffect(() => {
		route.current = routePattern(pathname);
		since.current = Date.now();
		running.current = document.visibilityState !== "hidden";
		// Closes out this route when the next one opens (or the app unmounts).
		return endStretch;
		// Only on a route change: the effect's whole job is the transition.
	}, [pathname]);

	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState !== "hidden") {
				// Back in front: start a fresh stretch rather than counting the
				// time the tab spent in the background.
				if (!running.current) {
					running.current = true;
					since.current = Date.now();
				}
				return;
			}
			endStretch();
			// The tab may not come back, so get what we have to the server now.
			flush(true);
		};

		document.addEventListener("visibilitychange", onVisibility);
		// pagehide rather than unload: unload doesn't fire on mobile Safari.
		window.addEventListener("pagehide", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("pagehide", onVisibility);
		};
	}, []);

	return null;
};

export default AnalyticsRouteTracker;
