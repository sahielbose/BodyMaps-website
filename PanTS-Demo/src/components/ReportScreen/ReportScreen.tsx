import { IconShare } from '@tabler/icons-react';
import React, { useEffect, useLayoutEffect, useState, useRef, useCallback } from 'react';
import { APP_CONSTANTS } from '../../helpers/constants';
import { prefersReducedMotion } from '../../helpers/motion';
import { useDialogFocus } from '../../hooks/useDialogFocus';
import { appRootRelativeUrl } from '../../liveRooms/protocol';
import { formatSex } from '../../helpers/demographics';
import FindingsTimeline, { sortByReadingOrder } from './FindingsTimeline';
import { filenameToName } from '../../helpers/utils.name';
import { findingLabel, getImpressionText, narrowSectionToLocation, organLocation, organRoot } from '../../helpers/reportFindings';

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  id: string;
  onClose: () => void;
  onViewChange: (view: 'axial' | 'sagittal' | 'coronal' | '3d') => void;
  onOrganHighlight?: (organName: string, centroidMm?: [number, number, number]) => void;
  onClearHighlight?: () => void;
  onHideOrgans?: (organNames: string[]) => void;
  /** A reading session is recording; its REC pill sits outside this dialog. */
  recording?: boolean;
};

interface OrganData {
  volume: number;
  mean_hu: number;
  status?: 'normal' | 'check';
  centroid_mm?: [number, number, number];
  dimensions?: [number, number, number];
}

interface ReportData {
  case_id: string;
  patient: { age: number; sex: string };
  imaging: { study_type: string; contrast: string; spacing: number[]; shape: number[] };
  organ_volumes: { [k: string]: OrganData };
  lesions: { [k: string]: { voxels: number; volume: number } };
  comments: string;
  impression: string[];
}

type Lang = 'patient' | 'clinical';
type Step = number;

export const cache: { [key: string]: ReportData } = {};
const REPORT_DATA_TIMEOUT_MS = 30000;
const reportDataRequests = new Map<string, Promise<ReportData | null>>();

/**
 * Starts (or joins) the one report-data request for a case.  The viewer calls
 * this only after its CT is visible, so report preparation never competes with
 * the volume download.  Keeping the promise here also prevents a report-button
 * click from starting a duplicate request while the warm-up is still running.
 */
export function prefetchReportData(id: string): Promise<ReportData | null> {
  const cached = cache[id];
  if (cached) return Promise.resolve(cached);

  const inFlight = reportDataRequests.get(id);
  if (inFlight) return inFlight;

  // A cold case can make the server download the scan first. Past this point the
  // report shows "Report unavailable." instead of an endless spinner, and the
  // Report button can ask again.
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REPORT_DATA_TIMEOUT_MS);
  const request = fetch(`${APP_CONSTANTS.API_ORIGIN}/api/get-report-data/${encodeURIComponent(id)}`, { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (
        !payload ||
        typeof payload !== 'object' ||
        'error' in payload ||
        !('organ_volumes' in payload)
      ) {
        return null;
      }

      const report = payload as ReportData;
      // A scan with no organ to report on would read as "all clear". Treat it as no report,
      // so the viewer shows "Report unavailable." instead.
      if (reportOrgans(report).length === 0) return null;
      // A case with no written report comes back with placeholder comments and no impression.
      // Only the HU checks would speak, so the walkthrough would call the scan healthy and
      // "all clear" though nobody read it. Treat it as no report too.
      if (isReportTextMissing(report)) return null;
      cache[id] = report;
      return report;
    })
    // Report preparation is optional. The Report button remains usable and can
    // request the data again if a background request fails.
    .catch(() => null)
    .finally(() => {
      window.clearTimeout(timeout);
      reportDataRequests.delete(id);
    });

  reportDataRequests.set(id, request);
  return request;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const STYLES = `
@keyframes spin { from{transform:rotate(0)}to{transform:rotate(360deg)} }
@keyframes slideR { from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)} }
@keyframes slideL { from{opacity:0;transform:translateX(-24px)}to{opacity:1;transform:translateX(0)} }
@keyframes riseIn { from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)} }

.rs-scroll::-webkit-scrollbar { width: 6px; }
.rs-scroll::-webkit-scrollbar-track { background: transparent; }
.rs-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.14); border-radius: 999px; }

.rs-link { display: inline-flex; align-items: center; min-height: 32px; }
/* Hover only where a pointer can hover, so a tap on a touch screen does not
   leave the button lit. The toggle's chosen half keeps its inline fill: only
   the unpressed half takes the hover fill, or the dark label would sit on it. */
@media (hover: hover) {
  .rs-primary:hover { transform: translateY(-1px); background: rgba(255,255,255,0.16)!important; border-color: rgba(255,255,255,0.24)!important; }
  .rs-primary-amber:hover { transform: translateY(-1px); background: rgba(251,191,36,0.18)!important; border-color: rgba(251,191,36,0.34)!important; }
  .rs-secondary:hover { background: rgba(255,255,255,0.08)!important; color: rgba(255,255,255,0.9)!important; border-color: rgba(255,255,255,0.18)!important; }
  .rs-exit:hover { background: rgba(255,255,255,0.08)!important; border-color: rgba(255,255,255,0.28)!important; color: rgba(255,255,255,0.95)!important; }
  .rs-toggle[aria-pressed="false"]:hover { background: rgba(255,255,255,0.08)!important; }
  .rs-link:hover { color: rgba(255,255,255,0.9)!important; }
}
.rs-root button:focus-visible { outline: 2px solid rgba(255,255,255,0.92); outline-offset: 2px; }
.rs-root h1:focus { outline: none; }

/* Layout lives in classes, not inline styles, so the narrow-screen block
   below can override it. Desktop values match the old inline ones. */
/* --rs-head-h is the bar itself. --rs-bar-h is everything the panels and the
   stage must stay clear of: the bar plus, while a reading session records, the
   strip under it that holds the REC pill (--rs-rec-h, set on the page; the pill
   is placed there in ReadingSession.css). */
.rs-root { --rs-head-h: 76px; --rs-bar-h: calc(var(--rs-head-h) + var(--rs-rec-h, 0px)); }
.rs-topbar { position: fixed; top: 0; left: 0; right: 0; height: var(--rs-head-h); display: flex; align-items: center; padding: 0 28px; }
.rs-topbar-brand { display: flex; align-items: center; gap: 8px; min-width: 270px; }
.rs-topbar-title { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 9px; }
.rs-topbar-spacer { display: none; }
.rs-jump { display: none; }
.rs-healthy-title { font-size: 40px; }
.rs-healthy-intro { font-size: 17px; }
.rs-topbar-actions { margin-left: auto; display: flex; align-items: center; gap: 12px; min-height: 44px; }
.rs-icon-btn { padding: 9px 13px; }
.rs-share-pop { position: absolute; top: calc(100% + 10px); right: 0; width: 340px; }
.rs-stage, .rs-story-slot { display: contents; }
.rs-story { position: fixed; left: 64px; top: calc(50% + var(--rs-bar-h) / 2); transform: translateY(-50%); width: 360px; max-height: calc(100vh - var(--rs-bar-h) - 74px); overflow-y: auto; }
.rs-evidence { position: fixed; right: 72px; top: calc(50% + var(--rs-bar-h) / 2); transform: translateY(-50%); }
/* --rs-coach-top and --rs-coach-right are measured off the top bar (see
   useCoachAnchor), so the card sits under the Patient/Doctor toggle. */
.rs-coach { position: fixed; right: var(--rs-coach-right, 112px); top: var(--rs-coach-top, calc(var(--rs-bar-h) + 18px)); flex-direction: column; }
.rs-coach-arrow { position: relative; height: 30px; pointer-events: none; }
.rs-coach-arrow svg { position: absolute; top: 0; left: var(--rs-coach-arrow-x, 40px); transform: translateX(-50%); display: block; }
.rs-coach-card { width: 330px; }
.rs-where-narrow { display: none; }
.rs-final { padding: 34px; }
/* The cover and final cards sit in a box that follows the visible viewport, so
   their cap uses dvh (100vh stays as the fallback). 100vh alone is taller than the
   screen while a phone browser bar shows and pushes the pinned buttons off it. */
.rs-card-cap { max-height: calc(100vh - var(--rs-bar-h) - 74px); max-height: calc(100dvh - var(--rs-bar-h) - 74px); }
.rs-final-title { font-size: 46px; }
.rs-final-impression { font-size: 21px; }

/* Wide bar: the step pips hang under the centred title line instead of
   sitting in its column, so the title text is on the same line on the cover
   and on every step and does not jump when the pips arrive. */
@media (min-width: 980px) {
  .rs-topbar-pips { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 9px; }
}

/* The top bar's centred title collides with the Patient/Doctor toggle and
   the actions below about 980px, so from there down the bar wraps to two
   rows with the title on its own row. */
@media (max-width: 979px) {
  .rs-root { --rs-head-h: 104px; }
  .rs-topbar { flex-wrap: wrap; align-content: center; row-gap: 6px; padding: 8px 12px; }
  .rs-topbar-brand { flex: 1 1 0; min-width: 0; overflow: hidden; }
  .rs-topbar-brand > span { white-space: nowrap; }
  .rs-case { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .rs-topbar-actions { flex-shrink: 0; gap: 8px; }
  .rs-topbar-title { position: static; transform: none; order: 3; flex: 1 0 100%; }
  .rs-topbar-spacer { display: block; }
}

/* Below 900px the story (360px, 64px in) and evidence (up to 350px, 72px in)
   panels no longer fit side by side, and Share and Exit were pushed off the
   right edge, where a touch user had no other way out. Share and Exit keep
   only their icons, at one width so the link and the cross line up, and the
   panels stack in one scrolling column that ends with the findings timeline,
   so the timeline never covers the story's buttons, and the story card is capped so the scan shows below it; its
   Back and Next row stays pinned to the card's bottom edge while the text
   scrolls (a sticky box measures from the card's content edge, so its bottom
   offset is the card's 24px padding, and its top fades so rows slide under
   it instead of being cut off by a hard edge). The card sits in a slot that is
   flex: none because a scrolling flex item may shrink to nothing, and with the
   evidence panel and timeline stacked under it the card would give up all the
   height and the column would never scroll. The slot is also a screen tall on
   every step that has a card, so the evidence panel and timeline start below
   the fold and the strip under the card stays free for the scan (see
   REPORT_STACKED_POSE); the card's View measurements button scrolls down to
   them, and changing step scrolls back up. The empty part of the slot lets
   touches through to the scan. The
   column clips sideways so a panel's 24px slide-in can't open
   a horizontal scroll while it plays. The final impressions card is a
   centred panel capped to the screen, so on a phone its headline and
   impression shrink and its Back and Start over row reuses the story's
   pinned actions, which keeps both buttons in view while the text scrolls. */
@media (max-width: 899px) {
  .rs-icon-btn { box-sizing: border-box; width: 38px; padding: 9px 0; justify-content: center; }
  .rs-btn-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .rs-share-pop { position: fixed; top: calc(var(--rs-bar-h) + 8px); left: 12px; right: 12px; width: auto; }
  .rs-stage { position: fixed; top: var(--rs-bar-h); left: 0; right: 0; bottom: 0; z-index: 10001; display: flex; flex-direction: column; gap: 12px; padding: 12px 12px 24px; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; pointer-events: none; }
  .rs-story-slot { display: block; flex: none; min-height: calc(100vh - var(--rs-bar-h) - 24px); }
  .rs-story, .rs-evidence { position: static; transform: none; width: auto; max-height: none; overflow: visible; }
  .rs-evidence > * { width: auto !important; }
  .rs-timeline, .rs-timeline > [role="group"] { position: static !important; transform: none !important; }
  .rs-timeline { align-self: center; max-width: 100%; }
  .rs-timeline > [role="group"] { max-width: 100% !important; }
  .rs-coach { left: 12px; right: 12px; top: calc(var(--rs-bar-h) + 12px); flex-direction: row; }
  .rs-coach-arrow { display: none; }
  .rs-coach-card { flex: 1 1 auto; width: auto; min-width: 0; }
  .rs-where-wide { display: none; }
  .rs-where-narrow { display: inline; }
  .rs-story { flex: none; max-height: 46vh; overflow-y: auto; background: rgba(12,14,18,0.92) !important; }
  .rs-story-actions { position: sticky; bottom: -24px; margin: 0 -24px -24px; padding: 24px; background: linear-gradient(to bottom, rgba(12,14,18,0), #0c0e12 24px); }
  .rs-jump { display: inline-flex; align-items: center; gap: 6px; }
  .rs-healthy-title { font-size: 28px; }
  .rs-healthy-intro { font-size: 15px; margin-bottom: 14px !important; }
  .rs-story-last { margin-bottom: 0 !important; }
  .rs-final { padding: 24px; }
  .rs-final-title { font-size: 34px; }
  .rs-final-impression { font-size: 17px; }
}

/* On a phone the actions take about 260px of the bar, so the brand would
   squeeze to a single letter; the title row below already says what this is.
   The cover has no Patient/Doctor toggle, so the actions are about 100px and
   the brand fits, which keeps the first row from sitting empty. */
@media (max-width: 479px) {
  .rs-topbar-brand { display: none; }
  .rs-topbar--cover .rs-topbar-brand { display: flex; }
}
`;

// The 3D pane is the report's backdrop, and each step moves it: blurred and
// pulled back on the intro, slid right beside the story panel, dimmed behind
// the final card, and eased back to rest on Exit. The viewer keeps its panes
// from ever animating with `.visualization-container .vp-pane { transition:
// none !important }` (0,2,0), which used to beat the report's plain `.render`
// rule (0,1,0) so every step snapped. This selector outranks it (0,4,0) and
// only matches while the report is open, so ordinary viewing still snaps.
export const REPORT_PANE_SELECTOR = '.VisualizationPage.report-open .visualization-container .render';
/** The widest viewport that stacks the story panel over the stage. */
const REPORT_NARROW_PX = 899;
/**
 * Where an isolated finding organ sits in the lane between the story card and
 * the measurements panel when the lane has not been measured (first paint, and
 * where there is no layout). reportFindingPose replaces it with a pose fitted
 * to the lane once the card and the panel are on screen.
 */
const REPORT_FINDING_POSE = 'translateX(48px) scale(0.78)';
/** The biggest the isolated organ is drawn, and the smallest the lane may shrink it to. */
const REPORT_FINDING_MAX_SCALE = 0.78;
const REPORT_FINDING_MIN_SCALE = 0.3;
/** The clear space kept between the organ and the card or panel beside it. */
const REPORT_LANE_GAP_PX = 24;
/**
 * The 3D pane refits to the shown organ, and the widest one (the pancreas
 * tail) spans about this share of the pane's width at full size. Nothing in
 * the page reports an organ's drawn width, so the widest is assumed for all.
 */
const REPORT_ORGAN_MAX_WIDTH_SHARE = 0.56;
/** The refit leaves the organ this share of the pane's width left of its centre. */
const REPORT_ORGAN_CENTRE_OFFSET_SHARE = 0.024;

/**
 * The pose that centres an isolated finding organ in the lane between the
 * story card's right edge and the measurements panel's left edge, shrunk until
 * the widest organ keeps REPORT_LANE_GAP_PX clear on both sides. All inputs are
 * viewport pixels; an unmeasured lane gives the fixed REPORT_FINDING_POSE.
 */
export function reportFindingPose(laneLeft: number, laneRight: number, paneWidth: number, paneCentre: number): string {
  const lane = laneRight - laneLeft;
  if (!(lane > 0) || !(paneWidth > 0)) return REPORT_FINDING_POSE;
  const fit = (lane - 2 * REPORT_LANE_GAP_PX) / (REPORT_ORGAN_MAX_WIDTH_SHARE * paneWidth);
  const scale = Math.min(REPORT_FINDING_MAX_SCALE, Math.max(REPORT_FINDING_MIN_SCALE, fit));
  const shift = (laneLeft + laneRight) / 2 - paneCentre + scale * REPORT_ORGAN_CENTRE_OFFSET_SHARE * paneWidth;
  return `translateX(${Math.round(shift)}px) scale(${Math.floor(scale * 100) / 100})`;
}
/**
 * Where the scan goes once the story card is stacked over the stage: the pane
 * is centred in the whole viewport, so it moves down by half the card's
 * footprint (the 104px bar, the stage's 12px padding and the card's 46vh cap,
 * matching STYLES) and shrinks to sit in the strip that is left below it.
 * While a reading session records, the bar grows by the REC strip
 * (--rs-rec-h, set on the page), so the pane moves down by half of that too.
 */
const REPORT_STACKED_POSE = 'translateY(calc(58px + var(--rs-rec-h, 0px) / 2 + 23vh)) scale(0.75)';
/**
 * The 3D pane refits to the shown organs, which leaves an isolated finding
 * organ a hair left of the pane's centre (about 2% of the width, measured at
 * 375 and 768), so on the finding steps the stacked pose nudges the pane right
 * by that much to line the organ up with the centred card. The healthy-organs
 * step shows the whole scan, which is already centred, so it keeps the plain
 * pose.
 */
const REPORT_STACKED_FINDING_SHIFT = 'translateX(2vw)';
/** How long the pane takes to ease between steps, and back to rest on Exit. */
export const REPORT_PANE_MS = 450;
const PANE_EASE = 'cubic-bezier(0.22,1,0.36,1)';

/**
 * The injected rule that poses the 3D pane for a step. Only filter and
 * transform move, the poses that make room for the story panel beside the scan
 * give way below 900px to one that moves the scan under the stacked card, and
 * visitors who ask for reduced motion get the pose without the travel (the
 * global rule in index.css loses to this selector's !important, so the
 * override lives here).
 */
export function reportPaneCss(step: number, totalSteps: number, closing: boolean, findingPose: string = REPORT_FINDING_POSE): string {
  let filter = 'none';
  let transform = 'translateX(0)';
  let ms = REPORT_PANE_MS;
  if (closing) {
    transform = 'none';
  } else if (step === 0) {
    filter = 'blur(12px) brightness(0.40)';
    transform = 'scale(0.96)';
    ms = 550;
  } else if (step === 1) {
    transform = 'translateX(180px)';
  } else if (step < totalSteps - 1) {
    // An isolated finding organ can be wider than the lane between the story
    // card and the measurements panel, so it is centred in that lane and
    // shrunk to sit inside it.
    transform = findingPose;
  } else if (step === totalSteps - 1) {
    filter = 'blur(1.5px) brightness(0.55)';
    transform = 'scale(1.02)';
  }
  return (
    `${REPORT_PANE_SELECTOR} { filter: ${filter} !important; transform: ${transform} !important; ` +
    `transition: filter ${ms}ms ${PANE_EASE}, transform ${ms}ms ${PANE_EASE} !important; }\n` +
    // Below 900px the story panel stacks over the stage instead of sitting
    // beside it (see STYLES), so there is no room beside it to slide the scan
    // into and it would sit hidden behind the card. The last step has no
    // stacked card (its impression panel is centred), so it keeps its blur,
    // dim and scale as they are.
    (!closing && step > 0 && step < totalSteps - 1 ? `@media (max-width: ${REPORT_NARROW_PX}px) { ${REPORT_PANE_SELECTOR} { transform: ${step >= 2 ? `${REPORT_STACKED_FINDING_SHIFT} ` : ''}${REPORT_STACKED_POSE} !important; } }\n` : '') +
    `@media (prefers-reduced-motion: reduce) { ${REPORT_PANE_SELECTOR} { transition: none !important; } }`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Organ keys as sentence-case labels ("cbd_stent" -> "CBD stent"); a sided organ
// reads through findingLabel instead ("kidney_left" -> "Left kidney").
const labelize = filenameToName;

// "1 organ looks healthy", "3 organs look healthy": noun and verb agree. The
// no-break space keeps the count with its noun so a phone never wraps after the digit.
function organsLookHealthy(count: number): string {
  return count === 1 ? '1\u00a0organ looks healthy' : `${count}\u00a0organs look healthy`;
}

function getDetail(organ: string, comments: string): string | null {
  if (!comments) return null;
  const sentences = comments.split(/(?<=[.!?])\s+/).filter(s => s.trim());
  const root = organ.replace(/_(gland|body|tail|head|left|right)$/, '').replace(/_/g, ' ').split(' ')[0];
  const match = sentences.find(s => s.toLowerCase().includes(root.toLowerCase()));
  if (!match) return null;
  let d = match.trim().replace(/^(however|notably|additionally|furthermore|moreover|in addition),?\s+/i, '');
  if (d.length) d = d[0].toUpperCase() + d.slice(1);
  if (d.length > 210) d = d.slice(0, d.lastIndexOf(' ', 207)).trim() + '...';
  return d.endsWith('.') || d.endsWith('...') ? d : d + '.';
}


// True for "kidney_left" and "kidney_right": same organ root, opposite sides.
function areLateralTwins(a: string, b: string): boolean {
  const side = (organ: string) => organ.match(/_(left|right)$/)?.[1];
  const sa = side(a);
  const sb = side(b);
  return !!sa && !!sb && sa !== sb;
}

// The server sends this placeholder as the comments when the case has no report row.
const NO_REPORT_COMMENTS = 'Clinical comments unavailable.';

function isReportTextMissing(report: ReportData): boolean {
  const comments = typeof report.comments === 'string' ? report.comments.trim() : '';
  return (!comments || comments === NO_REPORT_COMMENTS) && !getImpressionText(report);
}

// The organs the walkthrough covers. Lesion/stent masks are excluded from the volume-based
// inclusion, but any entry the backend flags as 'check' still passes through.
function reportOrgans(report: ReportData): [string, OrganData][] {
  return Object.entries(report.organ_volumes ?? {}).filter(([o, v]) => v.status === 'check' || (!isNonOrganLabel(o) && v.volume > 5));
}

// Mask labels that are findings or hardware, not organs. They must never be
// presented in the patient-facing healthy organs list.
function isNonOrganLabel(organ: string): boolean {
  return organ.endsWith('_lesion') || organ === 'cbd_stent';
}

// Renders "Case 12" plus " · Female · 61y" only for demographics the backend
// actually has. It returns the string "N/A" for missing age/sex (despite the
// declared types), which used to render as "Case 12 · N/A · N/Ay".
function caseSummary(id: string, patient: ReportData['patient']): string {
  const parts = [`Case ${id}`];
  const sex: unknown = patient.sex;
  const age: unknown = patient.age;
  const named = formatSex(typeof sex === 'string' ? sex : null);
  if (named) parts.push(named);
  if (typeof age === 'number' && Number.isFinite(age)) parts.push(`${age}y`);
  else if (typeof age === 'string' && /^\d+(\.\d+)?$/.test(age.trim())) parts.push(`${age.trim()}y`);
  return parts.join(' · ');
}

function getReportSection(organ: string, comments: string): string | null {
  if (!comments) return null;
  const root = organRoot(organ);
  const lines = comments.split(/\r?\n/);
  const start = lines.findIndex(line => {
    const cleaned = line.trim().replace(/:$/, '').toLowerCase();
    return cleaned === root || cleaned === `${root}s` || cleaned.startsWith(`${root}:`);
  });
  if (start === -1) return getDetail(organ, comments);
  const collected: string[] = [];
  let lesionsHeadingSeen = false;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const cleanedHeading = trimmed.replace(/:$/, '').toLowerCase();
    if (i > start && cleanedHeading === `${root} lesions`) {
      lesionsHeadingSeen = true;
      continue;
    }
    if (i > start && !lesionsHeadingSeen && /^[A-Za-z][A-Za-z\s_/-]*:\s*$/.test(trimmed)) break;
    if (i > start && lesionsHeadingSeen && /^[A-Za-z][A-Za-z\s_/-]*:\s*$/.test(trimmed) && !cleanedHeading.startsWith(root)) break;
    if (i > start && /^IMPRESSION:\s*$/i.test(trimmed)) break;
    if (trimmed) collected.push(trimmed);
  }
  const text = collected.join(' ').replace(/\s+/g, ' ').trim();
  return text ? narrowSectionToLocation(organ, text) : null;
}

type ReportMeasurements = {
  section: string | null;
  volumeCc: number | null;
  lesionVolumeCc: number | null;
  organVolumeCc: number | null;
  meanHu: number | null;
  organMeanHu: number | null;
  huSd: number | null;
  sizeCm: string | null;
  lesionCount: number;
};

function getReportMeasurements(organ: string, comments: string): ReportMeasurements {
  const section = getReportSection(organ, comments);
  // Prefer the lesion's own numbers over the organ's baseline stats when a
  // lesion block is present in this section, since those matter more clinically.
  const lesionVolumeMatch = section?.match(/lesion[\s\S]*?volume:\s*([\d.]+)\s*cc/i);
  const lesionHuMatch = section?.match(/hu\s*value\s*is\s*(-?[\d.]+)(?:\s*\+\/-\s*([\d.]+))?/i);
  const volumeMatch = lesionVolumeMatch ?? section?.match(/volume:\s*([\d.]+)\s*cc/i);
  const huMatch = lesionHuMatch ?? section?.match(/Mean HU value:\s*(-?[\d.]+)(?:\s*\+\/-\s*([\d.]+))?/i);
  // BUG FIX: the size capture excluded '.' from its own character class, so it
  // could never match decimal sizes like "1.0 x 0.5 cm" — only whole numbers.
  // That silently broke "Report size" for virtually every real lesion.
  const sizeMatch = section?.match(/Size:\s*([^()]+?)\s*cm/i);

  // Organ-level baseline stats (what the report states for the whole organ,
  // e.g. "Pancreas: Normal size (volume: 9.0 cc). Mean HU value: 8.4 +/- 29.6.")
  // — deliberately NOT lesion-preferred, since the metrics card needs these
  // distinct from the lesion's own (and often much smaller, or relative-to-
  // organ) numbers. "Mean HU value:" only ever appears for the organ baseline;
  // the lesion's enhancement line reads "HU value is X", a different phrase,
  // so this regex can't accidentally pick up the lesion's number.
  const organVolumeMatch = section?.match(/volume:\s*([\d.]+)\s*cc/i);
  const organHuMatch = section?.match(/Mean HU value:\s*(-?[\d.]+)/i);

  // Each distinct lesion in a report section carries its own "Size: ... cm" line,
  // so counting those is a reasonable proxy for lesion count without the backend
  // needing to add a dedicated field.
  const sizeMatches = section?.match(/Size:\s*[^()]+?cm/gi) ?? [];
  const lesionCount = sizeMatches.length || (lesionVolumeMatch ? 1 : 0);

  return {
    section,
    volumeCc: volumeMatch ? Number(volumeMatch[1]) : null,
    lesionVolumeCc: lesionVolumeMatch ? Number(lesionVolumeMatch[1]) : null,
    organVolumeCc: organVolumeMatch ? Number(organVolumeMatch[1]) : null,
    meanHu: huMatch ? Number(huMatch[1]) : null,
    organMeanHu: organHuMatch ? Number(organHuMatch[1]) : null,
    huSd: huMatch?.[2] ? Number(huMatch[2]) : null,
    sizeCm: sizeMatch ? sizeMatch[1].trim() : null,
    lesionCount,
  };
}

// Rough qualitative size bucket from whichever number we have — used only to
// pick a plain-language adjective, not for any clinical claim.
function sizeDescriptor(volumeCc: number | null, sizeCm: string | null): string {
  let maxDim: number | null = null;
  if (sizeCm) {
    const nums = sizeCm.match(/[\d.]+/g)?.map(Number) ?? [];
    if (nums.length) maxDim = Math.max(...nums);
  }
  if (maxDim !== null) {
    if (maxDim < 1) return 'tiny';
    if (maxDim < 2) return 'small';
    if (maxDim < 5) return 'noticeable';
    return 'sizable';
  }
  if (volumeCc !== null) {
    if (volumeCc < 1) return 'tiny';
    if (volumeCc < 5) return 'small';
    if (volumeCc < 20) return 'noticeable';
    return 'sizable';
  }
  return '';
}

// Returns null (deliberately) when the text doesn't actually describe a
// lesion/mass — some organs get flagged purely on a numeric HU-range check
// with no lesion mentioned anywhere in the report text, and it previously
// defaulted to "spot" regardless, inventing a finding the text never stated.
function findingNoun(detail: string): string | null {
  const d = detail.toLowerCase();
  if (d.includes('cyst')) return 'fluid-filled spot';
  // No size word of its own: sizeDescriptor() goes in front of this noun, and
  // "a tiny small bump" or "a sizable small bump" contradicts itself.
  if (d.includes('nodule')) return 'bump';
  if (d.includes('mass') || d.includes('tumor')) return 'growth';
  // A lesion named anywhere in the text outranks the organ-state words:
  // "enlarged lymph node near the liver" is not an enlarged liver.
  if (d.includes('lesion')) return 'spot';
  if (d.includes('enlarged')) return 'enlarged area';
  if (d.includes('dilated') || d.includes('widened')) return 'widened area';
  return null;
}

function capFirst(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Turns the parsed report measurements into a real plain-language sentence
// instead of generic keyword-matched boilerplate — e.g. "The scan found a
// small spot (1.0 x 0.5 cm) in the tail of your pancreas." Falls back to an
// honest, still-specific sentence when the report text doesn't describe an
// actual lesion (e.g. flagged purely on an HU-range anomaly) — it never
// invents "a spot" or similar when none is described.
export function patientFindingText(organ: string, measurements: ReportMeasurements): string {
  const organLabel = labelize(organRoot(organ)).toLowerCase();
  const loc = organLocation(organ);
  const subject =
    loc?.type === 'lateral' ? `your ${loc.word} ${organLabel}`
    : loc?.type === 'subregion' ? `the ${loc.word} of your ${organLabel}`
    : `your ${organLabel}`;
  const detail = measurements.section || '';

  if (!detail) {
    return `The scan flagged ${subject} for your doctor to review. The report text wasn't specific enough to describe here.`;
  }

  const noun = findingNoun(detail);
  if (!noun) {
    // Flagged, but the text doesn't describe an actual lesion/mass — don't
    // invent one. Most common cause: flagged on an HU-range check, not a
    // described finding.
    return `${capFirst(subject)} was flagged for review, but the report doesn't describe a specific spot or growth. Ask your doctor what stood out.`;
  }

  // "Enlarged" and "widened" describe the organ as a whole. Putting a size word
  // in front would say an area inside it is large ("a sizable enlarged area").
  // The text may be about one part of the organ (a duct), so say what it says
  // rather than claiming the scan found the whole organ changed.
  if (noun === 'enlarged area' || noun === 'widened area') {
    const word = /enlarged/i.test(detail) ? 'enlarged' : /dilated/i.test(detail) ? 'dilated' : 'widened';
    return `The report describes ${subject} as ${word}.`;
  }

  const sizeWord = sizeDescriptor(measurements.lesionVolumeCc ?? measurements.volumeCc, measurements.sizeCm);
  // sizeCm is only the first Size entry, so it describes one lesion, not several.
  const sizePart = measurements.sizeCm && measurements.lesionCount <= 1 ? ` (${measurements.sizeCm} cm)` : '';
  const article = sizeWord ? `a ${sizeWord} ${noun}` : `a ${noun}`;
  const countPart = measurements.lesionCount > 1 ? `${measurements.lesionCount} spots` : article;

  return `The scan found ${countPart}${sizePart} in ${subject}.`;
}

// ─── Small UI pieces ──────────────────────────────────────────────────────────

const glass: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(255,255,255,0.052), rgba(255,255,255,0.024))',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 28,
  backdropFilter: 'blur(28px)',
  WebkitBackdropFilter: 'blur(28px)',
  boxShadow: '0 30px 90px rgba(0,0,0,0.36), inset 0 1px 0 rgba(255,255,255,0.07)',
};

function PrimaryButton({ children, onClick, amber = false }: { children: React.ReactNode; onClick: () => void; amber?: boolean }) {
  return (
    <button
      type="button"
      className={amber ? 'rs-primary-amber' : 'rs-primary'}
      onClick={onClick}
      style={{
        padding: '13px 22px',
        borderRadius: 999,
        border: amber ? '1px solid rgba(251,191,36,0.30)' : '1px solid rgba(255,255,255,0.16)',
        background: amber ? 'rgba(251,191,36,0.14)' : 'rgba(255,255,255,0.11)',
        color: amber ? '#fbbf24' : 'rgba(255,255,255,0.94)',
        fontSize: 15,
        fontWeight: 750,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'transform 0.22s cubic-bezier(0.22,1,0.36,1), background-color 0.22s ease, border-color 0.22s ease',
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rs-secondary"
      onClick={onClick}
      style={{
        padding: '12px 18px',
        borderRadius: 999,
        border: '1px solid rgba(255,255,255,0.12)',
        background: 'transparent',
        color: 'rgba(255,255,255,0.62)',
        fontSize: 14,
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease',
      }}
    >
      {children}
    </button>
  );
}

function StatPill({ tone, title, value, sub }: { tone: 'green' | 'amber'; title: string; value: string; sub: string }) {
  const color = tone === 'green' ? '#6ee7b7' : '#fbbf24';
  const bg = tone === 'green' ? 'rgba(110,231,183,0.08)' : 'rgba(251,191,36,0.08)';
  const border = tone === 'green' ? 'rgba(110,231,183,0.20)' : 'rgba(251,191,36,0.22)';
  return (
    <div style={{ flex: 1, minWidth: 0, padding: '15px 16px', borderRadius: 20, background: bg, border: `1px solid ${border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span aria-hidden="true" style={{ width: 22, height: 22, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: bg, color, fontWeight: 850, fontSize: 13 }}>
          {tone === 'green' ? '✓' : '!'}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.78)', fontSize: 13, fontWeight: 720 }}>{title}</span>
      </div>
      <div style={{ color, fontSize: 28, lineHeight: 1, fontWeight: 820, letterSpacing: '-0.04em' }}>{value}</div>
      <div style={{ color: 'rgba(255,255,255,0.54)', fontSize: 14, marginTop: 8 }}>{sub}</div>
    </div>
  );
}

// The stacked story card is capped at 46vh above a sticky action bar, so how
// many rows fit depends on the phone's height; the toggle sits above the list
// there so it never ends up behind the bar.
function useReportNarrow() {
  const query = `(max-width: ${REPORT_NARROW_PX}px)`;
  const [narrow, setNarrow] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const onChange = () => setNarrow(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, [query]);
  return narrow;
}

function OrganList({ organs, max = 5 }: { organs: [string, OrganData][]; max?: number }) {
  const [showAll, setShowAll] = useState(false);
  const narrow = useReportNarrow();
  const visible = showAll ? organs : organs.slice(0, max);
  const toggle = organs.length > max && (
    <button
      type="button"
      className="rs-link"
      onClick={() => setShowAll(v => !v)}
      aria-expanded={showAll}
      style={{ ...(narrow ? { marginBottom: 4 } : { marginTop: 4 }), background: 'transparent', border: 'none', padding: '8px 0', color: 'rgba(110,231,183,0.78)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
    >
      {showAll ? 'Show less' : `Show all ${organs.length} healthy organs`}
    </button>
  );
  return (
    <>
      {narrow && toggle}
      <div className="rs-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: showAll ? 220 : 'none', overflowY: showAll ? 'auto' : 'visible', paddingRight: showAll ? 6 : 0 }}>
        {visible.map(([organ], i) => (
          <div key={organ} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 16, background: 'rgba(110,231,183,0.075)', border: '1px solid rgba(110,231,183,0.17)', animation: `riseIn 0.25s ease ${i * 26}ms both` }}>
            <span aria-hidden="true" style={{ width: 21, height: 21, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(110,231,183,0.14)', color: '#6ee7b7', fontSize: 12, fontWeight: 850, flexShrink: 0 }}>✓</span>
            <span style={{ color: 'rgba(255,255,255,0.84)', fontSize: 15, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{findingLabel(organ)}</span>
          </div>
        ))}
      </div>
      {!narrow && toggle}
    </>
  );
}

function Badge({ tone, children }: { tone: 'amber' | 'green'; children: React.ReactNode }) {
  const color = tone === 'amber' ? '#fbbf24' : '#6ee7b7';
  const bg = tone === 'amber' ? 'rgba(251,191,36,0.14)' : 'rgba(110,231,183,0.12)';
  const border = tone === 'amber' ? 'rgba(251,191,36,0.32)' : 'rgba(110,231,183,0.28)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999,
      background: bg, border: `1px solid ${border}`, color, fontSize: 11, fontWeight: 820, letterSpacing: '0.05em',
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.075)' }}>
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>{label}</span>
      {/* The value never wraps (a lone unit on its own line changed the panel's
          height); the label gives way instead. */}
      <span style={{ fontSize: 15, fontWeight: 720, color: 'rgba(255,255,255,0.92)', textAlign: 'right', whiteSpace: 'nowrap', flexShrink: 0 }}>{value}</span>
    </div>
  );
}

// Structured doctor-view card: labeled metric rows, in place of dumping the
// raw report-comments string. The panel's own heading carries the review badge. Deliberately sources HU/volume
// from the report's organ-baseline numbers (report.organMeanHu/organVolumeCc)
// rather than curData — curData can be a small anatomical sub-label (e.g.
// "pancreas_tail") whose own segmented mask is tiny, which previously showed
// as a misleading "0 HU / 0 cc" even though the organ itself had real values.
function OrganMetricsCard({
  curData,
  report,
}: {
  curData: OrganData;
  report: ReportMeasurements;
}) {
  const meanHu = report.organMeanHu ?? curData.mean_hu;
  const organVolume = report.organVolumeCc ?? curData.volume;
  return (
    <div>
      <MetricLine label="Mean attenuation" value={meanHu !== null ? `${String(Math.round(meanHu * 10) / 10).replace(/^-/, '\u2212')} HU` : 'Not listed'} />
      <MetricLine label="Organ volume" value={`${organVolume.toFixed(1).replace(/\.0$/, '')} cm³`} />
      <MetricLine
        label={report.lesionCount > 1 ? 'First lesion volume' : 'Lesion volume'}
        value={report.lesionVolumeCc !== null ? `${report.lesionVolumeCc.toFixed(1).replace(/\.0$/, '')} cm³` : (report.lesionCount > 0 ? 'Not reported' : 'None detected')}
      />
      <MetricLine label="Lesion count" value={String(report.lesionCount)} />
    </div>
  );
}

function EvidencePanel({
  step,
  lang,
  flagged,
  normal,
  curOrgan,
  curData,
  data,
  anim,
}: {
  step: Step;
  lang: Lang;
  flagged: [string, OrganData][];
  normal: [string, OrganData][];
  curOrgan: string | null;
  curData: OrganData | null;
  data: ReportData;
  anim: string;
}) {
  const firstFinding = flagged[0]?.[0] ?? null;
  const firstDetail = firstFinding ? getDetail(firstFinding, data.comments) : null;
  const firstMeasurements = firstFinding ? getReportMeasurements(firstFinding, data.comments) : null;
  const impression = getImpressionText(data);
  const report = curOrgan ? getReportMeasurements(curOrgan, data.comments) : null;
  // The lesion's own volume, never the organ's baseline that volumeCc falls back to.
  // With several lesions the report lists the first one's, as the Doctor card says.
  const reportVolume = report?.lesionVolumeCc ?? null;
  const reportVolumeLabel = report && report.lesionCount > 1 ? 'First lesion volume' : 'Volume in report';
  
  if (step === 1) {
    // On the healthy-organs page, do not show the finding preview.
    // The left panel is the story; the 3D model shifts right to balance the empty space.
    return null;
  }

  if (step === 0) {
    return (
      <div style={{ ...glass, width: 330, padding: 24, animation: `${anim} 0.36s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: flagged.length ? 'rgba(251,191,36,0.72)' : 'rgba(110,231,183,0.72)', fontWeight: 800, marginBottom: 18 }}>
          {flagged.length ? 'Finding found' : 'No finding found'}
        </div>
        {flagged.length ? (
          <>
            <div style={{ fontSize: 34, lineHeight: 1.08, fontWeight: 830, letterSpacing: '-0.05em', color: '#fbbf24', marginBottom: 14 }}>
              {findingLabel(firstFinding!)}
            </div>
            <p style={{ color: 'rgba(255,255,255,0.70)', fontSize: 16, lineHeight: 1.55, margin: 0 }}>
              {lang === 'patient'
                ? patientFindingText(firstFinding!, firstMeasurements!)
                : (firstDetail || impression || 'See the report finding for details.')}
            </p>
          </>
        ) : (
          <>
            <div style={{ fontSize: 30, lineHeight: 1.1, fontWeight: 820, letterSpacing: '-0.045em', color: '#6ee7b7', marginBottom: 14 }}>
              No abnormal finding was marked.
            </div>
            <p style={{ color: 'rgba(255,255,255,0.68)', fontSize: 16, lineHeight: 1.55, margin: 0 }}>
              The report did not mark any organ for review.
            </p>
          </>
        )}
        <div style={{ marginTop: 22, paddingTop: 18, borderTop: '1px solid rgba(255,255,255,0.075)', color: 'rgba(255,255,255,0.46)', fontSize: 13, lineHeight: 1.5 }}>
          {normal.length} healthy organ{normal.length === 1 ? '' : 's'} · {flagged.length} finding{flagged.length === 1 ? '' : 's'}
        </div>
      </div>
    );
  }

  if (step >= 2 && curOrgan && curData) {
    return (
      <div style={{ ...glass, width: 350, padding: 24, animation: `${anim} 0.36s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(251,191,36,0.72)', fontWeight: 800 }}>
            Measurements
          </div>
          {lang === 'clinical' && curData.status === 'check' && <Badge tone="amber">Needs review</Badge>}
        </div>

        {lang === 'clinical' && report && (
          <OrganMetricsCard curData={curData} report={report} />
        )}

        {lang === 'clinical' && report?.sizeCm && (
          <MetricLine label={report.lesionCount > 1 ? 'First lesion size' : 'Size in report'} value={`${report.sizeCm} cm`} />
        )}

        {lang === 'clinical' && curData.dimensions && !report?.sizeCm && (
          <MetricLine
            label="Segmented size"
            value={`${curData.dimensions.map((d) => d.toFixed(1)).join(' × ')} cm`}
          />
        )}

        {/* Full report-text paragraph deliberately omitted here — it's the exact
            same string already shown in the left story panel (medLocal), so
            showing it again just duplicated the same paragraph on screen. */}

        {/* The story card already says to ask the doctor, so this panel only
            describes itself, and only has something to say when a volume is shown. */}
        {lang === 'patient' && (
          reportVolume !== null ? (
            <>
              <MetricLine label={reportVolumeLabel} value={`${reportVolume.toFixed(1).replace(/\.0$/, '')} cm³`} />
              <p style={{ color: 'rgba(255,255,255,0.58)', fontSize: 14, lineHeight: 1.55, margin: '18px 0 0', textWrap: 'pretty' }}>
                This is the key measurement from the report.
              </p>
            </>
          ) : (
            <p style={{ color: 'rgba(255,255,255,0.58)', fontSize: 14, lineHeight: 1.55, margin: 0, textWrap: 'pretty' }}>
              No measurement was listed in the report for this finding.
            </p>
          )
        )}
      </div>
    );
  }

  return (
    <div style={{ ...glass, width: 330, padding: 24, animation: `${anim} 0.36s cubic-bezier(0.22,1,0.36,1) both` }}>
      <div style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.44)', fontWeight: 800, marginBottom: 18 }}>
        Final note
      </div>
      <p style={{ color: 'rgba(255,255,255,0.72)', fontSize: 16, lineHeight: 1.6, margin: 0 }}>
        Bring this result to your doctor. They can interpret the finding with your symptoms, history, and any other tests.
      </p>
    </div>
  );
}

const COACH_CARD_W = 330;

/**
 * Where the Patient/Doctor coachmark sits: its card right-aligned to the
 * top bar's actions, just under the toggle, with the arrow's tip centred on
 * the toggle. The bar wraps and reflows across widths, so the toggle is
 * measured instead of guessed. Returns CSS variables for `.rs-coach`.
 */
function useCoachAnchor(
  open: boolean,
  toggleRef: React.RefObject<HTMLElement | null>,
  actionsRef: React.RefObject<HTMLElement | null>,
): React.CSSProperties {
  const [vars, setVars] = useState<Record<string, string>>({});
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const toggle = toggleRef.current?.getBoundingClientRect();
      const actions = actionsRef.current?.getBoundingClientRect();
      if (!toggle || !actions || !toggle.width) return;
      const cardLeft = actions.right - COACH_CARD_W;
      const arrowX = Math.min(COACH_CARD_W - 24, Math.max(24, toggle.left + toggle.width / 2 - cardLeft));
      setVars({
        '--rs-coach-top': `${Math.round(toggle.bottom + 10)}px`,
        '--rs-coach-right': `${Math.round(window.innerWidth - actions.right)}px`,
        '--rs-coach-arrow-x': `${Math.round(arrowX)}px`,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, toggleRef, actionsRef]);
  return vars as React.CSSProperties;
}

const COPY_FAILED_NOTE = "Couldn't copy the link. Select it and copy it yourself.";
const SHARE_FAILED_NOTE = "Couldn't create a link. Try again.";

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReportScreen({ id, onClose, onViewChange, onOrganHighlight, onClearHighlight, onHideOrgans, recording = false }: Props) {
  void onViewChange;
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>(0);
  const [dir, setDir] = useState<'r' | 'l'>('r');
  const [lang, setLang] = useState<Lang>('patient');
  const [modePromptOpen, setModePromptOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const shareLinkRef = useRef<HTMLInputElement>(null);
  const shareBtnRef = useRef<HTMLButtonElement>(null);
  const shareCopyBtnRef = useRef<HTMLButtonElement>(null);
  const shareRetryBtnRef = useRef<HTMLButtonElement>(null);
  // Set when a retry succeeds while Try again holds focus; see the effect below.
  const refocusCopyRef = useRef(false);
  const [shareFailed, setShareFailed] = useState(false);
  // De-identified share link, minted on demand (see mintShareLink below) —
  // this used to be a raw `${API_ORIGIN}/api/report/${id}` string built
  // straight from the real case id. That exposed the real id in the URL and
  // skipped the token system the rest of the app now uses for sharing.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  // Exit first eases the 3D pane back to rest, then unmounts. While closing,
  // only the pane rule stays mounted (the report chrome is already gone).
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const startRef = useRef(Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const storyRef = useRef<HTMLDivElement>(null);
  const evidenceRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<HTMLDivElement>(null);
  const shownStepRef = useRef<Step>(0);
  const coachVars = useCoachAnchor(modePromptOpen && step > 0, toggleRef, actionsRef);

  // The report covers the viewer, so keyboard focus belongs inside it: it
  // moves in on open, Tab stays inside, and it returns to the Report button
  // on exit. Escape is handled below (it closes the innermost layer first).
  // Focus starts on the dialog itself: the loading overlay's Exit button is gone
  // by the time the report is ready, which would drop focus on <body>.
  // While a reading session records, its REC pill stays on screen above the
  // report (ReadingSession.css) but lives in the viewer toolbar, outside this
  // root. Its buttons join the Tab ring so Stop and the key image button are
  // reachable, and aria-modal is dropped below so the pill is not hidden from
  // assistive tech while the microphone is live.
  useDialogFocus(true, rootRef, {
    lockScroll: false,
    initialFocus: rootRef,
    extraRing: () => Array.from(document.querySelectorAll<HTMLElement>('.VisualizationPage.report-open .vp-rec button')),
  });

  const requestClose = useCallback(() => {
    if (closeTimerRef.current !== null) return;
    if (prefersReducedMotion()) {
      onClose();
      return;
    }
    setClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, REPORT_PANE_MS);
  }, [onClose]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  // Bumped by Try again to ask for the report once more.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const failedCloseRef = useRef<HTMLButtonElement>(null);
  const loadingExitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void prefetchReportData(id).then((report) => {
      if (!active) return;
      if (report) {
        setData(report);
        startRef.current = Date.now();
      }
      setLoading(false);
    });
    return () => { active = false; };
  }, [id, loadAttempt]);

  // The loading screen's Exit button unmounts when the request fails, which
  // would leave focus on the dialog root with nothing announced. Move it to
  // the way out (its message is a role="alert").
  useEffect(() => {
    if (!closing && !loading && !data) failedCloseRef.current?.focus({ preventScroll: true });
  }, [closing, loading, data]);

  // Try again unmounts the focused button for the loading overlay: hand focus
  // to its Exit button so a keyboard reader keeps their place.
  useEffect(() => {
    if (loadAttempt > 0 && loading && !closing) loadingExitRef.current?.focus({ preventScroll: true });
  }, [loadAttempt, loading, closing]);

  // Reset any previously-minted link when the case changes, so a stale
  // token for a different case can never be shown/copied.
  useEffect(() => {
    setShareUrl(null);
    setShareFailed(false);
  }, [id]);

  // Mints (or re-derives — the backend token is deterministic per case id)
  // an opaque share token and builds the link to the new de-identified
  // /share/:token card. Safe to call repeatedly; no-ops if already minted
  // or in flight.
  const mintShareLink = useCallback(async () => {
    if (shareUrl || shareLoading) return;
    setShareLoading(true);
    try {
      const r = await fetch(`${APP_CONSTANTS.API_ORIGIN}/api/share/${id}/token`, { method: 'POST' });
      if (!r.ok) throw new Error(`Share token request failed with status ${r.status}`);
      const j = await r.json();
      const token = typeof j.url === 'string' ? j.url.split('/').pop() : null;
      if (!token) throw new Error('Share token response had no link');
      refocusCopyRef.current = !!shareRetryBtnRef.current && document.activeElement === shareRetryBtnRef.current;
      setShareUrl(`${window.location.origin}${appRootRelativeUrl(`/share/${token}`)}`);
      setShareFailed(false);
    } catch (e) {
      console.error('Failed to create share link:', e);
      setShareFailed(true);
    } finally {
      setShareLoading(false);
    }
  }, [id, shareUrl, shareLoading]);

  // A successful retry unmounts the focused Try again button, which would drop
  // focus to <body>. Hand it to the Copy button, which is now enabled.
  useEffect(() => {
    if (!shareUrl || !refocusCopyRef.current) return;
    refocusCopyRef.current = false;
    shareCopyBtnRef.current?.focus({ preventScroll: true });
  }, [shareUrl]);

  // A failed copy note belongs to one opening of the popover, so it is cleared on close.
  useEffect(() => {
    if (!shareOpen) setCopyFailed(false);
  }, [shareOpen]);

  // Closing the popover unmounts whatever inside it had focus, which drops focus
  // to <body>. When focus was inside, hand it back to the Share button.
  const closeShare = useCallback(() => {
    const inside = !!document.getElementById('rs-share-popover')?.contains(document.activeElement);
    setShareOpen(false);
    if (inside) shareBtnRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!shareOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeShare(); };
    const onClick = () => closeShare();
    document.addEventListener('keydown', onKey);
    // Deferred so the same click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('click', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      clearTimeout(t);
    };
  }, [shareOpen, closeShare]);

  // Escape closes the topmost layer first: the Patient/Doctor coachmark if
  // open, else the share popover, else it exits the report. Registered on the
  // capture phase (same pattern as ToolWalkthrough) so it wins over the
  // viewer's global shortcut listeners while the report overlay is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (modePromptOpen) { setModePromptOpen(false); return; }
      if (shareOpen) { closeShare(); return; }
      requestClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modePromptOpen, shareOpen, requestClose, closeShare]);

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Copy failed:', e);
      // No clipboard here (plain http, some in-app browsers): select the link so
      // the reader can copy it by hand.
      setCopyFailed(true);
      shareLinkRef.current?.focus();
      shareLinkRef.current?.select();
    }
  };

  const go = useCallback((s: Step) => {
    // Any step navigation dismisses the Patient/Doctor coachmark, so a user
    // who advances via Back / Explain finding / the timeline is never left
    // under the darkened blur veil. The Start-walkthrough handlers call
    // setModePromptOpen(true) AFTER go(1), so the coachmark still opens.
    setModePromptOpen(false);
    // Clicking the step already showing (its pip or timeline node) changes
    // nothing, so the slide direction stays put too. Flipping it would
    // replay the evidence card's entrance from the other side.
    if (s === step) return;
    setDir(s > step ? 'r' : 'l');
    setStep(s);
  }, [step]);

  // Lesion/stent masks are excluded from the volume-based inclusion so they
  // can never appear in the healthy list ("Pancreatic Lesion" is not a healthy
  // organ), but any entry the backend flags as 'check' still passes through so
  // a flagged lesion is not silently dropped from the findings steps.
  const all = React.useMemo(() => data ? reportOrgans(data) : [], [data]);
  // Walked through in the same reading order the findings timeline shows, so
  // the highlighted dot always moves left to right as "Finding N of M" counts up.
  const flaggedSorted = React.useMemo(() => {
    const flaggedRaw = all.filter(([_, v]) => v.status === 'check');
    const order = sortByReadingOrder(flaggedRaw.map(([o]) => ({ organ: o, status: 'check' as const })), data?.comments ?? '').map(n => n.organ);
    return order.map(o => flaggedRaw.find(([f]) => f === o)!);
  }, [all, data]);
  // The server flags the whole organ and its sub-region for one lesion
  // ("pancreas" and "pancreas_tail"), so the bare organ is dropped when a
  // sub-region of it is flagged. Left and right twins stay: they are two organs.
  const flagged = React.useMemo(
    () => flaggedSorted.filter(([o]) => organLocation(o) !== null || !flaggedSorted.some(([f]) => organRoot(f) === organRoot(o) && organLocation(f)?.type === 'subregion')),
    [flaggedSorted],
  );
  // A parent organ (or sibling sub-part) is not listed as healthy while one of
  // its parts is a finding, e.g. "Pancreas" is not a healthy organ on step 1
  // when "Pancreas Body" is presented as the finding on step 2.
  // A left or right twin is its own organ, though: a flagged left kidney does
  // not hide a healthy right kidney.
  // The server also lists a pancreas sub-region (head, body, tail) next to the
  // whole pancreas, so a sub-region is not counted or listed as a second organ
  // while its bare parent is already in the list.
  const normal = React.useMemo(() => {
    const healthy = all.filter(([o, v]) => v.status !== 'check' && !flagged.some(([f]) => organRoot(f) === organRoot(o) && !areLateralTwins(f, o)));
    return healthy.filter(([o]) => organLocation(o)?.type !== 'subregion' || !healthy.some(([p]) => p === organRoot(o)));
  }, [all, flagged]);
  const totalSteps = 2 + flagged.length + 1;

  // The pips and timeline nodes keep keyboard focus, so a step change from them
  // is spoken here: the heading a screen reader would otherwise only hear when
  // Next, Back or Explain moved focus to it.
  const [stepAnnouncement, setStepAnnouncement] = useState('');
  const announcedStepRef = useRef<Step>(0);
  useEffect(() => {
    if (announcedStepRef.current === step) return;
    announcedStepRef.current = step;
    const organ = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
    setStepAnnouncement(
      step === 0 ? 'CT scan review'
        : step === 1 ? 'Healthy organs'
        : organ ? `Finding ${step - 1} of ${flagged.length}: ${findingLabel(organ)}`
        : 'Final impressions',
    );
  }, [step]);

  const curOrganName = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
  const curOrganData = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
  const anim = dir === 'r' ? 'slideR' : 'slideL';

  // Below 900px the stage scrolls, and the evidence panel starts a screen down.
  // A new step starts back at the top, so it never opens with its story card
  // and Back and Next bar scrolled out of view. The story card is its own
  // scroller and survives across steps, so it is reset the same way.
  useEffect(() => {
    if (stageRef.current) stageRef.current.scrollTop = 0;
    if (storyRef.current) storyRef.current.scrollTop = 0;
  }, [step]);

  // Each step's card is a fresh node, so the button that was just pressed is
  // destroyed and focus drops to <body>. Put it on the new step's heading, so
  // the next Tab lands on that card's Back / Next buttons and a screen reader
  // reads the new step. Focus that is somewhere else on purpose (a timeline
  // node) stays where it is.
  useEffect(() => {
    if (shownStepRef.current === step) return;
    shownStepRef.current = step;
    // While the Patient / Doctor coachmark is up, focus goes to the toggle it points at (below).
    if (modePromptOpen) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    stepRef.current?.querySelector<HTMLElement>('h1')?.focus({ preventScroll: true });
  }, [step]);

  // The coachmark's question is read with the toggle button that takes focus
  // here, so a keyboard or screen-reader user lands on the control it describes.
  useEffect(() => {
    if (!modePromptOpen || step === 0) return;
    toggleRef.current?.querySelector<HTMLElement>('button[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [modePromptOpen, step]);
  const jumpToEvidence = useCallback(() => {
    evidenceRef.current?.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    if (!data) return;
    onClearHighlight?.();
    if (step === 1) {
      // Every flagged organ is hidden, including the bare organ the findings
      // list folded into its sub-region: it is a separate mesh in the viewer.
      onHideOrgans?.(flaggedSorted.map(([o]) => o));
    } else if (step >= 2 && step < 2 + flagged.length) {
      const highlightName = curOrganName === 'pancreas' ? 'pancreas_body' : curOrganName;
      if (highlightName && curOrganData) onOrganHighlight?.(highlightName, curOrganData.centroid_mm);
    }
  }, [step, data]);

  // Each step's wrapper is keyed by step, so its slide-in replays on every
  // step change. Unkeyed, React reused the same node between two findings
  // (same animation name, same element) and the text swapped with no motion.
  const leftContent = React.useMemo(() => {
    if (!data) return null;
    const curOrganLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
    const curDataLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
    const medLocal = curOrganLocal ? getReportSection(curOrganLocal, data.comments) : null;
    const measurementsLocal = curOrganLocal ? getReportMeasurements(curOrganLocal, data.comments) : null;
    const patientLocal = curOrganLocal && measurementsLocal ? patientFindingText(curOrganLocal, measurementsLocal) : '';
    const impressionText = getImpressionText(data);

    if (step === 0) return (
      <div key={step} ref={stepRef} style={{ animation: `${anim} 0.38s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ fontSize: 12, letterSpacing: '0.13em', color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>CT scan review</div>
        <h1 tabIndex={-1} style={{ fontSize: 46, lineHeight: 1.02, letterSpacing: '-0.02em', color: '#fff', margin: '0 0 18px', fontWeight: 700, textWrap: 'balance' }}>
          Your scan looks mostly healthy.
        </h1>
        <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.68)', lineHeight: 1.55, margin: '0 0 26px' }}>
          We found {normal.length} healthy organ{normal.length === 1 ? '' : 's'} and {flagged.length} finding{flagged.length === 1 ? '' : 's'} to explain.
        </p>
        <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
          <StatPill tone="green" title="Healthy" value={`${normal.length}`} sub={`organ${normal.length === 1 ? '' : 's'}`} />
          <StatPill tone="amber" title="Finding" value={`${flagged.length}`} sub={flagged.length === 1 ? 'to explain' : 'to explain'} />
        </div>
        <PrimaryButton onClick={() => { go(1); setModePromptOpen(true); }}>Start review <span aria-hidden="true">→</span></PrimaryButton>
      </div>
    );

    if (step === 1) return (
      <div key={step} ref={stepRef} style={{ animation: `${anim} 0.38s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ fontSize: 12, letterSpacing: '0.13em', color: 'rgba(110,231,183,0.72)', textTransform: 'uppercase', marginBottom: 16, fontWeight: 800 }}>Healthy organs</div>
        <h1 tabIndex={-1} className="rs-healthy-title" style={{ lineHeight: 1.05, letterSpacing: '-0.02em', color: '#6ee7b7', margin: '0 0 14px', fontWeight: 700, textWrap: 'balance' }}>
          {organsLookHealthy(normal.length)}.
        </h1>
        <p className="rs-healthy-intro" style={{ color: 'rgba(255,255,255,0.66)', lineHeight: 1.5, margin: '0 0 20px', textWrap: 'pretty' }}>
          {normal.length === 1 ? 'This organ looked' : 'These organs looked'} healthy on this scan.
        </p>
        <OrganList organs={normal} />
        <div className="rs-story-actions" style={{ display: 'flex', gap: 10, paddingTop: 24 }}>
          <SecondaryButton onClick={() => go(0)}><span aria-hidden="true">←</span> Back</SecondaryButton>
          <PrimaryButton amber={flagged.length > 0} onClick={() => go(flagged.length > 0 ? 2 : totalSteps - 1)}>
            {flagged.length > 0 ? <>Explain finding <span aria-hidden="true">→</span></> : <>Next <span aria-hidden="true">→</span></>}
          </PrimaryButton>
        </div>
      </div>
    );

    if (step >= 2 && step < 2 + flagged.length && curOrganLocal && curDataLocal) return (
      <div key={step} ref={stepRef} style={{ animation: `${anim} 0.38s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ fontSize: 12, letterSpacing: '0.13em', color: 'rgba(251,191,36,0.74)', textTransform: 'uppercase', marginBottom: 16, fontWeight: 800 }}>
          Finding {step - 1} of {flagged.length}
        </div>
        <h1 tabIndex={-1} style={{ fontSize: 44, lineHeight: 1.02, letterSpacing: '-0.02em', color: '#fbbf24', margin: '0 0 16px', fontWeight: 700, textWrap: 'balance' }}>
          {findingLabel(curOrganLocal)}
        </h1>
        {/* Only shown where the panels stack: the evidence panel is a screen
            down there, and the empty part of the stage passes touches to the scan. It sits above the
            copy so a card that scrolls never hides it. */}
        <button
          type="button"
          className="rs-primary-amber rs-jump"
          onClick={jumpToEvidence}
          style={{ margin: '0 0 16px', padding: '9px 16px', minHeight: 40, borderRadius: 999, border: '1px solid rgba(251,191,36,0.30)', background: 'rgba(251,191,36,0.14)', color: '#fbbf24', fontSize: 14, fontWeight: 720, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          View measurements <span aria-hidden="true">↓</span>
        </button>
        <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.78)', lineHeight: 1.56, margin: '0 0 18px', textWrap: 'pretty' }}>
          {lang === 'patient' ? patientLocal : (medLocal || impressionText || 'The report has no written detail for this finding.')}
        </p>
        {lang === 'patient' && (
          <p className="rs-story-last" style={{ fontSize: 15, color: 'rgba(255,255,255,0.50)', lineHeight: 1.55, margin: '0 0 22px', textWrap: 'pretty' }}>
            Your doctor can explain what this means with your symptoms and medical history.
          </p>
        )}
        {lang === 'clinical' && (
          <p className="rs-story-last" style={{ fontSize: 14, color: 'rgba(255,255,255,0.48)', lineHeight: 1.55, margin: '0 0 22px', textWrap: 'pretty' }}>
            Measurements are in the panel{' '}
            <span className="rs-where-wide">on the right</span>
            <span className="rs-where-narrow">below</span>.
          </p>
        )}
        <div className="rs-story-actions" style={{ display: 'flex', gap: 10 }}>
          <SecondaryButton onClick={() => go(step - 1)}><span aria-hidden="true">←</span> Back</SecondaryButton>
          <PrimaryButton onClick={() => go(step + 1)} amber={step < 1 + flagged.length}>
            {step < 1 + flagged.length ? <>Next finding <span aria-hidden="true">→</span></> : <>Finish <span aria-hidden="true">→</span></>}
          </PrimaryButton>
        </div>
      </div>
    );

    const allClear = flagged.length === 0;
    return (
      <div key={step} ref={stepRef} style={{ animation: `${anim} 0.42s cubic-bezier(0.22,1,0.36,1) both`, textAlign: 'center' }}>
        <div style={{ fontSize: 12, letterSpacing: '0.14em', color: allClear ? 'rgba(110,231,183,0.72)' : 'rgba(255,255,255,0.62)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>Final impressions</div>
        <h1 tabIndex={-1} className="rs-final-title" style={{ lineHeight: 1.02, letterSpacing: '-0.02em', color: allClear ? '#6ee7b7' : '#fff', margin: '0 0 20px', fontWeight: 700, textWrap: 'balance' }}>
          {allClear ? 'All clear.' : `${flagged.length} ${flagged.length === 1 ? 'finding' : 'findings'} to review.`}
        </h1>
        {impressionText && (
          <div style={{ padding: '20px 22px', borderRadius: 22, background: allClear ? 'rgba(110,231,183,0.075)' : 'rgba(251,191,36,0.075)', border: `1px solid ${allClear ? 'rgba(110,231,183,0.18)' : 'rgba(251,191,36,0.18)'}`, margin: '0 0 22px', textAlign: 'left' }}>
            <div style={{ fontSize: 12, color: allClear ? 'rgba(110,231,183,0.72)' : 'rgba(251,191,36,0.72)', marginBottom: 10, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 780 }}>Report impression</div>
            <p className="rs-final-impression" style={{ color: 'rgba(255,255,255,0.90)', lineHeight: 1.45, margin: 0, fontWeight: 650 }}>
              {impressionText}
            </p>
          </div>
        )}
        <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, margin: '0 auto 26px', maxWidth: 430 }}>
          {lang === 'patient'
            ? 'Final note: discuss this report with your doctor so they can interpret it with your symptoms, history, and other tests.'
            : 'Final note: these findings come from an automated analysis, so confirm them against the source images and the full report.'}
        </p>
        <div className="rs-story-actions" style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <SecondaryButton onClick={() => go(step - 1)}><span aria-hidden="true">←</span> Back</SecondaryButton>
          <PrimaryButton onClick={() => go(0)}>Start over</PrimaryButton>
        </div>
      </div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, lang, data]);

  // The lane the isolated organ sits in is measured off the story card and the
  // measurements panel, which move with the viewport width and the panel's
  // content, so the organ is fitted to it instead of to a fixed offset.
  const [findingPose, setFindingPose] = useState(REPORT_FINDING_POSE);
  useLayoutEffect(() => {
    if (closing || step < 2 || step >= totalSteps - 1) return;
    const measure = () => {
      const story = storyRef.current?.getBoundingClientRect();
      const evidence = evidenceRef.current?.getBoundingClientRect();
      // Below 900px the panels stack, and the pane has its own stacked pose.
      if (!story || !evidence || window.innerWidth <= REPORT_NARROW_PX) return;
      const pane = document.querySelector<HTMLElement>(REPORT_PANE_SELECTOR);
      setFindingPose(reportFindingPose(story.right, evidence.left, pane?.offsetWidth || window.innerWidth, window.innerWidth / 2));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [closing, step, totalSteps, lang, data]);
  const paneCss = reportPaneCss(step, totalSteps, closing, findingPose);

  return (
    <div
      ref={rootRef}
      className="rs-root"
      role="dialog"
      aria-modal={recording ? undefined : true}
      aria-label="CT scan report"
      style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none', outline: 'none' }}
    >
      <style>{STYLES}</style>
      <style>{paneCss}</style>
      <div role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 }}>{stepAnnouncement}</div>

      {!closing && !loading && !data && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <p role="alert" style={{ color: 'rgba(255,255,255,0.72)', fontSize: 14, margin: 0 }}>Report unavailable.</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" className="rs-exit" onClick={() => setLoadAttempt(n => n + 1)} style={{ fontSize: 12, background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.78)', borderRadius: 12, padding: '10px 22px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.04em' }}>Try again</button>
            <button type="button" ref={failedCloseRef} className="rs-exit" onClick={requestClose} style={{ fontSize: 12, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.24)', color: 'rgba(255,255,255,0.8)', borderRadius: 12, padding: '10px 22px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.04em' }}>Close</button>
          </div>
        </div>
      )}

      {!closing && loading && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
            <div aria-hidden="true" style={{ position: 'relative', width: 48, height: 48 }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.06)' }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid transparent', borderTop: '1.5px solid rgba(255,255,255,0.55)', animation: 'spin 1s linear infinite' }} />
              <div style={{ position: 'absolute', inset: 8, borderRadius: '50%', border: '1px solid transparent', borderTop: '1px solid rgba(255,255,255,0.2)', animation: 'spin 1.6s linear infinite reverse' }} />
            </div>
            <span role="status" style={{ fontSize: 12, color: 'rgba(255,255,255,0.62)', letterSpacing: '0.06em' }}>Preparing your report…</span>
            {/* The top bar only renders once the data is here, so a touch reader
                needs their own way out of a slow request. */}
            <button type="button" ref={loadingExitRef} className="rs-exit" onClick={requestClose} style={{ fontSize: 12, background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', color: 'rgba(255,255,255,0.78)', borderRadius: 12, padding: '10px 22px', minHeight: 44, cursor: 'pointer', fontFamily: 'inherit', letterSpacing: '0.04em' }}>Exit</button>
          </div>
        </div>
      )}

      {!closing && !loading && data && (
        <>
          {/* soft stage lighting behind the scan */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'none', background: 'radial-gradient(circle at 52% 50%, rgba(255,255,255,0.055), transparent 34%)' }} />

          {/* Top bar */}
          <div className={`rs-topbar${step === 0 ? ' rs-topbar--cover' : ''}`} style={{ zIndex: modePromptOpen ? 10006 : 10002, pointerEvents: 'auto', background: 'rgba(6,8,12,0.88)', backdropFilter: 'blur(22px)', WebkitBackdropFilter: 'blur(22px)', borderBottom: '0.5px solid rgba(255,255,255,0.08)' }}>
            <div className="rs-topbar-brand">
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.62)', letterSpacing: '0.12em', textTransform: 'uppercase', fontWeight: 760 }}>BodyMaps</span>
              <span aria-hidden="true" style={{ color: 'rgba(255,255,255,0.16)', fontSize: 11 }}>·</span>
              <span className="rs-case" style={{ fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>{caseSummary(id, data.patient)}</span>
            </div>

            <div className="rs-topbar-title">
              <span style={{ fontSize: 15, color: 'rgba(255,255,255,0.92)', letterSpacing: '0.025em', fontWeight: 720 }}>
                {step === 0 ? 'Your CT scan' : 'Understanding your CT scan'}
              </span>
              {step === 0 ? (
                // The cover has no steps, but the row is kept at the height the
                // pips take so the title and buttons stay put when step 1 arrives.
                // Only the wrapped bar below 980px needs it; the centred title
                // would sit off the buttons' midline with it.
                <div className="rs-topbar-spacer" aria-hidden="true" style={{ height: 14 }} />
              ) : (
                // Fixed-size pips: the bar inside scales with transform instead
                // of animating width, so moving between steps never relayouts.
                // The 32px-tall buttons are pulled back by their margin so the
                // row keeps the height of the 14px it used to be.
                <div role="group" aria-label="Report steps" className="rs-topbar-pips" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {Array.from({ length: totalSteps - 1 }).map((_, i) => {
                    const progressIndex = i + 1;
                    const current = progressIndex === step;
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => go(progressIndex)}
                        aria-label={`Step ${progressIndex} of ${totalSteps - 1}`}
                        aria-current={current ? 'step' : undefined}
                        style={{ width: 24, height: 32, margin: '-9px 0', border: 'none', cursor: 'pointer', padding: 0, background: 'transparent', display: 'flex', alignItems: 'center' }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            display: 'block',
                            width: '100%',
                            height: 3,
                            borderRadius: 999,
                            background: progressIndex <= step ? '#fbbf24' : 'rgba(255,255,255,0.18)',
                            opacity: progressIndex < step ? 0.42 : 1,
                            transform: current ? 'scaleX(1)' : 'scaleX(0.45)',
                            transition: 'transform 0.35s cubic-bezier(0.22,1,0.36,1), opacity 0.35s ease',
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div ref={actionsRef} className="rs-topbar-actions">
              {step > 0 && (
                <div ref={toggleRef} role="group" aria-label="Explain the report for" style={{ display: 'flex', alignItems: 'center', padding: 3, borderRadius: 999, background: modePromptOpen ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.055)', border: modePromptOpen ? '1px solid rgba(255,255,255,0.32)' : '1px solid rgba(255,255,255,0.10)', boxShadow: modePromptOpen ? '0 0 0 6px rgba(255,255,255,0.06), 0 18px 60px rgba(0,0,0,0.42)' : 'none', transition: 'background-color 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease' }}>
                  <button type="button" className="rs-toggle" aria-pressed={lang === 'patient'} aria-describedby={modePromptOpen ? 'rs-coach-text' : undefined} onClick={() => { setLang('patient'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'patient' ? '#08090b' : 'rgba(255,255,255,0.7)', background: lang === 'patient' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'background-color 0.2s ease, color 0.2s ease' }}>Patient</button>
                  <button type="button" className="rs-toggle" aria-pressed={lang === 'clinical'} aria-describedby={modePromptOpen ? 'rs-coach-text' : undefined} onClick={() => { setLang('clinical'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'clinical' ? '#08090b' : 'rgba(255,255,255,0.7)', background: lang === 'clinical' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'background-color 0.2s ease, color 0.2s ease' }}>Doctor</button>
                </div>
              )}
              <div style={{ position: 'relative' }}>
                <button
                  ref={shareBtnRef}
                  type="button"
                  className="rs-icon-btn"
                  onClick={() => { setModePromptOpen(false); setShareOpen((v) => !v); mintShareLink(); }}
                  aria-expanded={shareOpen}
                  aria-controls="rs-share-popover"
                  aria-label="Share report"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: shareOpen ? 'rgba(255,255,255,0.10)' : 'transparent',
                    border: '1px solid rgba(255,255,255,0.16)',
                    borderRadius: 12,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    color: 'rgba(255,255,255,0.78)',
                    transition: 'background-color 0.2s ease',
                  }}
                >
                  <IconShare size={14} aria-hidden="true" />
                  <span className="rs-btn-label" style={{ fontSize: 11, letterSpacing: '0.04em' }}>Share report</span>
                </button>

                {shareOpen && (
                  <div
                    id="rs-share-popover"
                    className="rs-share-pop"
                    onClick={(e) => e.stopPropagation()}
                    style={{
                    zIndex: 20000,
                    background: '#141518', border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 14, padding: 16, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
                  }}>
                    <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.86)', lineHeight: 1.5, marginBottom: 12 }}>
                      Share this link with anyone who needs it, such as a family member or your doctor. It opens a
                      de-identified, readable summary of this scan.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        ref={shareLinkRef}
                        type="text"
                        readOnly
                        aria-label="Share link"
                        value={shareLoading ? 'Generating link…' : (shareUrl || 'Link unavailable')}
                        onFocus={(e) => e.currentTarget.select()}
                        style={{
                          flex: 1, minWidth: 0, boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                          borderRadius: 10, padding: '8px 10px', fontSize: 12, fontFamily: 'inherit', color: 'rgba(255,255,255,0.72)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      />
                      <button
                        ref={shareCopyBtnRef}
                        type="button"
                        onClick={handleCopyShareLink}
                        disabled={!shareUrl}
                        style={{
                          flexShrink: 0,
                          background: copied ? 'rgba(52,199,89,0.18)' : 'rgba(255,255,255,0.10)',
                          border: `1px solid ${copied ? 'rgba(52,199,89,0.4)' : 'rgba(255,255,255,0.16)'}`,
                          borderRadius: 10, padding: '8px 12px', cursor: shareUrl ? 'pointer' : 'not-allowed',
                          opacity: shareUrl ? 1 : 0.5,
                          fontFamily: 'inherit',
                          fontSize: 12, fontWeight: 700, color: copied ? '#34c759' : 'rgba(255,255,255,0.86)',
                          transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease',
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                      <span className="sr-only" role="status">{copied ? 'Link copied' : copyFailed ? COPY_FAILED_NOTE : shareFailed && !shareLoading ? SHARE_FAILED_NOTE : ''}</span>
                    </div>
                    {/* The retry row stays mounted while a retry runs, so the focused Try again button keeps focus. */}
                    {shareFailed && !shareUrl && (
                      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, lineHeight: 1.45, color: 'rgba(251,191,36,0.92)' }}>
                        <span aria-hidden="true">{shareLoading ? 'Generating link…' : "Couldn't create a link."}</span>
                        <button
                          ref={shareRetryBtnRef}
                          type="button"
                          onClick={mintShareLink}
                          aria-disabled={shareLoading || undefined}
                          style={{ flexShrink: 0, background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 10, padding: '6px 10px', cursor: shareLoading ? 'progress' : 'pointer', opacity: shareLoading ? 0.6 : 1, fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.86)' }}
                        >
                          Try again
                        </button>
                      </div>
                    )}
                    {copyFailed && (
                      <div aria-hidden="true" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.45, color: 'rgba(251,191,36,0.92)' }}>
                        {COPY_FAILED_NOTE}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <button type="button" className="rs-icon-btn rs-exit" aria-label="Exit" onClick={requestClose} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', color: 'rgba(255,255,255,0.78)', transition: 'background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease' }}>
                <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1, fontWeight: 300 }}>✕</span>
                <span className="rs-btn-label" style={{ fontSize: 11, letterSpacing: '0.04em' }}>Exit</span>
              </button>
            </div>
          </div>

          {/* Intro: cinematic centered card */}
          {step === 0 && (
            <div style={{
              position: 'fixed',
              inset: 'var(--rs-bar-h) 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
            }}>
              <div ref={stepRef} className="rs-scroll rs-card-cap" style={{
                ...glass,
                pointerEvents: 'auto',
                width: 560,
                maxWidth: 'calc(100vw - 48px)',
                overflowY: 'auto',
                padding: '38px 42px',
                textAlign: 'center',
                animation: `${anim} 0.42s cubic-bezier(0.22,1,0.36,1) both`,
              }}>
                <div style={{ fontSize: 12, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.62)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>CT scan review</div>
                <h1 tabIndex={-1} style={{ fontSize: 48, lineHeight: 1.02, letterSpacing: '-0.02em', color: '#fff', margin: '0 0 18px', fontWeight: 700, textWrap: 'balance' }}>
                  {flagged.length > 0 ? 'Your scan looks mostly healthy.' : 'Your scan looks healthy.'}
                </h1>
                <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.70)', lineHeight: 1.55, margin: '0 auto 26px', maxWidth: 430, textWrap: 'balance' }}>
                  {flagged.length > 0
                    ? `${organsLookHealthy(normal.length)}. ${flagged.length}\u00a0finding${flagged.length === 1 ? '' : 's'} will be explained.`
                    : `${normal.length === 1 ? '' : 'All '}${organsLookHealthy(normal.length)}. No findings to review.`}
                </p>
                <button
                  type="button"
                  className="rs-primary"
                  onClick={() => { go(1); setModePromptOpen(true); }}
                  style={{
                    padding: '14px 26px',
                    borderRadius: 999,
                    border: '1px solid rgba(255,255,255,0.16)',
                    background: 'rgba(255,255,255,0.11)',
                    color: 'rgba(255,255,255,0.94)',
                    fontSize: 15,
                    fontWeight: 760,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    transition: 'transform 0.22s cubic-bezier(0.22,1,0.36,1), background-color 0.22s ease, border-color 0.22s ease',
                  }}
                >
                  Start walkthrough <span aria-hidden="true">→</span>
                </button>
              </div>
            </div>
          )}


          {/* Coachmark: after Start walkthrough, point users to the existing Patient / Doctor toggle */}
          {modePromptOpen && step > 0 && (
            <>
              {/* Clicking the veil dismisses the coachmark (the current lang
                  stays as-is; the toggle in the top bar remains available). */}
              <div aria-hidden="true" onClick={() => setModePromptOpen(false)} style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10004,
                pointerEvents: 'auto',
                cursor: 'pointer',
                background: 'rgba(0,0,0,0.48)',
                backdropFilter: 'blur(18px)',
                WebkitBackdropFilter: 'blur(18px)',
                animation: 'riseIn 0.24s ease both',
              }} />

              <div className="rs-coach" style={{
                ...coachVars,
                zIndex: 10007,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'stretch',
                gap: 14,
                animation: 'riseIn 0.26s ease both',
              }}>
                {/* Ends just under the toggle: the card's placement is measured off it. */}
                <div className="rs-coach-arrow" aria-hidden="true">
                  <svg width="24" height="30" viewBox="0 0 24 30" fill="none" stroke="rgba(255,255,255,0.78)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 29V4M5 11l7-7 7 7" />
                  </svg>
                </div>

                <div id="rs-coach-text" className="rs-coach-card" style={{
                  ...glass,
                  padding: '22px 24px',
                  boxShadow: '0 26px 90px rgba(0,0,0,0.46), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}>
                  <div style={{
                    fontSize: 12,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.62)',
                    fontWeight: 820,
                    marginBottom: 10,
                  }}>
                    Choose your view
                  </div>
                  <div style={{
                    fontSize: 27,
                    lineHeight: 1.06,
                    letterSpacing: '-0.02em',
                    color: '#fff',
                    fontWeight: 700,
                    textWrap: 'balance',
                    marginBottom: 10,
                  }}>
                    Are you a patient or a doctor?
                  </div>
                  <p style={{
                    fontSize: 15,
                    lineHeight: 1.48,
                    color: 'rgba(255,255,255,0.64)',
                    margin: 0,
                  }}>
                    Select the role that fits you best. You can switch views anytime.
                  </p>
                </div>
              </div>
            </>
          )}


          {/* Story panel on the left, evidence panel on the right. On narrow
              screens the stage stacks them in one column (see STYLES). */}
          <div ref={stageRef} className="rs-stage">
            {step > 0 && step < totalSteps - 1 && (
              <div className="rs-story-slot">
                <div ref={storyRef} className="rs-scroll rs-story" style={{ ...glass, zIndex: 10001, pointerEvents: 'auto', padding: 24 }}>
                  {leftContent}
                </div>
              </div>
            )}

            {step > 1 && step < totalSteps - 1 && (
              <div ref={evidenceRef} className="rs-evidence" style={{ zIndex: 10001, pointerEvents: 'auto', scrollMarginTop: 12 }}>
                <EvidencePanel
                  key={step}
                  step={step}
                  lang={lang}
                  flagged={flagged}
                  normal={normal}
                  curOrgan={curOrganName}
                  curData={curOrganData}
                  data={data}
                  anim={anim}
                />
              </div>
            )}

            {step > 0 && step < totalSteps - 1 && (
              <div className="rs-timeline" style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10001, pointerEvents: 'auto' }}>
                <FindingsTimeline
                organStatuses={flagged.map(([o, v]) => ({ organ: o, status: v.status || 'check' }))}
                comments={data.comments}
                focusedOrgan={curOrganName}
                onNodeTap={organ => {
                  const fi = flagged.findIndex(([o]) => o === organ);
                  go(fi >= 0 ? 2 + fi : 1);
                }}
              />
              </div>
            )}
          </div>

          {/* FINAL centered impression panel */}
          {step === totalSteps - 1 && (
            <div style={{
              position: 'fixed',
              inset: 'var(--rs-bar-h) 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}>
              <div className="rs-scroll rs-final rs-card-cap" style={{ ...glass, pointerEvents: 'auto', width: 560, maxWidth: 'calc(100vw - 48px)', overflowY: 'auto' }}>
                {leftContent}
              </div>
            </div>
          )}

        </>
      )}
    </div>
  );
}
