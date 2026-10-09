const GUARD_KEY = "__bmLeaveGuard";

/**
 * Asks before the reader loses unsaved work, however they leave the page: closing or
 * reloading the tab (the browser's own prompt), clicking an in-app link such as the site
 * header or logo, or pressing the browser Back button. The app's router cannot block
 * in-app navigation, so links are confirmed in the capture phase and Back is held by a
 * history entry that absorbs one press. Returns a function that removes the guard.
 * A confirmed link click first steps back off that spare entry and then follows the link,
 * so the new page replaces it instead of leaving a twin of the viewer behind. The page's
 * own full-load exits go through leavePageTo, and a page that loads onto a spare entry
 * left by an accepted reload or exit steps off it (dropStaleGuardEntry).
 */
let activeGuards = 0;
let staleChecked = false;
// Set while a page load the reader already agreed to, in the page's own question, is
// starting, so the browser's prompt does not ask the same thing a second time.
let agreedToLeave = false;
// Back steps a released guard took to drop its spare entry that have not landed yet. A guard
// installed again before one lands (a session stopping and its summary opening in the same
// moment) must not read that step as the reader pressing Back.
let droppingEntries = 0;

const holdsSentinel = () => Boolean((window.history.state as Record<string, unknown> | null)?.[GUARD_KEY]);

// Wrapped so a test can observe a full page load, which jsdom cannot perform.
export const pageNav = {
	replace: (url: string) => window.location.replace(url),
	assign: (url: string) => {
		window.location.href = url;
	},
};

/**
 * Loads another page the way a link would. While the guard holds its spare entry, the
 * page replaces that entry instead of stacking on top of it, so an agreed leave (the
 * browser's own prompt still asks) leaves no twin of the viewer in history. Pass
 * `confirmed` when the page has already asked the reader, so the browser does not ask again.
 */
export function leavePageTo(url: string, confirmed = false): void {
	agreedToLeave = confirmed;
	try {
		if (activeGuards > 0 && holdsSentinel()) pageNav.replace(url);
		else pageNav.assign(url);
	} finally {
		agreedToLeave = false;
	}
}

/**
 * A reload, or a typed address, that the reader agreed to while the guard was on keeps the
 * spare entry in history.state, so the next load of the viewer sits on a twin of the real
 * entry. Step back onto the real one once per document, before anything is pushed on top.
 */
export function dropStaleGuardEntry(): void {
	if (staleChecked) return;
	staleChecked = true;
	if (activeGuards === 0 && holdsSentinel()) window.history.back();
}

export function guardLeaving(message: string): () => void {
	let leaving = false;
	let following = false;
	let replay: (() => void) | null = null;
	let released = false;
	// Set once the reader says yes to the in-app question, so the page load that follows
	// does not ask a second time through the browser's own prompt.
	let agreed = false;

	const onBeforeUnload = (e: BeforeUnloadEvent) => {
		if (agreed || agreedToLeave) return;
		e.preventDefault();
		e.returnValue = "";
	};

	const onClick = (e: MouseEvent) => {
		if (following || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>("a[href]") : null;
		if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
		const to = new URL(link.href, window.location.href);
		// Another origin is a full page load (beforeunload asks), and a link back to this
		// very page leaves nothing behind.
		if (to.origin !== window.location.origin) return;
		if (to.pathname === window.location.pathname && to.search === window.location.search) return;
		if (!window.confirm(message)) {
			e.preventDefault();
			e.stopPropagation();
			return;
		}
		agreed = true;
		if (holdsSentinel()) {
			// Agreed: drop the spare entry, then replay the click once the browser has moved off it.
			e.preventDefault();
			e.stopPropagation();
			leaving = true;
			replay = () => {
				replay = null;
				leaving = false;
				following = true;
				// A router link handles the click itself (it prevents the default). A plain
				// anchor is a full page load the browser may still decline, so it is followed
				// from a restored spare entry and replaces it instead of stacking on it.
				const probe = (ev: Event) => {
					if (ev.defaultPrevented) return;
					ev.preventDefault();
					window.history.pushState({ ...(window.history.state as object | null), [GUARD_KEY]: true }, "");
					pageNav.replace(to.href);
				};
				document.addEventListener("click", probe);
				try {
					link.click();
				} finally {
					document.removeEventListener("click", probe);
					following = false;
				}
			};
			window.addEventListener("popstate", replay, { once: true });
			window.history.back();
		}
	};

	const onPopState = () => {
		if (leaving || droppingEntries > 0 || holdsSentinel()) return;
		if (window.confirm(message)) {
			leaving = true;
			agreed = true;
			window.history.back();
		} else {
			window.history.pushState({ ...(window.history.state as object | null), [GUARD_KEY]: true }, "");
		}
	};

	window.addEventListener("beforeunload", onBeforeUnload);
	document.addEventListener("click", onClick, true);
	window.addEventListener("popstate", onPopState);
	activeGuards++;
	// A reload the reader agreed to keeps the spare entry in history.state; reuse it
	// rather than stacking another one under every new session.
	if (!holdsSentinel()) window.history.pushState({ ...(window.history.state as object | null), [GUARD_KEY]: true }, "");

	return () => {
		if (released) return;
		released = true;
		window.removeEventListener("beforeunload", onBeforeUnload);
		document.removeEventListener("click", onClick, true);
		window.removeEventListener("popstate", onPopState);
		if (replay) window.removeEventListener("popstate", replay);
		activeGuards--;
		// Drop the spare entry if the reader is still on it, so Back is one press again. If a
		// new guard is on by the time that step lands, it gets its spare entry back.
		if (!leaving && holdsSentinel()) {
			droppingEntries++;
			window.addEventListener(
				"popstate",
				() => {
					droppingEntries--;
					if (activeGuards > 0 && !holdsSentinel()) {
						window.history.pushState({ ...(window.history.state as object | null), [GUARD_KEY]: true }, "");
					}
				},
				{ once: true }
			);
			window.history.back();
		}
		leaving = false;
		following = false;
		replay = null;
	};
}
