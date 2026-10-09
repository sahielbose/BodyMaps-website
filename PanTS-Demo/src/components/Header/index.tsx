import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { Link, NavLink } from "react-router-dom";
import AuthButton from "../AuthButton";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { prefersReducedMotion } from "../../helpers/motion";
import styles from "./Header.module.css";

const TABS = [
  { id: "overview", label: "Overview", path: "/" },
  { id: "dataset", label: "Dataset", path: "/dashboard" },
  { id: "upload", label: "Upload", path: "/upload" },
  { id: "team", label: "Team", path: "/team" },
] as const;

/* The drawer only exists in the phone layout (Header.module.css). */
const MOBILE_QUERY = "(max-width: 767px)";
/* Matches the drawer's exit animation in Header.module.css. */
const DRAWER_EXIT_MS = 180;

/* "closing" keeps the drawer mounted while it slides out. */
type DrawerState = "closed" | "open" | "closing";

export default function Header() {
  const [drawer, setDrawer] = useState<DrawerState>("closed");
  const menuOpen = drawer === "open";

  const menuId = useId();
  const drawerRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => {
    setDrawer((state) => (state === "open" ? "closing" : state));
  }, []);

  const toggleMenu = () => {
    setDrawer((state) => (state === "open" ? "closing" : "open"));
  };

  // Focus moves to the close button, Tab and Shift+Tab stay inside the
  // drawer, Escape closes it, the page stops scrolling, and focus goes back
  // to the hamburger on close.
  // Escape closes the innermost layer: with the account dropdown open inside
  // the drawer it closes just the dropdown and keeps focus on its trigger.
  const onDrawerEscape = () => {
    const open = drawerRef.current?.querySelector<HTMLElement>('[aria-expanded="true"]');
    if (open) {
      open.click();
      open.focus();
    } else {
      closeMenu();
    }
  };
  useDialogFocus(menuOpen, drawerRef, { initialFocus: closeButtonRef, onEscape: onDrawerEscape });

  // The landing page scrolls its own fixed root (tagged data-scroll-root)
  // rather than the window, so lock that too.
  useEffect(() => {
    if (!menuOpen) return;
    const scrollRoots = Array.from(
      document.querySelectorAll<HTMLElement>("[data-scroll-root]"),
    );
    const prevRootOverflows = scrollRoots.map((el) => el.style.overflowY);
    scrollRoots.forEach((el) => {
      el.style.overflowY = "hidden";
    });
    return () => {
      scrollRoots.forEach((el, i) => {
        el.style.overflowY = prevRootOverflows[i];
      });
    };
  }, [menuOpen]);

  // Rotating a phone or widening the window past the phone layout hides the
  // drawer (display: none) but would leave it open, still holding the page's
  // scroll lock with no visible way to close it. Close it outright.
  useEffect(() => {
    if (!menuOpen || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      if (!query.matches) setDrawer("closed");
    };
    if (query.addEventListener) query.addEventListener("change", onChange);
    else query.addListener(onChange);
    return () => {
      if (query.removeEventListener) query.removeEventListener("change", onChange);
      else query.removeListener(onChange);
    };
  }, [menuOpen]);

  // Unmount once the slide-out has played.
  useEffect(() => {
    if (drawer !== "closing") return;
    const id = window.setTimeout(
      () => setDrawer("closed"),
      prefersReducedMotion() ? 0 : DRAWER_EXIT_MS,
    );
    return () => window.clearTimeout(id);
  }, [drawer]);

  const closing = drawer === "closing";

  // While the drawer is up the header's stacking context is raised above the
  // page's floating controls (the scroll-to-top button), which would
  // otherwise paint over the backdrop and the drawer and take its taps.
  return (
    <header
      className={`${styles.headerRoot} ${drawer !== "closed" ? styles.drawerOpen : ""}`}
    >
      <nav className={styles.nav} aria-label="Main navigation">
        <Link
          to="/"
          className={styles.logoPill}
          aria-label="Go to the BodyMaps home page"
        >
          <img src="/bodymaps-logo.svg" alt="" className={styles.logoImg} />

          <span className={styles.logoTitle}>BodyMaps</span>
        </Link>

        <div className={styles.tabBar}>
          {TABS.map((tab) => (
            <NavLink
              key={tab.id}
              to={tab.path}
              end={tab.path === "/"}
              className={({ isActive }) =>
                `${styles.tabPill} ${isActive ? styles.tabPillActive : ""}`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>

        <div className={styles.navActions}>
          <AuthButton />

          <button
            type="button"
            className={styles.hamburger}
            onClick={toggleMenu}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls={menuId}
          >
            <span className={styles.hamburgerLine} />
            <span className={styles.hamburgerLine} />
            <span className={styles.hamburgerLine} />
          </button>
        </div>
      </nav>

      {drawer !== "closed" && (
        <>
          <button
            type="button"
            className={`${styles.backdrop} ${closing ? styles.closing : ""}`}
            onClick={closeMenu}
            aria-label="Close menu"
            tabIndex={-1}
          />

          <aside
            ref={drawerRef}
            id={menuId}
            className={`${styles.mobileMenu} ${closing ? styles.closing : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${menuId}-title`}
            inert={closing}
          >
            <div className={styles.drawerHeader}>
              <span id={`${menuId}-title`} className={styles.drawerTitle}>
                BodyMaps
              </span>

              <button
                ref={closeButtonRef}
                type="button"
                className={styles.drawerClose}
                onClick={closeMenu}
                aria-label="Close menu"
              >
                <IconX size={20} aria-hidden="true" />
              </button>
            </div>

            <nav className={styles.drawerNav} aria-label="Mobile navigation">
              {TABS.map((tab) => (
                <NavLink
                  key={tab.id}
                  to={tab.path}
                  end={tab.path === "/"}
                  className={({ isActive }) =>
                    `${styles.mobileTab} ${
                      isActive ? styles.mobileTabActive : ""
                    }`
                  }
                  onClick={closeMenu}
                >
                  {tab.label}
                </NavLink>
              ))}
            </nav>

            <div className={styles.drawerFooter}>
              {/* The drawer closes first, so the sign-in popup opens over the
                  page and focus returns to the hamburger when it closes. The
                  account dropdown opens upwards from the bottom of the drawer. */}
              <AuthButton onAction={closeMenu} dropUp />
            </div>
          </aside>
        </>
      )}
    </header>
  );
}
