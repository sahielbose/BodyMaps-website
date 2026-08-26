import { Link } from "react-router-dom";
import styles from "./SiteFooter.module.css";

/** Slim site-wide footer: company line + legal links + commercial-partnership pointer to the main site. */
function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <span className={styles.tagline}>
        BodyMaps, the open library of labeled body CT scans.
      </span>
      <nav className={styles.legalLinks} aria-label="Legal">
        <Link className={styles.link} to="/terms">
          Terms of service
        </Link>
        <Link className={styles.link} to="/privacy">
          Privacy policy
        </Link>
      </nav>
      <span className={styles.partner}>
        For commercial use, please visit{" "}
        <a
          className={styles.link}
          href="https://thebodymaps.com/contact/"
          target="_blank"
          rel="noopener noreferrer"
        >
          thebodymaps.com
        </a>
      </span>
    </footer>
  );
}

export default SiteFooter;
