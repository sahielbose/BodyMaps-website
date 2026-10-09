import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { IconArrowUp } from "@tabler/icons-react";
import { scrollBehavior } from "../../helpers/motion";
import { DARK_ROUTE_CLASS, isFixedViewerRoute } from "../../helpers/routeSurface";
import styles from "./ScrollToTopButton.module.css";

const SCROLL_THRESHOLD = 300;

/** How far the site footer reaches up into the viewport, in px (0 when it is below the fold). */
function footerOverlap(): number {
  const footer = document.querySelector<HTMLElement>("[data-site-footer]");
  if (!footer) return 0;
  return Math.max(0, Math.round(window.innerHeight - footer.getBoundingClientRect().top));
}

export default function ScrollToTopButton() {
  const { pathname } = useLocation();
  const [visible, setVisible] = useState(false);
  // The case viewer and the other full-screen tools are fixed to the window,
  // so a floating round button only ever lands on top of a loader or the
  // panes. <html> carries the dark class while one is showing, and a light
  // message page on such a route removes it, so this follows the class as well
  // as the path. The compare page is dark too but scrolls the document like
  // any other page, so the path has to be one of the fixed viewers.
  const [darkSurface, setDarkSurface] = useState(() =>
    document.documentElement.classList.contains(DARK_ROUTE_CLASS),
  );
  // The button sits this far higher so it never covers the footer's text
  // (the footer rides the bottom edge on long pages).
  const [lift, setLift] = useState(0);
  // Some pages scroll the window; the landing page scrolls a full-height inner
  // div. Capture-phase listening sees both, and this remembers which one the
  // user actually scrolled so the button sends that container back to top.
  const lastScroller = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target === document) {
        lastScroller.current = null;
        setVisible(window.scrollY > SCROLL_THRESHOLD);
        setLift(footerOverlap());
        return;
      }
      if (target instanceof HTMLElement) {
        // Only page-level scroll containers count — scrolling a dropdown or a
        // side panel must not summon the button.
        if (target.clientHeight >= window.innerHeight * 0.8) {
          lastScroller.current = target;
          setVisible(target.scrollTop > SCROLL_THRESHOLD);
          setLift(footerOverlap());
        }
      }
    };
    const onResize = () => setLift(footerOverlap());
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const sync = () => setDarkSurface(root.classList.contains(DARK_ROUTE_CLASS));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // A new page brings its own footer (or none); measure once it has painted.
  // Visibility is re-read too: a route change resets the scroll without
  // firing a scroll event when the window was already at the top (the old
  // page scrolled an inner container), so the last page's value would stick.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setLift(footerOverlap());
      const scroller = lastScroller.current?.isConnected ? lastScroller.current : null;
      lastScroller.current = scroller;
      setVisible((scroller ? scroller.scrollTop : window.scrollY) > SCROLL_THRESHOLD);
    });
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  const scrollToTop = () => {
    const behavior = scrollBehavior();
    if (lastScroller.current && lastScroller.current.isConnected) {
      lastScroller.current.scrollTo({ top: 0, behavior });
    } else {
      window.scrollTo({ top: 0, behavior });
    }
    // The button hides itself at the top, which would drop keyboard focus to
    // <body>; hand it to the start of the page instead. A page with no site
    // header (the compare page) falls back to its main landmark, as the skip
    // link does.
    const target =
      document.querySelector<HTMLElement>("header a[href], header button") ??
      document.querySelector<HTMLElement>("main");
    if (target) {
      if (target.tagName === "MAIN" && !target.hasAttribute("tabindex")) {
        target.setAttribute("tabindex", "-1");
      }
      target.focus({ preventScroll: true });
    }
  };

  // The overview page is a designed scroll with its own pacing; a floating
  // round button over it is clutter. The header is always one gesture away.
  if (pathname === "/" || (darkSurface && isFixedViewerRoute(pathname))) return null;

  // While hidden it is out of the tab order and the accessibility tree
  // (inert, plus visibility: hidden once the fade-out ends), so the first Tab
  // on a page no longer lands on an invisible control.
  return (
    <button
      type="button"
      className={`${styles.btn} ${visible ? styles.visible : ""}`}
      style={{ ["--footer-lift" as string]: `${lift}px` }}
      onClick={scrollToTop}
      aria-label="Scroll to top"
      aria-hidden={visible ? undefined : true}
      inert={!visible}
    >
      <IconArrowUp size={24} aria-hidden="true" />
    </button>
  );
}
