import React, { useEffect, useState, useRef, useCallback } from 'react';
import { APP_CONSTANTS } from '../../helpers/constants';
import FindingsTimeline from './FindingsTimeline';

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  id: string;
  onClose: () => void;
  onViewChange: (view: 'axial' | 'sagittal' | 'coronal' | '3d') => void;
  onOrganHighlight?: (organName: string, centroidMm?: [number, number, number]) => void;
  onClearHighlight?: () => void;
  onHideOrgans?: (organNames: string[]) => void;
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

  const request = fetch(`${APP_CONSTANTS.API_ORIGIN}/api/get-report-data/${encodeURIComponent(id)}`)
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
      cache[id] = report;
      return report;
    })
    // Report preparation is optional. The Report button remains usable and can
    // request the data again if a background request fails.
    .catch(() => null)
    .finally(() => reportDataRequests.delete(id));

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

.rs-primary:hover { transform: translateY(-1px); background: rgba(255,255,255,0.16)!important; border-color: rgba(255,255,255,0.24)!important; }
.rs-primary-amber:hover { transform: translateY(-1px); background: rgba(251,191,36,0.18)!important; border-color: rgba(251,191,36,0.34)!important; }
.rs-secondary:hover { background: rgba(255,255,255,0.08)!important; color: rgba(255,255,255,0.9)!important; border-color: rgba(255,255,255,0.18)!important; }
.rs-exit:hover { background: rgba(239,68,68,0.10)!important; border-color: rgba(239,68,68,0.36)!important; color: rgba(248,113,113,0.95)!important; }
.rs-toggle:hover { background: rgba(255,255,255,0.08)!important; }
.rs-link:hover { color: rgba(255,255,255,0.9)!important; }
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function labelize(organ: string): string {
  return organ
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
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


function organRoot(organ: string): string {
  if (organ.startsWith('pancreas')) return 'pancreas';
  if (organ.startsWith('kidney')) return 'kidney';
  // BUG FIX: this used to end with .split(' ')[0], which truncated every
  // multi-word organ down to its first word — "adrenal_gland_right" became
  // just "adrenal", "common_bile_duct" became just "common". That broke
  // section-heading lookup (the report heading wouldn't match a truncated
  // root) and produced mangled patient sentences ("...in your adrenal.").
  // Only the trailing location/anatomy-suffix word should ever be stripped.
  return organ
    .replace(/_(gland|body|tail|head|left|right)$/, '')
    .replace(/_/g, ' ')
    .toLowerCase();
}

// Mask labels that are findings or hardware, not organs. They must never be
// presented in the patient-facing healthy organs list.
function isNonOrganLabel(organ: string): boolean {
  return organ.endsWith('_lesion') || organ === 'cbd_stent';
}

// Renders "Case 12" plus " · F · 61y" only for demographics the backend
// actually has. It returns the string "N/A" for missing age/sex (despite the
// declared types), which used to render as "Case 12 · N/A · N/Ay".
function caseSummary(id: string, patient: ReportData['patient']): string {
  const parts = [`Case ${id}`];
  const sex: unknown = patient.sex;
  const age: unknown = patient.age;
  if (typeof sex === 'string' && sex.trim() && sex.trim().toUpperCase() !== 'N/A') parts.push(sex.trim());
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
  return collected.join(' ').replace(/\s+/g, ' ').trim() || null;
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
  const huMatch = lesionHuMatch ?? section?.match(/Mean HU value:\s*([\d.]+)(?:\s*\+\/-\s*([\d.]+))?/i);
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
  const organHuMatch = section?.match(/Mean HU value:\s*([\d.]+)/i);

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

// Suffix on organ keys like "pancreas_tail" / "kidney_left" already encodes the
// anatomical location the backend split out — reuse it instead of re-parsing
// the report text for location. Paired organs (left/right) read better as
// "your left kidney"; sub-regions of a single organ (head/body/tail) read
// better as "in the tail of your pancreas" — so these are kept distinct
// rather than forced through one phrasing template.
function organLocation(organ: string): { type: 'lateral' | 'subregion'; word: string } | null {
  const suffix = organ.split('_').pop() ?? '';
  if (suffix === 'left' || suffix === 'right') return { type: 'lateral', word: suffix };
  if (suffix === 'tail' || suffix === 'head' || suffix === 'body') return { type: 'subregion', word: suffix };
  return null;
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
  if (d.includes('nodule')) return 'small bump';
  if (d.includes('mass') || d.includes('tumor')) return 'growth';
  if (d.includes('enlarged')) return 'enlarged area';
  if (d.includes('dilated') || d.includes('widened')) return 'widened area';
  if (d.includes('lesion')) return 'spot';
  return null;
}

function getImpressionText(data: ReportData | null): string {
  if (!data?.impression?.length) return '';
  return data.impression
    .map(t => t.replace(/^\d+\.\s*/, '').replace(/^\[([^\]]+)\]:\s*/, '$1: '))
    .join(' ');
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
function patientFindingText(organ: string, measurements: ReportMeasurements): string {
  const organLabel = labelize(organRoot(organ)).toLowerCase();
  const loc = organLocation(organ);
  const subject =
    loc?.type === 'lateral' ? `your ${loc.word} ${organLabel}`
    : loc?.type === 'subregion' ? `the ${loc.word} of your ${organLabel}`
    : `your ${organLabel}`;
  const detail = measurements.section || '';

  if (!detail) {
    return `The scan flagged ${subject} for your doctor to review — the report text wasn't specific enough to describe here.`;
  }

  const noun = findingNoun(detail);
  if (!noun) {
    // Flagged, but the text doesn't describe an actual lesion/mass — don't
    // invent one. Most common cause: flagged on an HU-range check, not a
    // described finding.
    return `${capFirst(subject)} was flagged for review, but the report doesn't describe a specific spot or growth — ask your doctor what stood out.`;
  }

  const sizeWord = sizeDescriptor(measurements.lesionVolumeCc ?? measurements.volumeCc, measurements.sizeCm);
  const sizePart = measurements.sizeCm ? ` (${measurements.sizeCm} cm)` : '';
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
        transition: 'all 0.22s cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      {children}
    </button>
  );
}

function SecondaryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
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
        transition: 'all 0.2s',
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
        <span style={{ width: 22, height: 22, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: bg, color, fontWeight: 850, fontSize: 13 }}>
          {tone === 'green' ? '✓' : '!'}
        </span>
        <span style={{ color: 'rgba(255,255,255,0.78)', fontSize: 13, fontWeight: 720 }}>{title}</span>
      </div>
      <div style={{ color, fontSize: 28, lineHeight: 1, fontWeight: 820, letterSpacing: '-0.04em' }}>{value}</div>
      <div style={{ color: 'rgba(255,255,255,0.54)', fontSize: 14, marginTop: 8 }}>{sub}</div>
    </div>
  );
}

function OrganList({ organs, max = 5 }: { organs: [string, OrganData][]; max?: number }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? organs : organs.slice(0, max);
  return (
    <>
      <div className="rs-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: showAll ? 220 : 'none', overflowY: showAll ? 'auto' : 'visible', paddingRight: showAll ? 6 : 0 }}>
        {visible.map(([organ], i) => (
          <div key={organ} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 16, background: 'rgba(110,231,183,0.075)', border: '1px solid rgba(110,231,183,0.17)', animation: `riseIn 0.25s ease ${i * 26}ms both` }}>
            <span style={{ width: 21, height: 21, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(110,231,183,0.14)', color: '#6ee7b7', fontSize: 12, fontWeight: 850, flexShrink: 0 }}>✓</span>
            <span style={{ color: 'rgba(255,255,255,0.84)', fontSize: 15, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelize(organ)}</span>
          </div>
        ))}
      </div>
      {organs.length > max && (
        <button
          className="rs-link"
          onClick={() => setShowAll(v => !v)}
          style={{ marginTop: 12, background: 'transparent', border: 'none', padding: 0, color: 'rgba(110,231,183,0.78)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}
        >
          {showAll ? 'Show less' : `Show all ${organs.length} healthy organs`}
        </button>
      )}
    </>
  );
}

function MetricRow({ label, value, sub, tone = 'white' }: { label: string; value: string; sub?: string; tone?: 'white' | 'green' | 'amber' }) {
  const color = tone === 'green' ? '#6ee7b7' : tone === 'amber' ? '#fbbf24' : 'rgba(255,255,255,0.92)';
  return (
    <div style={{ padding: '13px 0', borderBottom: '1px solid rgba(255,255,255,0.075)' }}>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.42)', marginBottom: 5, letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: 22, lineHeight: 1.08, fontWeight: 780, color, letterSpacing: '-0.03em' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.38)', marginTop: 5, lineHeight: 1.42 }}>{sub}</div>}
    </div>
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
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.075)' }}>
      <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.52)' }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 720, color: 'rgba(255,255,255,0.92)', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// Structured doctor-view card: labeled metric rows + a review badge, in place
// of dumping the raw report-comments string. Deliberately sources HU/volume
// from the report's organ-baseline numbers (report.organMeanHu/organVolumeCc)
// rather than curData — curData can be a small anatomical sub-label (e.g.
// "pancreas_tail") whose own segmented mask is tiny, which previously showed
// as a misleading "0 HU / 0 cc" even though the organ itself had real values.
function OrganMetricsCard({
  curData,
  report,
  needsReview,
}: {
  curData: OrganData;
  report: ReportMeasurements;
  needsReview: boolean;
}) {
  const meanHu = report.organMeanHu ?? curData.mean_hu;
  const organVolume = report.organVolumeCc ?? curData.volume;
  return (
    <div style={{ marginTop: 4, marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.42)', fontWeight: 820, textTransform: 'uppercase' }}>
          Organ Metrics
        </div>
        {needsReview && <Badge tone="amber">NEEDS REVIEW</Badge>}
      </div>
      <MetricLine label="Mean attenuation (HU)" value={meanHu !== null ? `${Math.round(meanHu * 10) / 10} HU` : 'Not listed'} />
      <MetricLine label="Organ volume" value={`${organVolume.toFixed(1).replace(/\.0$/, '')} cc`} />
      <MetricLine
        label="Lesion volume"
        value={report.lesionVolumeCc !== null ? `${report.lesionVolumeCc.toFixed(1).replace(/\.0$/, '')} cc` : 'None detected'}
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
  const reportVolume = report?.volumeCc ?? null;
  
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
              {labelize(firstFinding!)}
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
        <div style={{ fontSize: 12, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(251,191,36,0.72)', fontWeight: 800, marginBottom: 18 }}>
          Measurements
        </div>

        <MetricRow label="Organ" value={labelize(curOrgan)} tone="amber" />

        {lang === 'clinical' && report && (
          <OrganMetricsCard curData={curData} report={report} needsReview={curData.status === 'check'} />
        )}

        {lang === 'clinical' && report?.sizeCm && (
          <MetricRow label="Report size" value={`${report.sizeCm} cm`} sub="From the report text." />
        )}

        {lang === 'clinical' && curData.dimensions && !report?.sizeCm && (
          <MetricRow
            label="Segmented dimensions"
            value={`${curData.dimensions[0]} × ${curData.dimensions[1]} × ${curData.dimensions[2]} cm`}
            sub="Computed from the segmented organ mask."
          />
        )}

        {/* Full report-text paragraph deliberately omitted here — it's the exact
            same string already shown in the left story panel (medLocal), so
            showing it again just duplicated the same paragraph on screen. */}

        {lang === 'patient' && (
          <>
            {reportVolume !== null && (
              <MetricRow label="Volume" value={`${reportVolume.toFixed(1).replace(/\.0$/, '')} cc`} tone="amber" sub="From the report text." />
            )}
            <p style={{ color: 'rgba(255,255,255,0.58)', fontSize: 14, lineHeight: 1.55, margin: '18px 0 0' }}>
              This panel shows the key measurement from the report. Your doctor can explain what it means for you.
            </p>
          </>
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

// ─── Main component ───────────────────────────────────────────────────────────

export default function ReportScreen({ id, onClose, onViewChange, onOrganHighlight, onClearHighlight, onHideOrgans }: Props) {
  void onViewChange;
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>(0);
  const [dir, setDir] = useState<'r' | 'l'>('r');
  const [lang, setLang] = useState<Lang>('patient');
  const [modePromptOpen, setModePromptOpen] = useState(false);
  const [plain2, setPlain2] = useState<string[]>([]);
  const [pLoad, setPLoad] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // De-identified share link, minted on demand (see mintShareLink below) —
  // this used to be a raw `${API_ORIGIN}/api/report/${id}` string built
  // straight from the real case id. That exposed the real id in the URL and
  // skipped the token system the rest of the app now uses for sharing.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const startRef = useRef(Date.now());

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
  }, [id]);

  // Reset any previously-minted link when the case changes, so a stale
  // token for a different case can never be shown/copied.
  useEffect(() => {
    setShareUrl(null);
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
      const j = await r.json();
      const token = typeof j.url === 'string' ? j.url.split('/').pop() : null;
      if (token) setShareUrl(`${window.location.origin}/share/${token}`);
    } catch (e) {
      console.error('Failed to create share link:', e);
    } finally {
      setShareLoading(false);
    }
  }, [id, shareUrl, shareLoading]);

  useEffect(() => {
    if (!shareOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShareOpen(false); };
    const onClick = () => setShareOpen(false);
    document.addEventListener('keydown', onKey);
    // Deferred so the same click that opened the popover doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('click', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      clearTimeout(t);
    };
  }, [shareOpen]);

  // Escape closes the topmost layer first: the Patient/Doctor coachmark if
  // open, else the share popover, else it exits the report. Registered on the
  // capture phase (same pattern as ToolWalkthrough) so it wins over the
  // viewer's global shortcut listeners while the report overlay is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (modePromptOpen) { setModePromptOpen(false); return; }
      if (shareOpen) { setShareOpen(false); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modePromptOpen, shareOpen, onClose]);

  const handleCopyShareLink = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.error('Copy failed:', e);
    }
  };

  const fetchPlain = useCallback(async () => {
    if (plain2.length || !data) return;
    setPLoad(true);
    try {
      const r = await fetch(`${APP_CONSTANTS.API_ORIGIN}/api/explain-impressions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ impression: data.impression }),
      });
      const j = await r.json();
      setPlain2(j.plain_language || []);
    } catch {
      // Plain-language text is optional; retain the original report on failure.
    } finally { setPLoad(false); }
  }, [data, plain2]);

  useEffect(() => { if (data) fetchPlain(); }, [data]);

  const go = useCallback((s: Step) => {
    // Any step navigation dismisses the Patient/Doctor coachmark, so a user
    // who advances via Back / Explain finding / the timeline is never left
    // under the darkened blur veil. The Start-walkthrough handlers call
    // setModePromptOpen(true) AFTER go(1), so the coachmark still opens.
    setModePromptOpen(false);
    setDir(s > step ? 'r' : 'l');
    setStep(s);
  }, [step]);

  // Lesion/stent masks are excluded from the volume-based inclusion so they
  // can never appear in the healthy list ("Pancreatic Lesion" is not a healthy
  // organ), but any entry the backend flags as 'check' still passes through so
  // a flagged lesion is not silently dropped from the findings steps.
  const all = React.useMemo(() => data ? Object.entries(data.organ_volumes).filter(([o, v]) => v.status === 'check' || (!isNonOrganLabel(o) && v.volume > 5)) : [], [data]);
  const flagged = React.useMemo(() => all.filter(([_, v]) => v.status === 'check'), [all]);
  // A parent organ (or sibling sub-part) is not listed as healthy while one of
  // its parts is a finding, e.g. "Pancreas" is not a healthy organ on step 1
  // when "Pancreas Body" is presented as the finding on step 2.
  const flaggedRoots = React.useMemo(() => new Set(flagged.map(([o]) => organRoot(o))), [flagged]);
  const normal = React.useMemo(() => all.filter(([o, v]) => v.status !== 'check' && !flaggedRoots.has(organRoot(o))), [all, flaggedRoots]);
  const totalSteps = 2 + flagged.length + 1;

  const curOrganName = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
  const curOrganData = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
  const anim = dir === 'r' ? 'slideR' : 'slideL';

  useEffect(() => {
    if (!data) return;
    onClearHighlight?.();
    if (step === 1) {
      onHideOrgans?.(flagged.map(([o]) => o));
    } else if (step >= 2 && step < 2 + flagged.length) {
      const highlightName = curOrganName === 'pancreas' ? 'pancreas_body' : curOrganName;
      if (highlightName && curOrganData) onOrganHighlight?.(highlightName, curOrganData.centroid_mm);
    }
  }, [step, data]);

  const leftContent = React.useMemo(() => {
    if (!data) return null;
    const curOrganLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[0] : null;
    const curDataLocal = step >= 2 && step < 2 + flagged.length ? flagged[step - 2]?.[1] : null;
    const medLocal = curOrganLocal ? getReportSection(curOrganLocal, data.comments) : null;
    const measurementsLocal = curOrganLocal ? getReportMeasurements(curOrganLocal, data.comments) : null;
    const patientLocal = curOrganLocal && measurementsLocal ? patientFindingText(curOrganLocal, measurementsLocal) : '';
    const impressionText = getImpressionText(data);

    if (step === 0) return (
      <div style={{ animation: `${anim} 0.38s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ fontSize: 12, letterSpacing: '0.13em', color: 'rgba(255,255,255,0.42)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>CT Scan Review</div>
        <h1 style={{ fontSize: 46, lineHeight: 1.02, letterSpacing: '-0.065em', color: '#fff', margin: '0 0 18px', fontWeight: 850 }}>
          Your scan looks mostly healthy.
        </h1>
        <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.68)', lineHeight: 1.55, margin: '0 0 26px' }}>
          We found {normal.length} healthy organ{normal.length === 1 ? '' : 's'} and {flagged.length} finding{flagged.length === 1 ? '' : 's'} to explain.
        </p>
        <div style={{ display: 'flex', gap: 12, marginBottom: 28 }}>
          <StatPill tone="green" title="Healthy" value={`${normal.length}`} sub={`organ${normal.length === 1 ? '' : 's'}`} />
          <StatPill tone="amber" title="Finding" value={`${flagged.length}`} sub={flagged.length === 1 ? 'to explain' : 'to explain'} />
        </div>
        <PrimaryButton onClick={() => { go(1); setModePromptOpen(true); }}>Start review →</PrimaryButton>
      </div>
    );

    if (step === 1) return (
      <div style={{ animation: `${anim} 0.38s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ fontSize: 12, letterSpacing: '0.13em', color: 'rgba(110,231,183,0.72)', textTransform: 'uppercase', marginBottom: 16, fontWeight: 800 }}>Healthy organs</div>
        <h1 style={{ fontSize: 40, lineHeight: 1.05, letterSpacing: '-0.06em', color: '#6ee7b7', margin: '0 0 14px', fontWeight: 850 }}>
          {normal.length} organs look healthy.
        </h1>
        <p style={{ fontSize: 17, color: 'rgba(255,255,255,0.66)', lineHeight: 1.5, margin: '0 0 20px' }}>
          These organs looked healthy on this scan.
        </p>
        <OrganList organs={normal} />
        <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
          <SecondaryButton onClick={() => go(0)}>← Back</SecondaryButton>
          <PrimaryButton amber={flagged.length > 0} onClick={() => go(flagged.length > 0 ? 2 : totalSteps - 1)}>
            {flagged.length > 0 ? 'Explain finding →' : 'Next →'}
          </PrimaryButton>
        </div>
      </div>
    );

    if (step >= 2 && step < 2 + flagged.length && curOrganLocal && curDataLocal) return (
      <div style={{ animation: `${anim} 0.38s cubic-bezier(0.22,1,0.36,1) both` }}>
        <div style={{ fontSize: 12, letterSpacing: '0.13em', color: 'rgba(251,191,36,0.74)', textTransform: 'uppercase', marginBottom: 16, fontWeight: 800 }}>
          Finding {step - 1} of {flagged.length}
        </div>
        <h1 style={{ fontSize: 44, lineHeight: 1.02, letterSpacing: '-0.065em', color: '#fbbf24', margin: '0 0 16px', fontWeight: 860 }}>
          {labelize(curOrganLocal)}
        </h1>
        <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.78)', lineHeight: 1.56, margin: '0 0 18px' }}>
          {lang === 'patient' ? patientLocal : (medLocal || impressionText || 'This finding is listed in the report.')}
        </p>
        {lang === 'patient' && (
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.50)', lineHeight: 1.55, margin: '0 0 22px' }}>
            Your doctor can explain what this means with your symptoms and medical history.
          </p>
        )}
        {lang === 'clinical' && (
          <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.48)', lineHeight: 1.55, margin: '0 0 22px' }}>
            Measurements and original report text are shown in the panel on the right.
          </p>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <SecondaryButton onClick={() => go(step - 1)}>← Back</SecondaryButton>
          <PrimaryButton onClick={() => go(step + 1)} amber={step < 1 + flagged.length}>
            {step < 1 + flagged.length ? 'Next finding →' : 'Finish →'}
          </PrimaryButton>
        </div>
      </div>
    );

    const allClear = flagged.length === 0;
    return (
      <div style={{ animation: `${anim} 0.42s cubic-bezier(0.22,1,0.36,1) both`, textAlign: 'center' }}>
        <div style={{ fontSize: 12, letterSpacing: '0.14em', color: allClear ? 'rgba(110,231,183,0.72)' : 'rgba(255,255,255,0.44)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>Final impressions</div>
        <h1 style={{ fontSize: 46, lineHeight: 1.02, letterSpacing: '-0.065em', color: allClear ? '#6ee7b7' : '#fff', margin: '0 0 20px', fontWeight: 860 }}>
          {allClear ? 'All clear.' : (data.impression?.length === 1 ? 'Final Impressions:' : 'Final findings.')}
        </h1>
        {data.impression?.length > 0 && (
          <div style={{ padding: '20px 22px', borderRadius: 22, background: allClear ? 'rgba(110,231,183,0.075)' : 'rgba(251,191,36,0.075)', border: `1px solid ${allClear ? 'rgba(110,231,183,0.18)' : 'rgba(251,191,36,0.18)'}`, margin: '0 0 22px', textAlign: 'left' }}>
            <div style={{ fontSize: 12, color: allClear ? 'rgba(110,231,183,0.72)' : 'rgba(251,191,36,0.72)', marginBottom: 10, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 780 }}>Report impression</div>
            <p style={{ fontSize: 21, color: 'rgba(255,255,255,0.90)', lineHeight: 1.45, margin: 0, fontWeight: 650 }}>
              {getImpressionText(data)}
            </p>
          </div>
        )}
        <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, margin: '0 auto 26px', maxWidth: 430 }}>
          Final note: discuss this report with your doctor so they can interpret it with your symptoms, history, and other tests.
        </p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <SecondaryButton onClick={() => go(step - 1)}>← Back</SecondaryButton>
          <PrimaryButton onClick={() => go(0)}>Start over</PrimaryButton>
        </div>
      </div>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, lang, data, plain2, pLoad]);

  if (!loading && !data) return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none' }}>
      <style>{STYLES}</style>
      <style>{step === 0
        ? `.render { filter: blur(12px) brightness(0.40) !important; transform: scale(0.96) !important; transition: filter 0.55s cubic-bezier(0.22,1,0.36,1), transform 0.55s cubic-bezier(0.22,1,0.36,1) !important; }`
        : step === 1
          ? `.render { filter: none !important; transform: translateX(180px) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
          : step === totalSteps - 1
            ? `.render { filter: blur(1.5px) brightness(0.55) !important; transform: scale(1.02) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
            : `.render { filter: none !important; transform: translateX(0) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`}</style>
      <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
        <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 14, margin: 0 }}>Report unavailable.</p>
        <button onClick={onClose} style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)', border: '0.5px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.5)', borderRadius: 8, padding: '7px 20px', cursor: 'pointer', fontFamily: 'inherit' }}>Close</button>
      </div>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, pointerEvents: 'none' }}>
      <style>{STYLES}</style>
      <style>{step === 0
        ? `.render { filter: blur(12px) brightness(0.40) !important; transform: scale(0.96) !important; transition: filter 0.55s cubic-bezier(0.22,1,0.36,1), transform 0.55s cubic-bezier(0.22,1,0.36,1) !important; }`
        : step === 1
          ? `.render { filter: none !important; transform: translateX(180px) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
          : step === totalSteps - 1
            ? `.render { filter: blur(1.5px) brightness(0.55) !important; transform: scale(1.02) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`
            : `.render { filter: none !important; transform: translateX(0) !important; transition: filter 0.45s cubic-bezier(0.22,1,0.36,1), transform 0.45s cubic-bezier(0.22,1,0.36,1) !important; }`}</style>

      {loading && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, pointerEvents: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
            <div style={{ position: 'relative', width: 48, height: 48 }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid rgba(255,255,255,0.06)' }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: '1.5px solid transparent', borderTop: '1.5px solid rgba(255,255,255,0.55)', animation: 'spin 1s linear infinite' }} />
              <div style={{ position: 'absolute', inset: 8, borderRadius: '50%', border: '1px solid transparent', borderTop: '1px solid rgba(255,255,255,0.2)', animation: 'spin 1.6s linear infinite reverse' }} />
            </div>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.06em' }}>Preparing your report…</span>
          </div>
        </div>
      )}

      {!loading && data && (
        <>
          {/* soft stage lighting behind the scan */}
          <div style={{ position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'none', background: 'radial-gradient(circle at 52% 50%, rgba(255,255,255,0.055), transparent 34%)' }} />

          {/* Top bar */}
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 76, zIndex: modePromptOpen ? 10006 : 10001, pointerEvents: 'auto', background: 'rgba(6,8,12,0.88)', backdropFilter: 'blur(22px)', WebkitBackdropFilter: 'blur(22px)', borderBottom: '0.5px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', padding: '0 28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 270 }}>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.36)', letterSpacing: '0.12em', fontWeight: 760 }}>BODYMAPS</span>
              <span style={{ color: 'rgba(255,255,255,0.16)', fontSize: 11 }}>·</span>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.52)' }}>{caseSummary(id, data.patient)}</span>
            </div>

            <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
              <span style={{ fontSize: 15, color: 'rgba(255,255,255,0.92)', letterSpacing: '0.025em', fontWeight: 720 }}>
                {step === 0 ? 'Your CT Scan' : 'Understanding Your CT Scan'}
              </span>
              {step > 0 && (
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  {Array.from({ length: totalSteps - 1 }).map((_, i) => {
                    const progressIndex = i + 1;
                    return (
                      <button key={i} onClick={() => go(progressIndex)} style={{ height: 3, width: progressIndex === step ? 30 : 9, border: 'none', cursor: 'pointer', padding: 0, borderRadius: 999, transition: 'all 0.35s cubic-bezier(0.22,1,0.36,1)', background: progressIndex === step ? '#fbbf24' : progressIndex < step ? 'rgba(251,191,36,0.42)' : 'rgba(255,255,255,0.18)' }} />
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
              {step > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', padding: 3, borderRadius: 999, background: modePromptOpen ? 'rgba(255,255,255,0.13)' : 'rgba(255,255,255,0.055)', border: modePromptOpen ? '1px solid rgba(255,255,255,0.32)' : '1px solid rgba(255,255,255,0.10)', boxShadow: modePromptOpen ? '0 0 0 6px rgba(255,255,255,0.06), 0 18px 60px rgba(0,0,0,0.42)' : 'none', transition: 'all 0.25s cubic-bezier(0.22,1,0.36,1)' }}>
                  <button className="rs-toggle" onClick={() => { setLang('patient'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'patient' ? '#08090b' : 'rgba(255,255,255,0.58)', background: lang === 'patient' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'all 0.2s' }}>Patient</button>
                  <button className="rs-toggle" onClick={() => { setLang('clinical'); setModePromptOpen(false); }} style={{ padding: '8px 14px', borderRadius: 999, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 720, color: lang === 'clinical' ? '#08090b' : 'rgba(255,255,255,0.58)', background: lang === 'clinical' ? 'rgba(255,255,255,0.86)' : 'transparent', transition: 'all 0.2s' }}>Doctor</button>
                </div>
              )}
              <div style={{ position: 'relative' }}>
                <button
                  onClick={() => { setShareOpen((v) => !v); mintShareLink(); }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: shareOpen ? 'rgba(255,255,255,0.10)' : 'transparent',
                    border: '1px solid rgba(255,255,255,0.16)',
                    borderRadius: 12,
                    padding: '9px 13px',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    color: 'rgba(255,255,255,0.78)',
                    transition: 'all 0.2s',
                  }}
                >
                  <span style={{ fontSize: 14, lineHeight: 1 }}>&#128279;</span>
                  <span style={{ fontSize: 11, letterSpacing: '0.04em' }}>Share report</span>
                </button>

                {shareOpen && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    style={{
                    position: 'absolute', top: 'calc(100% + 10px)', right: 0, zIndex: 20000,
                    width: 340, background: '#141518', border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: 14, padding: 16, boxShadow: '0 18px 60px rgba(0,0,0,0.5)',
                  }}>
                    <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.86)', lineHeight: 1.5, marginBottom: 12 }}>
                      Share this link with anyone — a family member, your doctor, whoever needs it. It opens a
                      de-identified, readable summary of this scan.
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div style={{
                        flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 10, padding: '8px 10px', fontSize: 12, color: 'rgba(255,255,255,0.65)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {shareLoading ? 'Generating link…' : (shareUrl || 'Link unavailable')}
                      </div>
                      <button
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
                          transition: 'all 0.2s',
                        }}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <button className="rs-exit" onClick={onClose} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: '1px solid rgba(239,68,68,0.24)', borderRadius: 12, padding: '9px 13px', cursor: 'pointer', fontFamily: 'inherit', color: 'rgba(239,68,68,0.78)', transition: 'all 0.2s' }}>
                <span style={{ fontSize: 14, lineHeight: 1, fontWeight: 300 }}>✕</span>
                <span style={{ fontSize: 11, letterSpacing: '0.04em' }}>Exit</span>
              </button>
            </div>
          </div>

          {/* Intro: cinematic centered card */}
          {step === 0 && (
            <div style={{
              position: 'fixed',
              inset: '76px 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '24px',
            }}>
              <div style={{
                ...glass,
                pointerEvents: 'auto',
                width: 560,
                maxWidth: 'calc(100vw - 48px)',
                padding: '38px 42px',
                textAlign: 'center',
                animation: `${anim} 0.42s cubic-bezier(0.22,1,0.36,1) both`,
              }}>
                <div style={{ fontSize: 12, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.42)', textTransform: 'uppercase', marginBottom: 18, fontWeight: 800 }}>CT Scan Review</div>
                <h1 style={{ fontSize: 48, lineHeight: 1.02, letterSpacing: '-0.065em', color: '#fff', margin: '0 0 18px', fontWeight: 860 }}>
                  {flagged.length > 0 ? 'Your scan looks mostly healthy.' : 'Your scan looks healthy.'}
                </h1>
                <p style={{ fontSize: 18, color: 'rgba(255,255,255,0.70)', lineHeight: 1.55, margin: '0 auto 26px', maxWidth: 430 }}>
                  {flagged.length > 0
                    ? `${normal.length} organ${normal.length === 1 ? '' : 's'} look healthy. ${flagged.length} finding${flagged.length === 1 ? '' : 's'} will be explained.`
                    : `All ${normal.length} organ${normal.length === 1 ? '' : 's'} look healthy. No findings to review.`}
                </p>
                <button
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
                    transition: 'all 0.22s cubic-bezier(0.22,1,0.36,1)',
                  }}
                >
                  Start walkthrough →
                </button>
              </div>
            </div>
          )}


          {/* Coachmark: after Start walkthrough, point users to the existing Patient / Doctor toggle */}
          {modePromptOpen && step > 0 && (
            <>
              {/* Clicking the veil dismisses the coachmark (the current lang
                  stays as-is; the toggle in the top bar remains available). */}
              <div onClick={() => setModePromptOpen(false)} style={{
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

              <div style={{
                position: 'fixed',
                right: 112,
                top: 94,
                zIndex: 10007,
                pointerEvents: 'none',
                display: 'flex',
                alignItems: 'flex-start',
                gap: 14,
                animation: 'riseIn 0.26s ease both',
              }}>
                <div style={{
                  width: 92,
                  height: 54,
                  borderTop: '2px solid rgba(255,255,255,0.78)',
                  borderRight: '2px solid rgba(255,255,255,0.78)',
                  borderTopRightRadius: 28,
                  transform: 'translateY(4px) rotate(-8deg)',
                  position: 'relative',
                }}>
                  <span style={{
                    position: 'absolute',
                    right: -6,
                    top: -7,
                    width: 12,
                    height: 12,
                    borderTop: '2px solid rgba(255,255,255,0.78)',
                    borderRight: '2px solid rgba(255,255,255,0.78)',
                    transform: 'rotate(45deg)',
                  }} />
                </div>

                <div style={{
                  ...glass,
                  width: 330,
                  padding: '22px 24px',
                  boxShadow: '0 26px 90px rgba(0,0,0,0.46), inset 0 1px 0 rgba(255,255,255,0.08)',
                }}>
                  <div style={{
                    fontSize: 12,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'rgba(255,255,255,0.44)',
                    fontWeight: 820,
                    marginBottom: 10,
                  }}>
                    Choose your view
                  </div>
                  <div style={{
                    fontSize: 27,
                    lineHeight: 1.06,
                    letterSpacing: '-0.045em',
                    color: '#fff',
                    fontWeight: 850,
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


          {/* LEFT story panel */}
          {step > 0 && step < totalSteps - 1 && (
            <div className="rs-scroll" style={{ ...glass, position: 'fixed', left: 64, top: 'calc(50% + 38px)', transform: 'translateY(-50%)', zIndex: 10001, pointerEvents: 'auto', width: 360, maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: 24 }}>
              {leftContent}
            </div>
          )}

          {/* FINAL centered impression panel */}
          {step === totalSteps - 1 && (
            <div style={{
              position: 'fixed',
              inset: '76px 0 0',
              zIndex: 10001,
              pointerEvents: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}>
              <div className="rs-scroll" style={{ ...glass, pointerEvents: 'auto', width: 560, maxWidth: 'calc(100vw - 48px)', maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: 34 }}>
                {leftContent}
              </div>
            </div>
          )}

          {/* RIGHT evidence panel */}
          {step > 1 && step < totalSteps - 1 && (
            <div style={{ position: 'fixed', right: 72, top: 'calc(50% + 38px)', transform: 'translateY(-50%)', zIndex: 10001, pointerEvents: 'auto' }}>
              <EvidencePanel
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
            <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 10001, pointerEvents: 'auto' }}>
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
        </>
      )}
    </div>
  );
}
