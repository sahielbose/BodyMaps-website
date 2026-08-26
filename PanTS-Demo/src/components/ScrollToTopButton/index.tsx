import { useEffect, useRef, useState } from "react";
import { IconArrowUp } from "@tabler/icons-react";
import styles from "./ScrollToTopButton.module.css";

const SCROLL_THRESHOLD = 300;

export default function ScrollToTopButton() {
  const [visible, setVisible] = useState(false);
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
        return;
      }
      if (target instanceof HTMLElement) {
        // Only page-level scroll containers count — scrolling a dropdown or a
        // side panel must not summon the button.
        if (target.clientHeight >= window.innerHeight * 0.8) {
          lastScroller.current = target;
          setVisible(target.scrollTop > SCROLL_THRESHOLD);
        }
      }
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  const scrollToTop = () => {
    if (lastScroller.current && lastScroller.current.isConnected) {
      lastScroller.current.scrollTo({ top: 0, behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  return (
    <button
      type="button"
      className={`${styles.btn} ${visible ? styles.visible : ""}`}
      onClick={scrollToTop}
      aria-label="Scroll to top"
    >
      <IconArrowUp size={24} aria-hidden="true" />
    </button>
  );
}
