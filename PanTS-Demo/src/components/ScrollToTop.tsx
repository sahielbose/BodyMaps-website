import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

// Resets scroll on route change. BrowserRouter has no built-in scroll
// restoration, so without this a new page opens at the previous page's
// scroll offset. Most pages scroll the window; the landing page scrolls
// its own fixed root (tagged data-scroll-root), so both are reset.
// Instant scrollTo (not smooth) so the new page simply appears at the top.
// Keyed on pathname only: query-param changes (dashboard filters) and hash
// changes must not reset scroll.
//
// Browser Back and Forward (a POP) put the reader back where they were
// instead: the offset is remembered per history entry (location.key) and
// restored once the page is tall enough, since the case grid renders after
// its data arrives.
type Offsets = { y: number; root: number };

const SAVED_LIMIT = 100;
const RESTORE_WINDOW_MS = 1000;
const USER_INPUT = ["wheel", "touchmove", "keydown", "mousedown"] as const;
const saved = new Map<string, Offsets>();

const scrollRoot = () => document.querySelector<HTMLElement>("[data-scroll-root]");

function readOffsets(): Offsets {
  return { y: window.scrollY, root: scrollRoot()?.scrollTop ?? 0 };
}

export default function ScrollToTop() {
  const { pathname, key } = useLocation();
  const navType = useNavigationType();
  const lastPath = useRef<string | null>(null);
  // Latest offsets of the page on screen, kept by the scroll listener. They
  // are read when the location changes, because by then the new page has
  // rendered and a shorter page has already clamped the live scroll position.
  const latest = useRef<Offsets>({ y: 0, root: 0 });

  useEffect(() => {
    const track = () => {
      latest.current = readOffsets();
    };
    // Capture, because the landing root's scroll events do not bubble.
    window.addEventListener("scroll", track, { capture: true, passive: true });
    let previous: ScrollRestoration | undefined;
    try {
      previous = window.history.scrollRestoration;
      window.history.scrollRestoration = "manual";
    } catch {
      /* history API unavailable */
    }
    return () => {
      window.removeEventListener("scroll", track, { capture: true });
      try {
        if (previous) window.history.scrollRestoration = previous;
      } catch {
        /* history API unavailable */
      }
    };
  }, []);

  useLayoutEffect(() => {
    const pathChanged = lastPath.current !== pathname;
    lastPath.current = pathname;
    const target = navType === "POP" ? saved.get(key) : undefined;
    let cancel: (() => void) | undefined;

    if (target) {
      latest.current = target;
      cancel = restoreOffsets(target);
    } else if (pathChanged) {
      latest.current = { y: 0, root: 0 };
      window.scrollTo(0, 0);
      const root = scrollRoot();
      if (root) root.scrollTop = 0;
    }

    return () => {
      cancel?.();
      saved.delete(key);
      saved.set(key, latest.current);
      if (saved.size > SAVED_LIMIT) {
        const oldest = saved.keys().next().value;
        if (oldest !== undefined) saved.delete(oldest);
      }
    };
  }, [pathname, key, navType]);
  return null;
}

// Scrolls to the saved offsets, and keeps trying for about a second while the
// page is still too short to reach them. Any wheel, touch, key or click from
// the reader ends it at once. Returns a function that stops it.
function restoreOffsets(target: Offsets): () => void {
  let frame = 0;
  let stopped = false;
  const start = performance.now();
  const apply = () => {
    window.scrollTo(0, target.y);
    const root = scrollRoot();
    if (root) root.scrollTop = target.root;
    const rootReady = !root || root.scrollHeight - root.clientHeight >= target.root;
    const pageReady =
      document.documentElement.scrollHeight - window.innerHeight >= target.y;
    return rootReady && pageReady;
  };
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const type of USER_INPUT) window.removeEventListener(type, stop, true);
  };
  const tick = () => {
    if (stopped) return;
    if (apply() || performance.now() - start > RESTORE_WINDOW_MS) {
      stop();
      return;
    }
    frame = requestAnimationFrame(tick);
  };
  for (const type of USER_INPUT) window.addEventListener(type, stop, true);
  if (apply()) {
    stop();
  } else {
    frame = requestAnimationFrame(tick);
  }
  return stop;
}
