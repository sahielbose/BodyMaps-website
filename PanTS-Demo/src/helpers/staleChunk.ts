const RELOAD_KEY = "bodymaps:stale-chunk-reload";
// A second failure inside this window means the reload did not help (the
// server is down, not just newer), so the error is left for the route boundary.
const RELOAD_WINDOW_MS = 30_000;

/**
 * Handler for Vite's "vite:preloadError": a lazy route chunk could not be
 * fetched, most often because a new build replaced the files under an open
 * tab. Reloads once to pick up the new build; does nothing the second time
 * within the window, so the failure reaches the route's error page instead of
 * looping. It also does nothing while the browser is offline: the files are
 * not stale, the network is gone, and a reload would drop the open scan and
 * land on the browser's own offline page instead of the route's error page.
 */
export function reloadOnceForStaleChunk(
	event: Event,
	reload: () => void = () => window.location.reload(),
	now: number = Date.now(),
	online: boolean = typeof navigator === "undefined" || navigator.onLine !== false,
) {
	if (!online) return;
	let last = 0;
	try {
		last = Number(window.sessionStorage.getItem(RELOAD_KEY)) || 0;
	} catch {
		// Storage blocked: fall through and reload once, which cannot be guarded.
	}
	if (last && now - last < RELOAD_WINDOW_MS) return;
	try {
		window.sessionStorage.setItem(RELOAD_KEY, String(now));
	} catch {
		// Without storage a reload could loop, so leave the error to the boundary.
		return;
	}
	event.preventDefault();
	reload();
}
