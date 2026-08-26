import { useEffect, useId, useRef, useState } from "react";
import { IconX } from "@tabler/icons-react";
import { Link, NavLink } from "react-router-dom";
import AuthButton from "../AuthButton";
import styles from "./Header.module.css";

const TABS = [
  { id: "overview", label: "Overview", path: "/" },
  { id: "dataset", label: "Dataset", path: "/dashboard" },
  { id: "upload", label: "Upload", path: "/upload" },
  { id: "team", label: "Team", path: "/team" },
] as const;

export default function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  const menuId = useId();
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = () => {
    setMenuOpen(false);
  };

  const closeMenuAndRestoreFocus = () => {
    setMenuOpen(false);
    hamburgerRef.current?.focus();
  };

  const toggleMenu = () => {
    setMenuOpen((currentState) => !currentState);
  };

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    closeButtonRef.current?.focus();

    // Lock background scrolling while the drawer is open. Most pages scroll
    // the window (locked via body overflow); the landing page scrolls its own
    // fixed root, tagged data-scroll-root.
    const scrollRoots = Array.from(
      document.querySelectorAll<HTMLElement>("[data-scroll-root]"),
    );
    const prevBodyOverflow = document.body.style.overflow;
    const prevRootOverflows = scrollRoots.map((el) => el.style.overflowY);
    document.body.style.overflow = "hidden";
    scrollRoots.forEach((el) => {
      el.style.overflowY = "hidden";
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenuAndRestoreFocus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = prevBodyOverflow;
      scrollRoots.forEach((el, i) => {
        el.style.overflowY = prevRootOverflows[i];
      });
    };
  }, [menuOpen]);

  return (
    <header className={styles.headerRoot}>
      <nav className={styles.nav} aria-label="Main navigation">
        <Link
          to="/dashboard"
          className={styles.logoPill}
          aria-label="Go to the BodyMaps dashboard"
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
            ref={hamburgerRef}
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

      {menuOpen && (
        <>
          <button
            type="button"
            className={styles.backdrop}
            onClick={closeMenuAndRestoreFocus}
            aria-label="Close menu"
            tabIndex={-1}
          />

          <aside
            id={menuId}
            className={styles.mobileMenu}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${menuId}-title`}
          >
            <div className={styles.drawerHeader}>
              <span id={`${menuId}-title`} className={styles.drawerTitle}>
                BodyMaps
              </span>

              <button
                ref={closeButtonRef}
                type="button"
                className={styles.drawerClose}
                onClick={closeMenuAndRestoreFocus}
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
              <AuthButton />
            </div>
          </aside>
        </>
      )}
    </header>
  );
}
