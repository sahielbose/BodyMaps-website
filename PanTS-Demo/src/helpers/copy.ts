/**
 * Canonical site copy shared across surfaces. Change strings here, not inline:
 * src/test/copy.test.ts guards them so an upstream merge cannot silently revert
 * the wording (that happened once to the brand pass).
 */

/** The two sentences of the nonclinical boundary, so the footer can keep each whole when it wraps. */
export const NONCLINICAL_USE = "For nonclinical use only.";
export const NONCLINICAL_ADVICE = "Not medical advice or for patient care.";

/** Persistent nonclinical boundary. Same sentence everywhere it appears. */
export const NONCLINICAL_WARNING = `${NONCLINICAL_USE} ${NONCLINICAL_ADVICE}`;

/** Landing hero subtitle, directly under the wordmark. */
export const LANDING_SUBTITLE = "The intelligence layer for medical imaging AI";

/** One-paragraph orientation for a first-time visitor, under the stats row. */
export const LANDING_OVERVIEW =
  "Browse the library in 2D and 3D, upload your own CT for AI segmentation, and annotate or refine the results.";

/** Browser-tab / link-preview title (index.html <title>, og:title, twitter:title). */
export const SITE_TITLE = "BodyMaps: CT library, segmentation, and annotation";

/** Meta / og / twitter description. */
export const SITE_DESCRIPTION =
  "Browse body CT scans in 2D and 3D, upload CT for AI segmentation, and annotate results. For nonclinical use only.";


/** Footer, right column: inquiry routing. The link text follows this lead. */
export const FOOTER_INQUIRY_LEAD =
  "For private licensing and other inquiries, contact BodyMaps, Inc. through";

/** The one external contact route (a separate BodyMaps, Inc. site). */
export const CONTACT_URL = "https://thebodymaps.com/contact/";
export const CONTACT_LINK_TEXT = "thebodymaps.com/contact";

/** Auth modal fine print, shown on sign-in and sign-up (links follow). The
 *  links name the documents as the pages do: "Terms of Service" and
 *  "Privacy Notice". */
export const AUTH_FINEPRINT_LEAD = "By continuing, you agree to the";
export const AUTH_FINEPRINT_MID = "and acknowledge the";

/** Auth modal, forgot-password screen: what the single email field is for. */
export const AUTH_OAUTH_RESET_HINT =
  "Enter your email and we'll send you a link to choose a new password. If you normally sign in with Google or GitHub, go back to Sign in and choose that option, since those accounts have no password here.";

/** Header nav entry that opens the contact route in a new tab. */
export const NAV_CONTACT_LABEL = "CONTACT";
