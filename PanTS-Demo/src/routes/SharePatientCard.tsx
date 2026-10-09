import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { encode } from 'uqr';
import MessagePage from '../components/MessagePage';
import Header from '../components/Header';
import SiteFooter from '../components/SiteFooter';
import { APP_CONSTANTS } from '../helpers/constants';
import { prefersReducedMotion } from '../helpers/motion';
import type { ReportData, OrganData } from '../helpers/reportFindings';
import {
  splitOrgans,
  organRoot,
  findingLabel,
  getReportMeasurements,
  patientFindingText,
} from '../helpers/reportFindings';

// The site's JHU blue and brand neutrals, so this page reads as part of the site.
const NAVY = '#002d72';
const NAVY_DEEP = '#001d4a';
const SPIRIT_TEXT = '#002d72';
const AMBER = '#8A5200';
const GREEN = '#0A6A3E';
const INK = '#0F172A';
const MUTED = '#5A6175';
const HAIRLINE = '#E2E1DA';
const PANEL = 'var(--paper-2)';

const STYLES = `
@keyframes fadeUp { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }

/* The site's flat primary button: solid JHU blue, a darker blue on hover. */
.spc-share { background: ${NAVY}; transition: background 0.15s ease; }
.spc-share:hover { background: ${NAVY_DEEP}; }

.spc-chip { transition: background 0.2s, color 0.2s; cursor: pointer; border: 1px solid transparent; font-family: inherit; }
.spc-chip:hover { border-color: ${NAVY}; }
.spc-chip:focus-visible,
.spc-share:focus-visible,
.spc-brand:focus-visible,
.spc-ad:focus-visible { outline: 2px solid ${NAVY}; outline-offset: 3px; }
.spc-ad:focus-visible { outline-color: #ffffff; outline-offset: -4px; }
.spc-ad:hover { background: ${NAVY_DEEP} !important; }
.spc-qr-wrap { transition: transform 0.25s cubic-bezier(0.34,1.5,0.64,1); }
.spc-qr-wrap:hover { transform: scale(1.05); }

/* Status dot before the headline: amber when something is flagged, green when clear.
   It hangs in the left padding so every wrapped line shares the card's text edge. */
.spc-stat { position: relative; padding-left: 20px; }
.spc-stat::before { content: ""; position: absolute; left: 0; top: 10px; width: 10px; height: 10px; border-radius: 50%; }
.spc-stat-flagged::before { background: ${AMBER}; }
.spc-stat-clear::before { background: ${GREEN}; }

/* Side by side while there is room; on a narrow card the icon sits above the
   label so the sentence gets the full width instead of a squeezed column. */
.spc-impression { flex-direction: row; gap: 14px; }
@media (max-width: 520px) {
  .spc-impression { flex-direction: column; gap: 10px; }
}
`;

const CARD_MAX = 640;

// What the server sends as the comments when a case has no report text.
const NO_REPORT_COMMENTS = 'Clinical comments unavailable.';

// Dedupe by organ root — pancreas + pancreas_tail are the same underlying
// finding; without this a case can wrongly claim "2 findings" for one organ.
// A left and a right twin (kidney, adrenal gland, lung) stay separate, as in
// the report walkthrough, so a flagged right kidney is not dropped. `name` is
// what the card calls the finding: "kidney_left" for a twin, the bare root otherwise.
type Finding = { root: string; organ: string; name: string; data: OrganData };
function dedupeFindingsByRoot(flagged: [string, OrganData][]): Finding[] {
  const byRoot = new Map<string, Finding>();
  for (const [organ, data] of flagged) {
    const root = organRoot(organ);
    const side = organ.match(/_(left|right)$/)?.[1] ?? '';
    const key = `${root}|${side}`;
    const existing = byRoot.get(key);
    if (!existing || organ === root) byRoot.set(key, { root, organ, name: side ? organ : root, data });
  }
  return Array.from(byRoot.values());
}

// Staggered entrance delay helper — each major section fades/rises in a
// beat after the previous one instead of everything appearing at once.
// Skipped entirely when the visitor asks for reduced motion.
function stagger(revealed: boolean, index: number): React.CSSProperties {
  if (prefersReducedMotion()) return {};
  return revealed ? { animation: `fadeUp 0.45s cubic-bezier(0.16,1,0.3,1) ${index * 0.08}s both` } : { opacity: 0 };
}

export default function SharePatientCard() {
  const { shareId = '' } = useParams<{ shareId: string }>();
  const [data, setData] = useState<ReportData | null>(null);
  // 'dead' is a link the server rejected; 'unreachable' is a failed or broken response, worth another try.
  const [error, setError] = useState<'dead' | 'unreachable' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [noOrganData, setNoOrganData] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [activeIdx, setActiveIdx] = useState(0);
  // Set by Try again: the button unmounts when the page swaps to the loading
  // card, so focus is handed to the page's main landmark (and then its heading
  // once a message or the card arrives) instead of dropping to <body>.
  const retried = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch(`${APP_CONSTANTS.API_ORIGIN}/api/share/${shareId}`)
      .then(async r => ({ status: r.status, j: await r.json() }))
      .then(({ status, j }) => {
        if (cancelled) return;
        if (status >= 500) { setError('unreachable'); return; }
        if (j.error) { setError('dead'); return; }
        if (j.masks_available === false || !j.organ_volumes || Object.keys(j.organ_volumes).length === 0) {
          setNoOrganData(true);
          return;
        }
        setData(j);
      })
      .catch(() => { if (!cancelled) setError('unreachable'); });
    return () => { cancelled = true; };
  }, [shareId, attempt]);

  useEffect(() => {
    if (!retried.current) return;
    const target = document.querySelector<HTMLElement>('main h1') ?? document.querySelector<HTMLElement>('main');
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
    if (error || noOrganData || data) retried.current = false;
  }, [error, noOrganData, data]);

  useEffect(() => {
    if (!data) return;
    const t = setTimeout(() => setRevealed(true), 30);
    return () => clearTimeout(t);
  }, [data]);

  const { flagged, normal } = useMemo(() => splitOrgans(data), [data]);
  const findings = useMemo(() => dedupeFindingsByRoot(flagged), [flagged]);
  const allClear = data ? findings.length === 0 : false;

  const active = findings[activeIdx] ?? null;
  const measurements = active && data ? getReportMeasurements(active.organ, data.comments || '') : null;
  // With no report text the server still flags an organ from its measured density, so the
  // card falls back to the structured volume and mean HU that caused the flag.
  const noReportText = !data?.comments?.trim() || data.comments.trim() === NO_REPORT_COMMENTS;
  const measured = active && data ? data.organ_volumes[active.organ] : null;
  const volumeCc = measurements?.organVolumeCc ?? measured?.volume ?? null;
  const meanHu = measurements?.organMeanHu ?? measured?.mean_hu ?? null;
  const plainLanguage = active && measurements
    ? noReportText
      ? 'No report text is available for this case. The flag comes from the measured density.'
      : patientFindingText(active.organ, measurements)
    : null;

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const handleShare = async () => {
    const url = window.location.href;
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 2000);
      return;
    } catch { /* clipboard unavailable, try the share sheet next */ }
    // In-app browsers and non-secure pages have no clipboard but often a share sheet.
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return; // the visitor closed the sheet
      }
    }
    setCopyFailed(true);
  };

  const bodyMapsUrl = 'https://thebodymaps.com';
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  if (error || noOrganData) {
    const unreachable = error === 'unreachable';
    return (
      <MessagePage
        eyebrow="Shared summary"
        title={unreachable ? "We couldn't load this summary" : error ? "This report link isn't available" : "This summary has no organ data"}
        actions={[
          ...(unreachable ? [{ label: 'Try again', onClick: () => { retried.current = true; setAttempt(n => n + 1); } }] : []),
          { label: 'Browse the dataset', to: '/dashboard' },
          { label: 'Go to the overview', to: '/' },
        ]}
        alert
      >
        <p>
          {unreachable
            ? 'Check your connection and try again.'
            : error
              ? 'The link may be incomplete, or the summary it pointed to is no longer available. Ask the person who shared it for a new link.'
              : 'No mapped organ data is available for this case, so there is nothing to summarize.'}
        </p>
      </MessagePage>
    );
  }

  return (
    <div style={page}>
      <style>{STYLES}</style>
      <Header />

      <main style={stage}>
        {!data && (
          <div style={loadingWrap} role="status">
            <div style={spinnerRing} aria-hidden="true" />
            <span style={visuallyHidden}>Loading the shared summary…</span>
          </div>
        )}

        {data && (
          <div style={{ ...card, ...stagger(revealed, 0) }}>
            <div style={cardBody}>
              {/* Identity */}
              <a href={bodyMapsUrl} target="_blank" rel="noreferrer" className="spc-brand" style={{ ...brandLockup, ...stagger(revealed, 1) }}>
                <img src="/bodymaps-logo.svg" alt="" width={18} height={18} style={brandMark} />
                <span style={brandName}>BodyMaps</span>
                <span style={brandSub}>Johns Hopkins University</span>
              </a>

              <div style={stagger(revealed, 2)}>
                <div style={eyebrow}>CT scan summary</div>
                {/* The headline states the status once; the dot before it (drawn in
                    CSS, so it is not read out) only carries the colour cue. */}
                <h1 className={allClear ? 'spc-stat spc-stat-clear' : 'spc-stat spc-stat-flagged'} style={statLine}>
                  {allClear ? 'Nothing flagged' : `${findings.length} organ${findings.length === 1 ? '' : 's'} flagged for review`}
                </h1>
                {!allClear && normal.length > 0 && (
                  <p style={subStatLine}>{normal.length} other mapped structure{normal.length === 1 ? ' is' : 's are'} not listed here.</p>
                )}
              </div>

              {/* Real buttons: reachable by Tab, and the pressed one is the finding shown below. */}
              {!allClear && active && findings.length > 1 && (
                <div role="group" aria-label="Flagged organs" style={{ ...chipRow, ...stagger(revealed, 3) }}>
                  {findings.map((f, i) => (
                    <button
                      key={f.name}
                      type="button"
                      className="spc-chip"
                      aria-pressed={i === activeIdx}
                      onClick={() => setActiveIdx(i)}
                      style={chip(i === activeIdx)}
                    >
                      {findingLabel(f.name)}
                    </button>
                  ))}
                </div>
              )}

              {!allClear && active && (
                <>
                  <div style={{ ...panel, ...stagger(revealed, 4) }}>
                    <div style={panelInner}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={panelLabel}>Organ</div>
                        <h2 style={organNameBig}>{findingLabel(active.name)}</h2>
                      </div>
                    </div>
                  </div>

                  {/* The report summary sits right below the organ name — this is
                      the most important line on the card, sized up accordingly.
                      Labelled as an automated summary, not a radiology
                      impression: nothing here has been reviewed by a radiologist. */}
                  <div className="spc-impression" style={{ ...impressionPanel, ...stagger(revealed, 5) }}>
                    <div style={impressionIconWrap} aria-hidden="true"><DocIcon /></div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={impressionLabel}>Report summary</div>
                      <p style={impressionText}>{plainLanguage || 'The automated summary has no more detail on this organ.'}</p>
                    </div>
                  </div>

                  {(volumeCc != null || meanHu != null) && (
                    <div style={stagger(revealed, 6)}>
                      <div style={sectionLabel}>Key measurements</div>
                      <div style={measureCardsRow}>
                        {volumeCc != null && (
                          <div style={measureCard}>
                            <div style={measureIconWrap} aria-hidden="true"><CubeIcon /></div>
                            <div style={measureLabel}>{findingLabel(active.name)} volume</div>
                            <div style={measureValue}>{volumeCc.toFixed(1)} cm³</div>
                            <div style={measureSub}>Estimated from the AI segmentation</div>
                          </div>
                        )}
                        {meanHu != null && (
                          <div style={measureCard}>
                            <div style={measureIconWrap} aria-hidden="true"><PulseIcon /></div>
                            <div style={measureLabel}>Mean attenuation</div>
                            <div style={measureValue}>{meanHu.toFixed(1).replace(/^-/, '−')} HU</div>
                            <div style={measureSub}>Estimated from the CT scan</div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {allClear && (
                <p style={{ ...impressionText, marginTop: 14, fontSize: 14 }}>
                  The automated summary covered {normal.length} mapped structure{normal.length === 1 ? '' : 's'} on this scan.
                </p>
              )}

              {/* The site footer carries the nonclinical-use sentences, so only the card-specific one goes here. */}
              <p style={notice}>
                This summary was generated automatically and has not been reviewed by a radiologist.
              </p>

              <div style={hairline} />

              <div style={{ ...actionsRow, ...stagger(revealed, 7) }}>
                <button type="button" className="spc-share" onClick={handleShare} style={shareInlineBtn}>
                  <span style={{ display: 'inline-flex' }} aria-hidden="true"><ShareIcon /></span>
                  {copied ? 'Link copied' : 'Share this BodyMap'}
                </button>
              </div>
              <p role="status" style={copyFailed ? copyFailedNote : visuallyHidden}>
                {copied ? 'Link copied to the clipboard.' : copyFailed ? "Couldn't copy the link. Copy the address from your browser instead." : ''}
              </p>
            </div>

            {/* Navy band with the site link and the QR code together. The
                BodyMaps wordmark is already at the top of the card. */}
            <a
              href={bodyMapsUrl}
              target="_blank"
              rel="noreferrer"
              className="spc-ad"
              style={{ ...adBar, ...stagger(revealed, 8) }}
            >
              <div style={adUrl}>thebodymaps.com</div>
              <div className="spc-qr-wrap" style={adQrWrap}>
                <ShareQrCode text={shareUrl} size={96} />
              </div>
            </a>
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}

// Drawn here rather than fetched from a QR service, so the share link and its
// token never leave the page. Navy on white, the way scanners expect; the white
// frame around it is the quiet zone.
function ShareQrCode({ text, size }: { text: string; size: number }) {
  const path = useMemo(() => {
    const { data } = encode(text, { ecc: 'L', boostEcc: true, border: 0 });
    let d = '';
    data.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x} ${y}h1v1h-1z`; }));
    return { d, modules: data.length };
  }, [text]);
  return (
    <svg
      role="img"
      aria-label="QR code to this BodyMap"
      width={size}
      height={size}
      viewBox={`0 0 ${path.modules} ${path.modules}`}
      shapeRendering="crispEdges"
      style={adQrImg}
    >
      <path d={path.d} fill={NAVY} />
    </svg>
  );
}

function CubeIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" stroke={SPIRIT_TEXT} strokeWidth="1.7" strokeLinejoin="round" /><path d="M4 7.5L12 12l8-4.5M12 12v9" stroke={SPIRIT_TEXT} strokeWidth="1.7" strokeLinejoin="round" /></svg>;
}
function PulseIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none"><path d="M3 12h4l2-7 4 14 2-7h6" stroke={SPIRIT_TEXT} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function DocIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M6 3h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V4a1 1 0 011-1z" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /><path d="M14 3v5h5" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" /><path d="M8 13h8M8 17h8" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" /></svg>;
}
function ShareIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginRight: 7 }}><path d="M12 3v13M8 7l4-4 4 4" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M5 13v6a1 1 0 001 1h12a1 1 0 001-1v-6" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ─── Style tokens ───────────────────────────────────────────────────────────

const page: React.CSSProperties = {
  minHeight: '100vh', width: '100%', background: 'var(--paper)', color: INK,
  display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-sans)',
};

// The card column sits between the site header and footer, centred in the space
// they leave.
const stage: React.CSSProperties = {
  flex: 1, width: '100%', maxWidth: CARD_MAX + 40, margin: '0 auto', boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '36px 20px',
};

const loadingWrap: React.CSSProperties = { display: 'flex', justifyContent: 'center', padding: '80px 0' };
const spinnerRing: React.CSSProperties = { width: 22, height: 22, borderRadius: '50%', border: `2px solid ${HAIRLINE}`, borderTopColor: NAVY, animation: 'spin 0.8s linear infinite' };

const visuallyHidden: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
};

const card: React.CSSProperties = {
  background: '#ffffff', borderRadius: 8, border: `1px solid ${HAIRLINE}`,
  boxShadow: '0 1px 3px rgba(15,23,42,0.06)', overflow: 'hidden',
};
const cardBody: React.CSSProperties = { padding: '24px 26px 0' };

// One quiet line: the site header already carries the brand, this only keeps a
// screenshot of the card alone identifiable.
const brandLockup: React.CSSProperties = { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 8px', textDecoration: 'none', marginBottom: 12 };
const brandMark: React.CSSProperties = { display: 'block', width: 18, height: 18, flexShrink: 0 };
const brandName: React.CSSProperties = { fontWeight: 600, fontSize: 13, color: NAVY, lineHeight: 1.2 };
const brandSub: React.CSSProperties = { fontSize: 12, color: MUTED, fontWeight: 500, lineHeight: 1.2 };

// The one small-label style: eyebrow, panel and section labels, the report
// summary label and the measurement captions all share it. Sentence case in the
// source and uppercase by style only.
const label: React.CSSProperties = { fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', color: SPIRIT_TEXT, textTransform: 'uppercase' };

const eyebrow: React.CSSProperties = { ...label };
const statLine: React.CSSProperties = { fontSize: 24, lineHeight: 1.25, fontWeight: 600, color: INK, marginTop: 6, marginBottom: 0, textWrap: 'balance' };
const subStatLine: React.CSSProperties = { fontSize: 13, color: MUTED, marginTop: 6, marginBottom: 4, textWrap: 'balance' };

const chipRow: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 };
const chip = (active: boolean): React.CSSProperties => ({
  fontSize: 12, fontWeight: 600, padding: '8px 14px', borderRadius: 999,
  background: active ? NAVY : 'var(--paper-3)', color: active ? '#fff' : MUTED,
  borderColor: active ? NAVY : undefined,
});

const panel: React.CSSProperties = { marginTop: 14, padding: '18px 20px', borderRadius: 8, background: PANEL, border: `1px solid ${HAIRLINE}` };
const panelInner: React.CSSProperties = { display: 'flex', gap: 18, flexWrap: 'wrap' };
const panelLabel: React.CSSProperties = { ...label };
const organNameBig: React.CSSProperties = { fontSize: 20, fontWeight: 600, color: INK, marginTop: 4, marginBottom: 0, textWrap: 'balance' };

const sectionLabel: React.CSSProperties = { ...label, marginTop: 20, marginBottom: 8 };
const measureCardsRow: React.CSSProperties = { display: 'flex', gap: 10 };
const measureCard: React.CSSProperties = { flex: 1, padding: '13px 14px', borderRadius: 8, background: PANEL, border: `1px solid ${HAIRLINE}` };
const measureIconWrap: React.CSSProperties = { width: 26, height: 26, borderRadius: 6, background: '#E8F0FB', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 };
const measureLabel: React.CSSProperties = { ...label, marginBottom: 4 };
const measureValue: React.CSSProperties = { fontSize: 20, fontWeight: 600, color: INK };
const measureSub: React.CSSProperties = { fontSize: 11, color: MUTED, marginTop: 2 };

// Direction and gap come from .spc-impression so the narrow-width rule can restack it.
const impressionPanel: React.CSSProperties = {
  display: 'flex', marginTop: 14, padding: '18px 20px',
  background: '#EFF4FB', border: `1px solid ${HAIRLINE}`, borderRadius: 8,
};
const impressionIconWrap: React.CSSProperties = { width: 32, height: 32, borderRadius: 6, background: SPIRIT_TEXT, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1 };
const impressionLabel: React.CSSProperties = { ...label, marginBottom: 7 };
const impressionText: React.CSSProperties = { fontSize: 15, lineHeight: 1.5, color: INK, margin: 0, fontWeight: 500, textWrap: 'pretty' };

const notice: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: MUTED, margin: '18px 0 0' };

// Only shown when copying failed; the same region stays visually hidden otherwise.
const copyFailedNote: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: AMBER, margin: '-8px 0 16px' };

const hairline: React.CSSProperties = { height: 1, background: HAIRLINE, margin: '16px 0 20px' };

// Left-aligned with the rest of the card; the 20px above and below the button match.
const actionsRow: React.CSSProperties = { display: 'flex', justifyContent: 'flex-start', marginBottom: 20 };
// The site's primary button: flat, 4px corners; the fill and hover come from .spc-share.
const shareInlineBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', padding: '9px 16px', borderRadius: 4, border: 'none',
  color: '#fff', fontSize: 15, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
};

// One navy band closes the card: the site link and the QR code.
const adBar: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '22px 26px', background: NAVY, textDecoration: 'none', transition: 'background 0.2s',
};
const adUrl: React.CSSProperties = { fontSize: 15, color: '#fff', fontWeight: 500 };
const adQrWrap: React.CSSProperties = { padding: 5, background: '#fff', borderRadius: 6, flexShrink: 0 };
const adQrImg: React.CSSProperties = { display: 'block' };
