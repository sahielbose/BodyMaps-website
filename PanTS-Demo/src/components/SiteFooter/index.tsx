import { Link } from "react-router-dom";
import {
  CONTACT_LINK_TEXT,
  CONTACT_PATH,
  FOOTER_INQUIRY_LEAD,
  NONCLINICAL_ADVICE,
  NONCLINICAL_USE,
} from "../../helpers/copy";
import styles from "./SiteFooter.module.css";

/**
 * Slim one-line site-wide footer: the nonclinical notice on the left, the
 * inquiry route on the right. The mission line lives in the landing subtitle
 * now, so it is not repeated here. Strings live in helpers/copy.ts.
 * data-site-footer lets the floating scroll-to-top button sit above it.
 */
function SiteFooter() {
  return (
    <footer className={styles.footer} data-site-footer="">
      <span className={styles.notice}>
        <span className={styles.sentence}>{NONCLINICAL_USE}</span>{" "}
        <span className={styles.sentence}>{NONCLINICAL_ADVICE}</span>
      </span>
      <span className={styles.partner}>
        {FOOTER_INQUIRY_LEAD}{" "}
        <Link className={styles.link} to={CONTACT_PATH}>
          {CONTACT_LINK_TEXT}
        </Link>
        .
      </span>
    </footer>
  );
}

export default SiteFooter;
