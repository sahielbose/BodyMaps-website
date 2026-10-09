import React, {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

// LesionSegmenter's four lesions, offered as a macOS-style submenu off the model
// item.
const LESION_OPTIONS: {
  id: "pancreatic" | "liver" | "kidney" | "colon";
  label: string;
}[] = [
  { id: "pancreatic", label: "Pancreatic lesion" },
  { id: "liver", label: "Liver lesion" },
  { id: "kidney", label: "Kidney lesion" },
  { id: "colon", label: "Colon lesion" },
];

// Preprocessing and postprocessing steps. Neither alternative is wired into
// the run yet (nothing consumes the value), so each is listed as coming soon.
const PRE_OPTIONS: Omit<PipelineMenuItem, "checked">[] = [
  { id: "", label: "None (skip)", desc: "Upload and segment as-is" },
  {
    id: "OpenVAE",
    label: "OpenVAE",
    desc: "Enhance the scan quality before segmenting",
    disabled: true,
    badge: "Coming soon",
  },
];
const POST_OPTIONS: Omit<PipelineMenuItem, "checked">[] = [
  { id: "", label: "None (skip)", desc: "Use results as-is" },
  {
    id: "ShapeKit",
    label: "ShapeKit",
    desc: "Clean up and smooth organ outlines",
    disabled: true,
    badge: "Coming soon",
  },
];

// SuPreM, MedFormer, and R-Super are deliberately not offered here - the
// models themselves are untouched (backend dispatch, existing runs of them
// in Completed Uploads, etc. all still work), this just hides them from the
// picker.
//
// `details` backs the always-visible model info card next to the picker -
// kept short and concrete (what it actually segments, what it's for) rather
// than marketing language, and left off where nothing more specific than
// `desc` is known.
const MODEL_OPTIONS: {
  id: string;
  label: string;
  desc: string;
  details?: string[];
  // Headline numbers for the comparison grid - short "value / label" pairs in
  // the spirit of Apple's compare-page Quick Look rows. Every value here is a
  // fact already stated in `details` below, just pulled out and made
  // scannable rather than buried in prose.
  quickFacts?: { value: string; label: string }[];
}[] = [
  {
    id: "None",
    label: "None",
    desc: "View only: files never leave your browser",
    quickFacts: [
      { value: "Browser-only", label: "Where it runs" },
      { value: "None", label: "Inference" },
    ],
    details: [
      "Nothing is uploaded: the scan opens straight in the local viewer from your browser's memory.",
      "No inference runs, so there's nothing to download or share afterward.",
    ],
  },
  {
    id: "ePAI",
    label: "ePAI",
    desc: "Full abdominal organ segmentation, with detailed pancreas and tumor analysis",
    quickFacts: [
      { value: "25", label: "Structures segmented" },
      { value: "3", label: "Pancreas tumor subtypes" },
      { value: "Abdominal", label: "Best for" },
    ],
    details: [
      "25 structures in one pass",
      "Major organs, vasculature, pancreas region",
      "Pancreas gland, duct, and 3 tumor subtypes (PDAC, cyst, PNET)",
      "Built for abdominal CT, not whole-body scans",
    ],
  },
  {
    id: "Atlas-Net",
    label: "Atlas-Net",
    desc: "For anatomically consistent results, with the same organ and tumor coverage as ePAI",
    quickFacts: [
      { value: "25", label: "Structures segmented" },
      { value: "3", label: "Pancreas tumor subtypes" },
      { value: "Plausibility", label: "Optimized for" },
    ],
    details: [
      "25 structures in one pass, same nnU-Net-based coverage as ePAI",
      "Major organs, vasculature, pancreas region",
      "Pancreas gland, duct, and 3 tumor subtypes (PDAC, cyst, PNET)",
      "Matches segmentations to a known anatomical atlas",
    ],
  },
  {
    id: "LesionSegmenter",
    label: "LesionSegmenter",
    desc: "For fast pancreatic lesion detection",
    quickFacts: [
      { value: "4", label: "Organs covered" },
      { value: "Pancreatic", label: "Validated lesion type" },
      { value: "Fast", label: "Speed" },
    ],
    details: [
      "Lesions in 4 organs in one pass",
      "Pick which organ to feature as the primary result",
      "Pancreatic lesion detection validated against ground truth",
      "Optimized for speed over broader organ coverage",
    ],
  },
];
import { useNavigate } from "react-router-dom";
import "./UploadPage.css";
import UploadPipelineMenu, { type PipelineMenuItem } from "./UploadPipelineMenu";

// Lazy so NiiVue / Cornerstone aren't pulled into the upload bundle until a file
// is actually previewed. CtPreview handles NIfTI, DicomPreview handles a DICOM series.
const CtPreview = lazy(() => import("../components/CtPreview/CtPreview"));
const DicomPreview = lazy(() => import("../components/CtPreview/DicomPreview"));
import { API_BASE } from "../helpers/constants";
import {
  addRecentUpload,
  friendlyScanName,
  markRecentUploadViewed,
  renameRecentUpload,
  formatRelativeTime,
  batchFinishedLabel,
  scanSourceName,
  scanAccessibleName,
  groupUploads,
  batchButtonNames,
  isGroupInFlight,
  loadRecentUploads,
  mergeServerRuns,
  persistRecentUploads,
  recentStatusColor,
  removeRecentUpload,
  runsOf,
  splitByAge,
  updateRecentUploadStatus,
  type RecentUpload,
} from "../helpers/recentUploads";
import Header from "../components/Header";
import ProcessingSummaryBar, { batchAnnouncement } from "../components/ProcessingSummaryBar";
import BatchDetailsModal from "../components/BatchDetailsModal";
import { track } from "../helpers/analytics";
import UpgradeDialog, { type UpgradeBlock } from "../components/UpgradeDialog";
import { useAuth } from "../contexts/authContext";
import {
  gatingPlan,
  isModelLocked,
  maxConcurrentScans,
  type PlanId,
} from "../helpers/accountProfile";
import { countDicomSlices, looksLikeDicom, setLocalDicomFiles } from "../helpers/dicomLocal";
import { setLocalNiftiFile } from "../helpers/localNifti";
import {
  chunkSizeOf,
  deletePendingUpload,
  loadPendingUploads,
  savePendingUpload,
  setPendingNextChunk,
  setPendingUploaded,
  type PendingUpload,
} from "../helpers/pendingUploads";
import { postWithRetry, resolveResumeStart } from "../helpers/chunkUpload";
import { startEpaiOnReconstruction } from "../helpers/epaiOnReconstruction";
import { fetchListedRuns, RUNS_ADOPTED_EVENT, type RunsAdopted } from "../helpers/adoptLegacyRuns";
import { forgetQueuedDiscard, queuedDiscards, queueDiscardAfterSignIn } from "../helpers/discardAfterSignIn";
import SiteFooter from "../components/SiteFooter";

// A reply that isn't JSON came from something in front of the app (a proxy's
// HTML error page while the server restarts, say). The raw detail (content
// type, HTTP status, the start of the body) goes to the console for
// debugging; the page only ever shows the plain sentence.
const parseApiResponse = async (res: Response): Promise<any> => {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  const text = await res.text();
  const shortBody = text.slice(0, 200).replace(/\s+/g, " ").trim();
  console.error(
    `Expected JSON but got ${contentType || "unknown content-type"} (HTTP ${res.status}). Body: ${shortBody}`,
  );
  throw new Error(
    [502, 503, 504].includes(res.status)
      ? "The server is busy or restarting."
      : "The server sent a reply this page couldn't read.",
  );
};

// A 409 from the server: the upload it holds no longer matches what this page
// is sending (a leftover session it can no longer vouch for, or a chunk count
// that changed mid-upload). Its wording is written for API clients, so
// uploadFailureReason phrases it for people.
class UploadConflictError extends Error {}

// The error a non-OK upload reply becomes: the server's own message, typed
// when it is a 409.
const uploadReplyError = (res: Response, data: { error?: string }, fallback: string): Error =>
  res.status === 409
    ? new UploadConflictError(data.error || fallback)
    : new Error(data.error || fallback);

// The upload endpoints take at most this many chunks per file (the server
// refuses more). With CHUNK_SIZE it caps a NIfTI at about 4.8 GiB.
const MAX_UPLOAD_CHUNKS = 10_000;

// A NIfTI the server can never take: nothing to send, or more chunks than it
// allows. Checked when the file is picked, so the person hears about the file
// at once instead of after an upload that no retry can fix.
const unusableNiftiReason = (file: File, chunkSize: number): string | null => {
  if (file.size === 0)
    return `${file.name} is empty (0 bytes). Download or export it again and select it once more.`;
  if (file.size > MAX_UPLOAD_CHUNKS * chunkSize)
    return `${file.name} is too large to upload. The limit is about 4.8 GiB.`;
  return null;
};

// The server's replies to a file it can never take (see MAX_UPLOAD_CHUNKS),
// which only reach the page when a file got past the pick-time check.
const UNUSABLE_FILE_MESSAGE =
  "The server can't take this file because it is empty or too large (the limit is about 4.8 GiB). Check the file and select it again.";
const isUnusableFileReply = (err: unknown): boolean =>
  err instanceof Error && /\binvalid total_chunks\b|outside upload bounds/i.test(err.message);

// What the status line says went wrong with an upload: one or more whole
// sentences, so callers can add what to do next without nesting punctuation.
// fetch rejects with a TypeError when the request never got an answer.
const uploadFailureReason = (err: unknown): string => {
  if (err instanceof TypeError) return "The connection to the server was lost.";
  const text = err instanceof Error ? err.message.trim() : "";
  if (!text) return "The server didn't say why.";
  // A 409 words its own fix ("restart the upload"), which would sit beside
  // ours.
  if (/^Upload ownership is unknown/i.test(text)) return "The server no longer has this upload.";
  if (err instanceof UploadConflictError || /total_chunks changed/i.test(text))
    return "The upload was interrupted and needs to start over.";
  // The server refuses a file with no bytes (no chunks to send) or more than
  // MAX_UPLOAD_CHUNKS chunks. Both are about the file, not the connection.
  if (isUnusableFileReply(err)) return UNUSABLE_FILE_MESSAGE;
  // A parameter name (snake_case) means the server answered in API terms;
  // the raw text goes to the console, not the page.
  if (/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/i.test(text)) {
    console.error("Upload failure reason withheld from the page:", text);
    return "The server couldn't finish the upload.";
  }
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

// What the status line says when a run, a download or a restart of a run
// fails on the server. The server's text is written for operators (session
// ids, process exit statuses, internal state), so it goes to the console and
// the page gets a sentence. fetch rejects with a TypeError when the request
// never got an answer.
const serverFailureReason = (err: unknown, fallback: string): string => {
  if (err instanceof TypeError) return "The connection to the server was lost.";
  console.error("Server failure reason withheld from the page:", err);
  return fallback;
};

// The server refuses a session id whose upload another account owns (403).
// A sign-out or account switch drops every pre-upload before that can happen,
// but a leftover from an older tab can still get here, and it deserves a
// reason rather than a wordless Failed card.
const FOREIGN_SESSION_MESSAGE =
  "This scan was started under a different account, so it can't run here. Select the file again and press Run.";
class ForeignSessionError extends Error {}

// A 401 on an upload request: the sign-in lapsed (or was ended in another tab)
// while this page still believed it was signed in. dispatchInference and the
// status poll already answer it with a sentence and the sign-in popup; the
// upload half does the same instead of ending in a wordless Failed card.
const UPLOAD_SESSION_EXPIRED_MESSAGE =
  "Your session expired during the upload. Sign in and run the scan again.";
class SignedOutError extends Error {}

// The results request answering 202: the archive is not there (yet).
class ResultNotReadyError extends Error {}

// The server answering the run request with a refusal: its status picks the
// sentence (a 400 is about the file, anything else about the server).
class RunRejectedError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// What View says when several scans are selected with no model. It is cleared
// as soon as a model is chosen, so it is named to be compared against.
const VIEW_ONE_SCAN_MESSAGE =
  "View opens one scan at a time. Remove the others, or choose a model to run them as a batch.";

// A 413 from the server. Picking the same file again or pressing Run again
// sends the same bytes into the same limit, so this failure never says to
// retry.
class TooLargeError extends Error {}

// Uploads outlive the page. Leaving /upload unmounts it, but an upload or
// dispatch already under way carries on in the old page's closures, and the
// page mounted on return used to start the same session again: a second copy
// of the upload that raced the first to finalize (the loser marked a healthy
// run Failed), or a poll for a job that didn't exist yet, which marked it
// Failed after three misses. So the abort controllers, and a hold on every
// session whose upload or dispatch is still running, live in module scope
// where each mount of the page sees them. A held session is left to finish.
const uploadControllers = new Map<string, AbortController>();
// Upload progress lives out here for the same reason: a page mounted while an
// earlier one is still sending reads the same bytes, so its "safe to close"
// line and its unload warning describe the upload that is really running.
const sharedUploadRemaining = new Map<string, number>();
const sharedBytesSent = { current: 0 };
const sharedUploadResumable = { current: false };
// Uploads still waiting for their turn on a page's one-file-at-a-time line, by
// session, one ticket per queued turn. The line is the page that queued the
// upload's, but Cancel can come from a page mounted after it, so this lives
// here too: cancelling deletes the session and the turn that finds its ticket
// gone never starts.
const queuedUploads = new Map<string, Set<symbol>>();
// Cancel can also land before a run has a controller or a ticket: while its
// resumable copy is being written, or while another tab is being asked whether
// it carries the session. Those steps go on regardless, so they check, before
// anything reaches the wire, that the run was not cancelled. The sessions
// cancelled in this tab are remembered, because the card alone can be removed
// (or trimmed off the list) after a Cancel; the card being Cancelled is what
// tells a tab that was never told, when there is no BroadcastChannel.
const cancelledSessions = new Set<string>();
const runCancelled = (sid: string): boolean =>
  cancelledSessions.has(sid) ||
  loadRecentUploads().find((u) => u.sessionId === sid)?.status === "Cancelled";

/** Cancels a session's upload in this tab: aborts it, or takes it out of the line. */
const cancelSessionUpload = (sid: string) => {
  cancelledSessions.add(sid);
  uploadControllers.get(sid)?.abort();
  // Waiting behind another file: it never starts, and the bytes it registered
  // are dropped, which nothing else would.
  if (queuedUploads.delete(sid)) sharedUploadRemaining.delete(sid);
};

// Cancel can only reach what its own tab holds: a session another tab carries
// (see the tab locks below) has its controller and its place in the line in
// that tab's memory. So the tab that cancels announces it, and every tab stops
// that session's upload and refreshes its cards. Without BroadcastChannel the
// card being Cancelled is still seen by the holder before it dispatches.
const CANCEL_CHANNEL = "bodymaps-upload-cancel";
let cancelChannel: BroadcastChannel | null | undefined;
const cancelListeners = new Set<(sid: string) => void>();
const openCancelChannel = (): BroadcastChannel | null => {
  if (cancelChannel !== undefined) return cancelChannel;
  try {
    cancelChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CANCEL_CHANNEL);
    cancelChannel?.addEventListener("message", (e: MessageEvent) => {
      const sid = (e.data as { sid?: unknown } | null)?.sid;
      if (typeof sid !== "string") return;
      cancelSessionUpload(sid);
      cancelListeners.forEach((listener) => listener(sid));
    });
  } catch {
    cancelChannel = null;
  }
  return cancelChannel;
};
const announceCancel = (sid: string) => {
  try {
    openCancelChannel()?.postMessage({ sid });
  } catch {
    // Nobody to tell; the holder still refuses to dispatch a Cancelled run.
  }
};
/** Calls back when another tab cancels a session; returns the way to stop listening. */
const onCancelFromOtherTab = (listener: (sid: string) => void): (() => void) => {
  openCancelChannel();
  cancelListeners.add(listener);
  return () => {
    cancelListeners.delete(listener);
  };
};
// The holds only see this tab. A Web Lock per session, taken with the first
// hold and let go with the last, tells every other tab on /upload that this one
// is carrying the session, so two tabs never resume one IndexedDB upload (or
// poll for a job the other tab has not dispatched yet). A lock also goes when
// its tab closes, which hands the session to the tab waiting on it. Browsers
// without Web Locks keep the in-tab hold alone.
const sessionLockName = (sid: string) => `bodymaps-upload:${sid}`;
const webLocks = (): LockManager | undefined =>
  typeof navigator === "undefined" ? undefined : navigator.locks;

/** Takes a session's lock if no tab holds it: its release, or null when another tab does. */
const lockSessionAcrossTabs = (sid: string): Promise<(() => void) | null> => {
  const locks = webLocks();
  if (!locks) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    try {
      locks
        .request(sessionLockName(sid), { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          // Held until the release below settles this promise.
          return new Promise<void>((release) => resolve(() => release()));
        })
        .catch(() => resolve(() => {}));
    } catch {
      resolve(() => {});
    }
  });
};

/** Resolves once no other tab holds the session's lock, or the signal aborts. */
const waitForSessionLock = (sid: string, signal: AbortSignal): Promise<void> => {
  const locks = webLocks();
  if (!locks) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      locks
        .request(sessionLockName(sid), { signal }, () => resolve())
        .catch(() => resolve());
    } catch {
      resolve();
    }
  });
};

type SessionHold = {
  count: number;
  settled: Promise<void>;
  settle: () => void;
  tabLock: Promise<(() => void) | null>;
};
const sessionHolds = new Map<string, SessionHold>();

/** Holds a session until the returned release is called (once is enough). */
const holdSession = (sid: string): (() => void) => {
  let hold = sessionHolds.get(sid);
  if (!hold) {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    hold = { count: 0, settled, settle, tabLock: lockSessionAcrossTabs(sid) };
    sessionHolds.set(sid, hold);
  }
  const held = hold;
  held.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count === 0) {
      sessionHolds.delete(sid);
      void held.tabLock.then((unlock) => unlock?.());
      held.settle();
    }
  };
};

/** Whether this tab got the lock for a session it holds (false: another tab is carrying it). */
const holdsTabLock = async (sid: string): Promise<boolean> =>
  (await sessionHolds.get(sid)?.tabLock) !== null;

/** Whether no other tab is carrying the session right now (nothing stays held). */
const sessionFreeAcrossTabs = async (sid: string): Promise<boolean> => {
  const unlock = await lockSessionAcrossTabs(sid);
  unlock?.();
  return unlock !== null;
};

/**
 * For tests. What is above belongs to the tab, not to a mounted page, so it
 * outlives the page and, in a test file, outlives the test that filled it.
 */
export const __resetUploadTabState = () => {
  cancelledSessions.clear();
  queuedUploads.clear();
  uploadControllers.clear();
  sharedUploadRemaining.clear();
  sharedBytesSent.current = 0;
  sharedUploadResumable.current = false;
  sessionHolds.forEach((hold) => hold.settle());
  sessionHolds.clear();
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
};

// Source file, model and age of a single scan, as separate items with the same
// bullet separator the batch row uses, so rows in one list punctuate alike. The
// separator is its own element (not text glued to the source), so the phone can
// drop the one after the source name when the name takes its own line.
const scanMetaItems = (u: RecentUpload): React.ReactNode[] => {
  const items: React.ReactNode[] = [];
  const source = scanSourceName(u);
  if (source) items.push(<span key="source" className="upload-row__source">{source}</span>);
  if (u.model) items.push(<span key="model">{u.model}</span>);
  items.push(<span key="age">{formatRelativeTime(u.timestamp)}</span>);
  return items.flatMap((item, i) =>
    i === 0 ? [item] : [<span key={`sep${i}`} className="upload-row__sep" aria-hidden="true">•</span>, item],
  );
};

// Coarse on purpose: a to-the-second countdown on a throughput estimate reads as
// precision that isn't there, and jitters distractingly.
const formatEta = (seconds: number): string => {
  if (seconds < 45) return "<1 min";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.round(seconds / 360) / 10} h`;
};

// Best-effort ETA model: floor + a per-model rate applied to the file size.
// There's no real per-size history yet (see /api/inference-duration-estimate,
// which this page prefers once it has enough samples) - this is a stand-in
// built from the one real measurement on hand (a ~700MB whole-body ePAI scan
// end-to-end in ~8 min post CUDA-cache-fix) plus the pipeline's own profiled
// fixed cost (read+preprocess ~ tens of seconds independent of size). A
// straight line through one real point is still a guess for every other
// point on it - it's meant to beat "same number for every file" until real
// history replaces it, not to be precise.
type EtaProfile = { floorSeconds: number; secondsPerMb: number };
const ETA_PROFILES: Record<string, EtaProfile> = {
  // Anchor: ~700MB -> ~480s end-to-end, minus ~60s fixed cost -> ~0.6s/MB.
  ePAI: { floorSeconds: 60, secondsPerMb: 0.6 },
  // No measured anchor for these yet - same shape (fixed cost + linear-ish
  // scaling), scaled down from ePAI's rate as a placeholder, not a measurement.
  LesionSegmenter: { floorSeconds: 45, secondsPerMb: 0.35 },
};
const DEFAULT_ETA_PROFILE: EtaProfile = { floorSeconds: 60, secondsPerMb: 0.45 };

const estimateTypicalSeconds = (model: string, fileSizeBytes?: number): number => {
  const profile = ETA_PROFILES[model] ?? DEFAULT_ETA_PROFILE;
  const mb = (fileSizeBytes ?? 0) / (1024 * 1024);
  return profile.floorSeconds + profile.secondsPerMb * mb;
};

// "~3 min left" from how long the run has been going vs. how long a run
// like this one usually takes. `typicalSecondsOverride` lets the caller swap
// in a real server-measured median (see fetchDurationEstimate) once one is
// available, instead of the size-formula fallback above. Once elapsed passes
// the estimate, there's nothing honest left to say about a remaining
// duration - "Finishing up…" admits the estimate ran out instead of showing
// a fake countdown stuck at "<1 min" or, worse, going negative.
const estimateRemaining = (
  model: string,
  startedAt: number,
  fileSizeBytes?: number,
  typicalSecondsOverride?: number,
): string => {
  const typical = typicalSecondsOverride ?? estimateTypicalSeconds(model, fileSizeBytes);
  const elapsed = (Date.now() - startedAt) / 1000;
  const remaining = typical - elapsed;
  if (remaining < 30) return "Finishing up…";
  return `${formatEta(remaining)} left`;
};

// The ETA needs when a run started going and how big its file was, and the
// server reports neither. Both are seen only by the page that starts the run,
// so they are kept per session here: a reload, or a return to /upload minutes
// later, then picks the countdown up where it was instead of restarting it.
// Best-effort, like the other localStorage readers: without it a resumed run
// simply shows no estimate.
const SCAN_TIMING_KEY = "scanRunTiming";
const SCAN_TIMING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
type ScanTiming = { startedAt?: number; sizeBytes?: number; savedAt: number };
const readScanTimings = (): Record<string, ScanTiming> => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCAN_TIMING_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};
const loadScanTiming = (sid: string): ScanTiming | undefined => {
  const t = readScanTimings()[sid];
  return t && typeof t === "object" ? t : undefined;
};
const saveScanTiming = (sid: string, patch: Partial<ScanTiming>) => {
  try {
    const now = Date.now();
    const all = readScanTimings();
    for (const [key, t] of Object.entries(all)) {
      if (!t || typeof t.savedAt !== "number" || now - t.savedAt > SCAN_TIMING_MAX_AGE_MS) delete all[key];
    }
    all[sid] = { ...all[sid], ...patch, savedAt: now };
    localStorage.setItem(SCAN_TIMING_KEY, JSON.stringify(all));
  } catch {
    /* private mode or a full quota: the estimate just won't survive a reload */
  }
};
const forgetScanTiming = (sid: string) => {
  try {
    const all = readScanTimings();
    if (!(sid in all)) return;
    delete all[sid];
    localStorage.setItem(SCAN_TIMING_KEY, JSON.stringify(all));
  } catch {
    /* nothing stored, or storage unavailable */
  }
};

// A selection is either a single NIfTI file or a picked DICOM folder (the series'
// raw .dcm slices). Both are previewable individually and runnable through inference.
type SelectedItem =
  | { id: string; kind: "nifti"; file: File }
  | { id: string; kind: "dicom"; files: File[]; label: string };

// The File System Access API is available in desktop Chrome and Edge, but it
// is not yet part of TypeScript's DOM declarations. Keep the small read-only
// surface we use here explicit so browsers without it retain the input fallback.
type DirectoryPickerFileHandle = {
  kind: "file";
  getFile: () => Promise<File>;
};

type DirectoryPickerDirectoryHandle = {
  kind: "directory";
  values: () => AsyncIterableIterator<
    DirectoryPickerFileHandle | DirectoryPickerDirectoryHandle
  >;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: () => Promise<DirectoryPickerDirectoryHandle>;
};

const readDirectoryFiles = async (
  root: DirectoryPickerDirectoryHandle,
): Promise<File[]> => {
  const files: File[] = [];

  const visit = async (directory: DirectoryPickerDirectoryHandle) => {
    for await (const entry of directory.values()) {
      if (entry.kind === "file") {
        files.push(await entry.getFile());
      } else {
        await visit(entry);
      }
    }
  };

  await visit(root);
  return files;
};

// Files under dropped entries, folders walked to any depth. The entries come
// from DataTransferItem.webkitGetAsEntry, which only works during the drop.
const readDroppedEntries = async (entries: FileSystemEntry[]): Promise<File[]> => {
  const files: File[] = [];
  const visit = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands back a few hundred at a time and [] once it is done.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
      if (batch.length === 0) return;
      for (const child of batch) await visit(child);
    }
  };
  for (const entry of entries) await visit(entry);
  return files;
};

const UploadPage: React.FC = () => {
  const navigate = useNavigate();
  // Running inference requires an account, so any upload action while signed
  // out opens the auth popup instead of proceeding. It opens on sign-in: most
  // people hitting this already have an account, and the popup switches to
  // sign-up in one click for the ones who don't.
  const { isAuthenticated, loading: authLoading, promptAuth, user, usage, refreshUsage, redeemAdminCoupon } = useAuth();
  // Upload work belongs to the account that started it. authUserIdRef is what
  // the async upload code checks (it outlives the render that started it), and
  // authEpochRef moves on every sign-in, sign-out or account switch so work
  // queued under the previous account can tell it has been superseded. See
  // the account-boundary effect further down.
  const authUserId = user?.id ?? null;
  const authUserIdRef = useRef<string | null>(null);
  const authEpochRef = useRef(0);
  // Runs followed after a 409 whose dispatch has been asked for again (once).
  const replayedAfterFollowRef = useRef(new Set<string>());
  // Resumes runs adopted after the account-boundary effect ran; set by it.
  const resumeAdoptedRef = useRef<((entries: RecentUpload[]) => Promise<void>) | null>(null);
  const ensureAccount = (): boolean => {
    if (isAuthenticated) return true;
    // While /me is still answering the account is not known yet: a signed-in
    // person must not be shown the sign-in popup for that split second.
    if (!authLoading) promptAuth();
    return false;
  };
  // Everything the plan won't allow routes through one dialog; this is what's
  // currently being explained (null = nothing blocked).
  const [upgradeBlock, setUpgradeBlock] = useState<UpgradeBlock | null>(null);
  // Not always user.plan: an admin is gated as the unlimited tier whatever plan
  // their account is on, matching plan_store.limits_for_user.
  const plan = gatingPlan(user);
  // Cosmetic mirror of the server's rules — see helpers/accountProfile. The
  // server still gets the final say via a 402, which lands in the same dialog.
  const modelLocked = (id: string) => isAuthenticated && isModelLocked(plan, id);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Folder picker for a DICOM series (run inference, or view-only when model is "None").
  const dicomUploadInputRef = useRef<HTMLInputElement | null>(null);
  // Hidden fallback for browsers that cannot open a folder picker: select all
  // slices inside the folder instead. This also works on phones and tablets.
  const dicomFilesInputRef = useRef<HTMLInputElement | null>(null);
  // One poll timer per in-flight session so runs can proceed in parallel.
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const pollGenerationRef = useRef<Map<string, symbol>>(new Map());
  // Runs whose polling stopped because the server answered 401: taken up again
  // when the person signs in (see the effect keyed on `user`).
  const signedOutPollsRef = useRef<Map<string, { model: string; followed: boolean }>>(new Map());
  // Whether this page is the one showing. Leaving /upload stops its pollers,
  // but an upload or dispatch it started carries on and can reach
  // startInferencePolling afterwards; see there.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Whether the current foreground upload got stored in IndexedDB (resumable).
  // If IDB was unavailable we fall back to warning before an unload instead.
  const uploadResumableRef = useRef(sharedUploadResumable).current;
  // AbortController per session so a mid-upload run can be cancelled cleanly.
  // Shared by every mount of the page (see uploadControllers), so Cancel and a
  // sign-out also reach an upload started before the page was left.
  const uploadAbortRef = useRef<Map<string, AbortController>>(uploadControllers);
  // Which session currently drives the foreground upload progress bar.
  const foregroundUploadSidRef = useRef<string | null>(null);
  // The batch (if any) claiming the drop zone's status slot right now. Set the
  // moment a batch run starts, cleared when a different run starts or the
  // finished batch is dismissed (View details) - so a just-finished batch
  // keeps showing "Inference complete" in the SAME box that showed its
  // progress, instead of the box going empty while a new panel appears
  // elsewhere. Single-scan runs use sessionId/inferenceCompleted for the same
  // purpose (see the drop zone render below).
  const trackedBatchIdRef = useRef<string | null>(null);
  // Uploads run ONE FILE AT A TIME through this chain. Total upload time is
  // bandwidth-bound either way, but serializing makes the first file land at
  // ~T/N instead of ~T - and since each file is dispatched to the server's job
  // queue the moment its own upload finishes, the GPU starts chewing through
  // the batch while the remaining files are still going up.
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());
  // Bytes still to send, per in-flight session. Summed for the "safe to close"
  // estimate and dropped when a run ends, so a cancelled or failed file can't
  // leave phantom bytes inflating the estimate for its siblings.
  const uploadRemainingRef = useRef(sharedUploadRemaining);
  // Monotonic count of bytes actually put on the wire; the ticker below diffs
  // it to measure throughput.
  const bytesSentRef = useRef(sharedBytesSent).current;
  // Background uploads started the moment a file is selected, keyed by the
  // selected item's id (not its session id, since Run hasn't created one of
  // those yet when this starts). Not IndexedDB-resumable: a reload drops
  // selectedItems entirely (it was never persisted), so there's nothing to
  // resume - the upload just restarts next time the file is picked.
  const itemUploadRef = useRef<
    Map<string, { sid: string; uploadDone: Promise<string | null> }>
  >(new Map());
  // Selected items Run has taken, until their own startScanRun has picked up
  // their pre-upload. That takes a moment per file (each one waits on an
  // IndexedDB write), and leaving the page in between must not discard it.
  const handedToRunRef = useRef<Set<string>>(new Set());

  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([]);
  // Per-item background-upload progress while a file still sits in the
  // dropzone (pre-Run) - drives the file chip's own uploading/done/failed
  // styling instead of the page-wide "Uploading…" status line, which used to
  // show for every background pre-upload even though nothing else on the
  // page needed to react to it.
  const [itemUploadStatus, setItemUploadStatus] = useState<
    Record<string, "uploading" | "done" | "failed">
  >({});
  // 0-100 percent for the file chip's own progress bar while uploading -
  // real chunk-completion progress, not a simulated sweep. Only meaningful
  // while itemUploadStatus[id] === "uploading"; left stale (harmless) once
  // an item leaves the dropzone rather than cleaned up eagerly.
  const [itemUploadProgress, setItemUploadProgress] = useState<
    Record<string, number>
  >({});
  // Why a chip's background upload failed, shown under the dropzone while the
  // chip is still failed. Kept per item rather than in the page-wide status
  // line, so removing the file (or a retry starting) takes its notice with it.
  const [itemUploadError, setItemUploadError] = useState<Record<string, string>>({});
  const itemUploadErrorRef = useRef(itemUploadError);
  itemUploadErrorRef.current = itemUploadError;
  // Server-measured median duration for a session's (model, file size), once
  // fetched - see fetchDurationEstimate. Keyed by session id so each in-flight
  // run's card can prefer a real number over the size-formula guess as soon
  // as one's available; absent (not just undefined) means "haven't checked
  // yet or the server had too little history", both of which fall back to
  // estimateTypicalSeconds silently.
  const [durationEstimates, setDurationEstimates] = useState<
    Record<string, number>
  >({});
  // Which selected item's inline preview is open (null = none). One at a time.
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  // A pick that was refused before anything was added (wrong file type, no DICOM
  // slices, Run with nothing selected). Shown inline as an error, not in a browser dialog.
  const [pickError, setPickError] = useState<string>("");
  // Bumped by each pick, so a slow slice count never notes an older folder.
  const folderNoteSeq = useRef(0);
  const [sessionId, setSessionId] = useState<string>("");
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [inferenceCompleted, setInferenceCompleted] = useState<boolean>(false);
  // Starts "None" until the account's plan is known (auth resolves async, so
  // there's nothing to gate against yet) - see the effect below that picks
  // the real default once it is known.
  const [selectedModel, setSelectedModel] = useState<
    | "None"
    | "ePAI"
    | "SuPreM"
    | "OpenVAE"
    | "MedFormer"
    | "R-Super"
    | "Atlas-Net"
    | "LesionSegmenter"
    | ""
  >("None");
  // Whether the model picker still holds its untouched starting value - once
  // the user opens the dropdown and picks anything (including re-picking the
  // same default), this goes false and the plan-aware default effect below
  // stops touching selectedModel, so it can never clobber a real choice.
  const modelTouchedRef = useRef(false);
  // The comparison cards, in order, for the radio group's arrow keys.
  const modelCardRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [modelDropOpen, setModelDropOpen] = useState(false);
  const [couponOpen, setCouponOpen] = useState(false);
  const [couponValue, setCouponValue] = useState("");
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState<string | null>(null);
  // LesionSegmenter computes liver/pancreatic/kidney/colon lesions in one pass;
  // this selects which lesion to feature.
  const [lesionTarget, setLesionTarget] = useState<
    "pancreatic" | "liver" | "kidney" | "colon"
  >("pancreatic");

  const couponInputRef = useRef<HTMLInputElement>(null);
  const couponRefocusRef = useRef(false);
  useEffect(() => {
    if (!couponRefocusRef.current) return;
    couponRefocusRef.current = false;
    document.querySelector<HTMLElement>('button[aria-labelledby^="upload-step-model "]')?.focus();
  }, [modelDropOpen, couponOpen]);

  const submitAdminCoupon = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const coupon = couponValue.trim();
    if (!coupon || couponBusy) return;
    setCouponBusy(true);
    setCouponError(null);
    try {
      await redeemAdminCoupon(coupon);
      setCouponValue("");
      setCouponOpen(false);
      // The coupon form goes with the lock, and the menu was opened to get
      // past it: close the menu and hand focus to its trigger (see below).
      couponRefocusRef.current = true;
      setModelDropOpen(false);
      setMessage("Sponsored access enabled. All models are now available.");
    } catch (error) {
      setCouponError(error instanceof Error ? error.message : "That access coupon could not be redeemed.");
      couponInputRef.current?.focus();
    } finally {
      setCouponBusy(false);
    }
  };
  const [preDropOpen, setPreDropOpen] = useState(false);
  const [preValue, setPreValue] = useState("");
  const [postDropOpen, setPostDropOpen] = useState(false);
  const [postValue, setPostValue] = useState("");
  const [isDragOver, setIsDragOver] = useState(false);
  const [recentUploads, setRecentUploads] = useState<RecentUpload[]>(() =>
    loadRecentUploads(),
  );
  // The list is this browser's, but its runs are each someone's (see runsOf):
  // another account's stay in it for their owner's next sign-in, and are not
  // this account's to show or to count against its limit on scans at once. A
  // signed-out visitor sees the runs nobody owns, as paused, and nothing shows
  // until sign-in has settled.
  const ownRecentUploads = useMemo(
    () => runsOf(recentUploads, authUserId, !authLoading),
    [recentUploads, authUserId, authLoading],
  );
  // Inline rename of a scan in the history list: which one is being edited and
  // the working text.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const startRename = (u: RecentUpload) => {
    setRenamingId(u.sessionId);
    setRenameValue(u.label);
  };
  // The scan whose name button takes focus back once its input is gone. Set
  // only when Enter or Escape ends the edit; a blur means focus went
  // somewhere the user chose.
  const renameRefocusRef = useRef<string | null>(null);
  const commitRename = () => {
    if (renamingId) setRecentUploads(renameRecentUpload(renamingId, renameValue));
    setRenamingId(null);
  };
  const endRenameFromKeyboard = (commit: boolean) => {
    renameRefocusRef.current = renamingId;
    if (commit) commitRename();
    else setRenamingId(null);
  };
  useEffect(() => {
    const sid = renameRefocusRef.current;
    if (renamingId !== null || !sid) return;
    renameRefocusRef.current = null;
    Array.from(document.querySelectorAll<HTMLElement>("[data-rename-trigger]"))
      .find((el) => el.dataset.renameTrigger === sid)
      ?.focus();
  }, [renamingId]);
  // Which batch's "View details" popup is open (null = none).
  const [detailsBatchId, setDetailsBatchId] = useState<string | null>(null);
  // What the popup's Download buttons last did, shown inside the popup.
  const [detailsNote, setDetailsNote] = useState("");
  // Bumped whenever the popup opens or closes. A Download keeps reporting
  // after the popup is closed, and its late lines must not land in the next
  // popup, so each report remembers which opening it belongs to. Once that
  // popup is gone the lines go to the page's notice instead, so a failure
  // is not lost.
  const detailsOpeningRef = useRef(0);
  useEffect(() => {
    detailsOpeningRef.current += 1;
    setDetailsNote("");
  }, [detailsBatchId]);
  const sayInDetails = (): ((text: string) => void) => {
    const opening = detailsOpeningRef.current;
    return (text) => {
      if (detailsOpeningRef.current === opening) setDetailsNote(text);
      else setMessage(text);
    };
  };
  // What a Completed uploads Download last did, shown under that section's
  // hint: the page's own notice is up by the dropzone, far out of sight from
  // a row pressed further down. busyDownloads holds the rows (a scan's
  // session id, or a batch id) with a Download still going, so a second
  // press does not start a second zip.
  const [listNote, setListNote] = useState("");
  const [busyDownloads, setBusyDownloads] = useState<string[]>([]);
  const busyDownloadsRef = useRef<string[]>([]);
  // The note clears when another row's Download starts, when the section's
  // rows change, and a few seconds after a download that went through; what
  // went wrong stays until one of the first two.
  const listNoteTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearListNote = () => {
    clearTimeout(listNoteTimerRef.current);
    setListNote("");
  };
  useEffect(() => () => clearTimeout(listNoteTimerRef.current), []);
  const downloadFromList = async (key: string, run: (say: (text: string) => void) => Promise<unknown>) => {
    if (busyDownloadsRef.current.includes(key)) return;
    busyDownloadsRef.current = [...busyDownloadsRef.current, key];
    setBusyDownloads(busyDownloadsRef.current);
    clearListNote();
    let last = "";
    try {
      await run((text) => { last = text; setListNote(text); });
      if (/^(Download started|Downloaded \d+ scans?\.)/.test(last)) {
        listNoteTimerRef.current = setTimeout(() => setListNote(""), 8000);
      }
    } finally {
      busyDownloadsRef.current = busyDownloadsRef.current.filter((k) => k !== key);
      setBusyDownloads(busyDownloadsRef.current);
    }
  };
  // Focus lands here when the popup closes and its opener is gone.
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  // Sub-state of each Active card: "waiting" | "uploading" | "elsewhere" (another
  // tab is uploading it) | "queued" | "running".
  const [sessionPhases, setSessionPhases] = useState<Record<string, string>>(
    {},
  );
  // 1-based GPU queue position while phase is "queued" (server-reported, a
  // best-effort proxy for real dispatch order - see the backend comment on
  // _queued_order). Only ever consulted while phase === "queued", but cleared
  // alongside it anyway so a finished session doesn't hold onto a stale entry.
  const [queuePositions, setQueuePositions] = useState<Record<string, number>>(
    {},
  );
  // When each session's phase first became "running" - the ETA estimate needs
  // this instead of u.timestamp (scan creation) because queue wait time isn't
  // inference time and shouldn't count against the estimate. The poll
  // callback checks this ref; render reads the etaInputs copy below.
  const runningStartedAtRef = useRef<Map<string, number>>(new Map());
  // File size per in-flight session, for the ETA formula's size scaling and
  // for asking the server for a real historical estimate (see
  // fetchDurationEstimate). Write-once at run start; render reads the
  // etaInputs copy below.
  const sessionFileSizeRef = useRef<Map<string, number>>(new Map());
  // What the ETA line renders from: a copy of the two refs above, taken when
  // a session starts running, so render never reads a ref. Written once per
  // run and dropped by clearEtaTracking, so it costs one render each way.
  const [etaInputs, setEtaInputs] = useState<
    Record<string, { startedAt: number; sizeBytes?: number }>
  >({});
  // Re-renders ProcessingCard once a second while anything is running, purely
  // so the "~N min left" text advances - nothing else here depends on it.
  // Gated on a scan actually being in the "running" phase (the only one that
  // shows an estimate): an unconditional 1s re-render of the whole page while
  // idle is wasted work, and it kept the dropzone in a constant reflow (see
  // the transition note in UploadPage.css). A leftover "Processing" entry
  // this tab isn't driving (signed out, or queued) doesn't count.
  const [, setEtaTick] = useState(0);
  const anyRunning = Object.values(sessionPhases).includes("running");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setEtaTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  // The "Just now" / "3 mins ago" on a scan row (and in the batch details
  // dialog) is worked out at render time, and with nothing running nothing
  // renders, so it would stay as it was however long the tab sits open. A
  // slow tick, plus one when the tab comes back to the front (timers are
  // throttled while it is hidden), keeps it in step with the History list.
  const [, setMinuteTick] = useState(0);
  const hasRecentRows = ownRecentUploads.length > 0;
  useEffect(() => {
    if (!hasRecentRows) return;
    const bump = () => setMinuteTick((t) => t + 1);
    const timer = setInterval(bump, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hasRecentRows]);

  // Picks the model picker's real default once the account's plan is known:
  // ePAI for a plan that actually includes it, LesionSegmenter (the one real
  // model every signed-in account has, including Free) otherwise. Runs once
  // auth settles and never again after - modelTouchedRef guards against ever
  // overwriting a choice the user already made, and plan/isAuthenticated
  // settling a second time (e.g. a slow /me response revising itself) must
  // not silently swap the model out from under a user who's already looking
  // at the page. Signed-out visitors are left on "None": defaulting them
  // into a model would just immediately bounce them into the sign-in prompt.
  useEffect(() => {
    if (modelTouchedRef.current || !isAuthenticated) return;
    modelTouchedRef.current = true;
    setSelectedModel(isModelLocked(plan, "ePAI") ? "LesionSegmenter" : "ePAI");
  }, [isAuthenticated, plan]);
  // A guest can pick any model card (the lock only shows once signed in), and
  // that choice survives signing in. Once the account's plan is known, a model
  // it locks gives way to the plan's default, so the picker never shows, and
  // Run never uploads for, a model the server would refuse.
  useEffect(() => {
    if (!isAuthenticated || !isModelLocked(plan, selectedModel)) return;
    setSelectedModel(isModelLocked(plan, "ePAI") ? "LesionSegmenter" : "ePAI");
  }, [isAuthenticated, plan, selectedModel]);
  // Drives the "safe to close this tab" line. `active` = bytes still going up
  // (the tab is needed); `eta` = seconds until that stops, or null while
  // throughput is still being measured.
  const [closeInfo, setCloseInfo] = useState<{
    active: boolean;
    eta: number | null;
  }>({ active: false, eta: null });

  // Queue a file's upload behind whatever is already uploading. A task that
  // was queued under a different sign-in than the one current when its turn
  // comes is skipped (onSkip runs instead): it belongs to an account that
  // signed out, and nothing may go on the wire for it now. Its resumable
  // record stays behind for that account's next sign-in. A task queued with
  // its session id can also be cancelled while it waits (see cancelRun), and
  // then never starts; so does one whose card was cancelled before it was
  // queued. Resolves once the task has run or been skipped.
  const enqueueUpload = (
    task: () => Promise<void>,
    onSkip?: () => void,
    sid?: string,
  ): Promise<void> => {
    const epoch = authEpochRef.current;
    const ticket = Symbol(sid);
    if (sid) {
      const tickets = queuedUploads.get(sid) ?? new Set<symbol>();
      tickets.add(ticket);
      queuedUploads.set(sid, tickets);
    }
    const turn = uploadChainRef.current
      .catch(() => {})
      .then(() => {
        if (sid) {
          const tickets = queuedUploads.get(sid);
          if (!tickets?.delete(ticket)) return; // cancelled while it waited
          if (tickets.size === 0) queuedUploads.delete(sid);
          if (runCancelled(sid)) {
            // Cancelled before it was queued, so cancelRun had no ticket to
            // take back: drop what it registered, and the resumable copy a
            // late write may have put back.
            uploadRemainingRef.current.delete(sid);
            setPhase(sid);
            void deletePendingUpload(sid);
            return;
          }
        }
        if (epoch !== authEpochRef.current) {
          // Its bytes are not going now, so they no longer keep the tab open.
          if (sid) {
            uploadRemainingRef.current.delete(sid);
            setPhase(sid);
          }
          onSkip?.();
          return;
        }
        return task();
      })
      .catch(() => {});
    uploadChainRef.current = turn;
    return turn;
  };

  // Ask the server to delete what a session's upload left there: the chunks, or
  // the assembled file. Aborting an upload settles it at once, so a finalize
  // the server already started is still assembling the file when this arrives;
  // the server holds the discard for that finalize to carry out. It keeps a
  // scan that was run. Keepalive, so it outlives a page that is being left.
  // A request the server did not answer for good (the sign-in had lapsed, the
  // network dropped, it erred or was busy) deleted nothing, and is kept to be
  // made again (see the effect that sends them). Any other answer is final:
  // deleted, not this account's to delete, already gone, kept because a job
  // exists, or (202) held for a run request that is still copying the file, which
  // deletes it itself if it ends without a job.
  const discardServerUpload = (sid: string) => {
    if (!authUserIdRef.current) return;
    fetch(`${API_BASE}/api/discard-upload/${sid}`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
    })
      .then((res) => {
        const again = res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500;
        if (again) queueDiscardAfterSignIn(sid);
        else forgetQueuedDiscard(sid);
      })
      .catch(() => queueDiscardAfterSignIn(sid));
  };

  // Whether the server already has a job for this session: true when it does,
  // false when it says it has none, and false when it cannot be asked (the
  // caller then goes on as it would without the question).
  const serverHasJob = async (sid: string): Promise<boolean> => {
    try {
      const res = await fetch(`${API_BASE}/api/inference-status/${sid}`, { credentials: "include" });
      return res.ok;
    } catch {
      return false;
    }
  };

  // The status line is one line for the whole page, set by whichever foreground
  // run last wrote to it. A run that ends without a word (a Cancel from another
  // tab, or one skipped at dispatch) clears it only if it is still the run's own.
  const clearRunMessage = (...own: string[]) => setMessage((now) => (own.includes(now) ? "" : now));
  // An old notice ("Cancelled ePAI...", a DICOM folder that could not be
  // read) stops being news once the person adds files or starts a run. A
  // foreground upload's own progress line is left alone.
  const clearOldMessage = () => {
    if (!foregroundUploadSidRef.current) setMessage("");
  };

  // Cancel a session's job on the server. For a run cancelled while its
  // dispatch was in flight: the request had reached the server, so the job is
  // there by now, and the Cancel that already went out found none to stop.
  const cancelServerJob = (sid: string) => {
    if (!authUserIdRef.current) return;
    fetch(`${API_BASE}/api/cancel-inference/${sid}`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
    }).catch(() => {});
  };

  // Take back one background pre-upload: stop it, then, once the attempt has
  // stopped, have the server delete whatever it received.
  const discardPreUpload = (pre: { sid: string; uploadDone: Promise<string | null> }) => {
    uploadAbortRef.current.get(pre.sid)?.abort();
    void pre.uploadDone.then(() => discardServerUpload(pre.sid));
  };

  // Stop and forget every background pre-upload (the ones started when a file
  // is picked, before Run). Used when "None" is chosen, whose promise is that
  // files never leave the browser (so what already arrived is deleted too),
  // and when the account signs out or changes, so a later Run can never reuse
  // a session id that belongs to another account. Refs only: each attempt's
  // own continuation (see preStartUpload) notices it was forgotten and clears
  // its chip.
  const forgetPreUploads = ({ discard = false } = {}) => {
    itemUploadRef.current.forEach((pre) => {
      if (discard) discardPreUpload(pre);
      else uploadAbortRef.current.get(pre.sid)?.abort();
    });
    itemUploadRef.current.clear();
  };

  // The one way the page changes model, so choosing "None" always stops what
  // a previous choice already started sending.
  const chooseModel = (id: typeof selectedModel) => {
    if (id === "None") {
      forgetPreUploads({ discard: true });
      setItemUploadStatus({});
      setItemUploadProgress({});
    }
    modelTouchedRef.current = true;
    // The View message asks for a model, so it has done its job once one is chosen.
    setPickError((prev) => (prev === VIEW_ONE_SCAN_MESSAGE ? "" : prev));
    setSelectedModel(id);
  };

  const setPhase = (sid: string, phase?: string) =>
    setSessionPhases((prev) => {
      if (phase === undefined) {
        if (!(sid in prev)) return prev;
        const { [sid]: _dropped, ...rest } = prev;
        return rest;
      }
      return prev[sid] === phase ? prev : { ...prev, [sid]: phase };
    });

  const setQueuePosition = (sid: string, pos?: number) =>
    setQueuePositions((prev) => {
      if (pos === undefined) {
        if (!(sid in prev)) return prev;
        const { [sid]: _dropped, ...rest } = prev;
        return rest;
      }
      return prev[sid] === pos ? prev : { ...prev, [sid]: pos };
    });

  const allowedExtensions = [".nii", ".nii.gz"];

  /* ── File handling ── */
  // Shared by Select NIfTI, a drop of NIfTI files and a folder of them: adds
  // the usable files and says why any other was left out. Returns that message.
  const addNiftiFiles = (files: File[]) => {
    folderNoteSeq.current++;
    const usable: File[] = [];
    const reasons: string[] = [];
    for (const f of files) {
      const reason = unusableNiftiReason(f, CHUNK_SIZE);
      if (reason) reasons.push(reason);
      else usable.push(f);
    }
    if (usable.length > 0) {
      clearOldMessage();
      track("upload_files_selected");
      setSelectedItems((prev) => [
        ...prev,
        ...usable.map((f) => ({
          id: crypto.randomUUID(),
          kind: "nifti" as const,
          file: f,
        })),
      ]);
    }
    const left =
      reasons.length === 0
        ? ""
        : reasons.length === 1
          ? reasons[0]
          : `${reasons[0]} ${reasons.length - 1} other ${reasons.length === 2 ? "file was" : "files were"} also left out.`;
    setPickError(left);
    return left;
  };

  // A folder holds either NIfTI scans or DICOM slices. NIfTI files in it win:
  // looksLikeDicom would otherwise take an extensionless README as a slice.
  // Hidden files (macOS "._scan.nii.gz" sidecars) are not scans, so they never
  // count as NIfTI. A DICOM series set aside for a NIfTI file is said so, not dropped.
  const addFolderFiles = (files: File[]) => {
    const nifti = files.filter(
      (file) => !file.name.startsWith(".") && allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    if (nifti.length === 0) {
      addDicomFiles(files);
      return;
    }
    const shown = addNiftiFiles(nifti);
    // Two or more real slices make a series; a README and a LICENSE do not. The
    // count reads the files, so the note follows unless the message has moved on.
    const seq = ++folderNoteSeq.current;
    void countDicomSlices(files).then((slices) => {
      if (slices < 2 || seq !== folderNoteSeq.current) return;
      const note = `The ${slices} DICOM slices in that folder were left out because it also holds a NIfTI file. To view the slices, select a folder with only the slices.`;
      setPickError((prev) => (prev === shown ? [shown, note].filter(Boolean).join(" ") : prev));
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!ensureAccount()) { e.target.value = ""; return; }
    if (!e.target.files) return;
    const filteredFiles = Array.from(e.target.files).filter((file) =>
      allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    // Reset so picking the SAME file again later still fires a change event.
    // The native <input> tracks its value by path, not by content - without
    // this, re-selecting a file you already ran once (e.g. after Run clears
    // selectedItems back to empty) is a silent no-op: no change event fires,
    // so nothing here even runs and the picker just quietly does nothing.
    e.target.value = "";
    if (filteredFiles.length === 0) {
      setPickError("Please select .nii or .nii.gz files only.");
      return;
    }
    addNiftiFiles(filteredFiles);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    // Inlined (not via ensureAccount) so the memoized closure sees fresh auth.
    if (!isAuthenticated) { if (!authLoading) promptAuth(); return; }
    if (!e.dataTransfer.files) return;
    const filteredFiles = Array.from(e.dataTransfer.files).filter((file) =>
      allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    if (filteredFiles.length === 0) {
      // A DICOM drop: loose slices arrive as files, a folder as one directory
      // entry that has to be walked (entries are only readable during the drop).
      const entries = Array.from(e.dataTransfer.items ?? [])
        .map((item) => item.webkitGetAsEntry?.() ?? null)
        .filter((entry): entry is FileSystemEntry => entry !== null);
      const dropped = Array.from(e.dataTransfer.files);
      if (entries.some((entry) => entry.isDirectory)) {
        readDroppedEntries(entries)
          .then(addFolderFiles)
          .catch(() => setPickError("Couldn't read that DICOM folder. Use Select DICOM, then choose the folder."));
        return;
      }
      if (dropped.some(looksLikeDicom)) {
        addDicomFiles(dropped);
        return;
      }
      setPickError("Drop .nii or .nii.gz files, or use Select DICOM for a DICOM folder.");
      return;
    }
    addNiftiFiles(filteredFiles);
  }, [isAuthenticated, authLoading, promptAuth]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  // Where focus goes once a chip is removed: the next chip's remove button
  // (the previous one for the last chip), or the file picker when none is
  // left. Without it focus falls to <body>.
  const chipRefocusRef = useRef<string | "picker" | null>(null);
  const selectNiftiBtnRef = useRef<HTMLButtonElement | null>(null);
  // Run turns disabled the moment it hands the selection over, so a keyboard
  // user who pressed it would be dropped on <body>; see handleRunEpaiInference.
  const runBtnRef = useRef<HTMLButtonElement | null>(null);
  const removeItem = (id: string) => {
    const at = selectedItems.findIndex((item) => item.id === id);
    const neighbour = selectedItems[at + 1] ?? selectedItems[at - 1];
    chipRefocusRef.current = neighbour ? neighbour.id : "picker";
    // A refused pick stops being news once the user acts on the selection.
    setPickError("");
    const pre = itemUploadRef.current.get(id);
    if (pre) {
      discardPreUpload(pre);
      itemUploadRef.current.delete(id);
    }
    setSelectedItems((prev) => prev.filter((item) => item.id !== id));
    setPreviewItemId((prev) => (prev === id ? null : prev));
    setItemUploadStatus((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
    setItemUploadProgress((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
    setItemUploadError((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  useEffect(() => {
    const target = chipRefocusRef.current;
    if (!target) return;
    chipRefocusRef.current = null;
    if (target === "picker") selectNiftiBtnRef.current?.focus();
    else
      Array.from(document.querySelectorAll<HTMLElement>("[data-chip-remove]"))
        .find((el) => el.dataset.chipRemove === target)
        ?.focus();
  }, [selectedItems]);

  // Where focus goes once a Cancel or a Completed uploads row's remove button
  // has taken its own control out of the page: the next row's remove button
  // (the previous one for the last row), else the file picker after a Cancel or
  // the page heading after the last row. Only used when focus really was lost,
  // so a person who has moved on is not pulled back.
  const listRefocusRef = useRef<string | null>(null);
  useEffect(() => {
    const target = listRefocusRef.current;
    if (!target) return;
    listRefocusRef.current = null;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (target === "@picker") selectNiftiBtnRef.current?.focus();
    else if (target === "@heading") pageHeadingRef.current?.focus({ preventScroll: true });
    else
      (Array.from(document.querySelectorAll<HTMLElement>("[data-row-remove]"))
        .find((el) => el.dataset.rowRemove === target) ?? pageHeadingRef.current)
        ?.focus({ preventScroll: true });
  }, [recentUploads]);

  // Treat folder and manual multi-file selection identically after the browser
  // gives us File objects. Folder support differs among browsers, but the upload
  // pipeline itself must not.
  const addDicomFiles = (files: File[]) => {
    folderNoteSeq.current++;
    const candidates = files.filter(looksLikeDicom);
    if (!candidates.length) {
      setPickError(
        "No DICOM files found. Pick the folder holding the .dcm slices. On a phone or tablet, where folders can't be picked, select the slice files themselves.",
      );
      return;
    }
    setPickError("");
    clearOldMessage();
    setSelectedItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "dicom",
        files: candidates,
        label: `DICOM series (${candidates.length} ${candidates.length === 1 ? "slice" : "slices"})`,
      },
    ]);
  };

  // One user-facing DICOM control works across browsers: Chrome/Edge use their
  // native folder chooser, browsers with webkitdirectory use that, and every
  // remaining browser falls back to selecting the individual slices.
  const chooseDicomFiles = async () => {
    if (!ensureAccount()) return;

    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (picker) {
      try {
        // File System Access methods are Web-IDL methods and must be invoked
        // with Window as their receiver. Calling the detached function throws
        // "Illegal invocation" in Chromium, making this button appear inert.
        const directory = await picker.call(window);
        addFolderFiles(await readDirectoryFiles(directory));
      } catch (err) {
        // Cancelling the native chooser is a normal no-op, not an upload error.
        if (err instanceof DOMException && err.name === "AbortError") return;
        console.error("DICOM directory selection failed", err);
        setMessage(
          "Couldn't read that DICOM folder. Select DICOM again, then choose all slices in the folder.",
        );
      }
      return;
    }

    const supportsDirectoryInput =
      "webkitdirectory" in document.createElement("input");
    if (supportsDirectoryInput) {
      dicomUploadInputRef.current?.click();
      return;
    }

    dicomFilesInputRef.current?.click();
  };

  const handleDicomInferenceSelect = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (!ensureAccount()) {
      e.target.value = "";
      return;
    }
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same folder later
    addFolderFiles(files);
  };

  /* ── Inference polling (one timer per session) ── */
  const stopPolling = (sid: string) => {
    const timer = pollTimersRef.current.get(sid);
    if (timer !== undefined) {
      clearTimeout(timer);
      pollTimersRef.current.delete(sid);
    }
    pollGenerationRef.current.delete(sid);
    signedOutPollsRef.current.delete(sid);
  };

  const stopAllPolling = () => {
    pollTimersRef.current.forEach((timer) => clearTimeout(timer));
    pollTimersRef.current.clear();
    pollGenerationRef.current.clear();
    signedOutPollsRef.current.clear();
  };

  // Ask the server for a real median duration for this model/file-size, once
  // a run starts - see /api/inference-duration-estimate. Best-effort: on any
  // failure (network, server has no history yet) durationEstimates simply
  // stays without this sid, and estimateRemaining falls back to the
  // size-formula guess silently. Fire-and-forget by design - this is a nice-
  // to-have upgrade to the ETA display, not something a run should ever wait
  // on or fail over.
  const fetchDurationEstimate = (sid: string, model: string, fileSizeBytes?: number) => {
    const params = new URLSearchParams({ model });
    if (fileSizeBytes) params.set("size_bytes", String(fileSizeBytes));
    fetch(`${API_BASE}/api/inference-duration-estimate?${params}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.available && typeof data.median_seconds === "number") {
          setDurationEstimates((prev) => ({ ...prev, [sid]: data.median_seconds }));
        }
      })
      .catch(() => {}); // silent - the formula fallback covers this
  };

  // A run has left the "running" state for good (finished, failed, or
  // cancelled) - drop everything the ETA display was tracking for it, so a
  // future session id can't inherit stale timing/size/estimate data.
  const clearEtaTracking = (sid: string) => {
    runningStartedAtRef.current.delete(sid);
    sessionFileSizeRef.current.delete(sid);
    forgetScanTiming(sid);
    setEtaInputs((prev) => {
      if (!(sid in prev)) return prev;
      const { [sid]: _dropped, ...rest } = prev;
      return rest;
    });
    setDurationEstimates((prev) => {
      if (!(sid in prev)) return prev;
      const { [sid]: _dropped, ...rest } = prev;
      return rest;
    });
  };

  const finishSession = (sid: string) => {
    stopPolling(sid);
    setPhase(sid);
    setRecentUploads(updateRecentUploadStatus(sid, "Completed"));
    setSessionId(sid);
    setInferenceCompleted(true);
    // Deliberately does NOT navigate to the viewer - a finished run just sits
    // in Completed Uploads until the user clicks View, same as any other
    // completed scan. Auto-opening the viewer the moment a run finished used
    // to yank people into it even when they weren't looking at this tab
    // anymore (e.g. running several scans back to back).
  };

  // What follows a session the server has no job for after a few looks. If a
  // job was seen, the backend lost it (a restart). A poller that was following a
  // request the server said was starting the run (`followed`: a 409 told it so)
  // and never saw a job knows that request was refused or failed before making
  // it: the run never started. Its CT is still on the server, and if a record of
  // the upload is kept the dispatch is asked for once more, so the real answer
  // (the plan dialog, the file's error) comes through the normal branches.
  // Without a record the run is failed, the CT deleted and the record dropped.
  // Any other poller (a card resumed after a reload, a run merged from the
  // server) has no such knowledge: the run may well have been going, so all it
  // can say is that the server no longer has it, and it deletes nothing.
  const endMissingJob = async (sid: string, model: string, jobWasSeen: boolean, followed: boolean) => {
    const didNotStart = followed && !jobWasSeen;
    if (didNotStart && authUserIdRef.current && !replayedAfterFollowRef.current.has(sid)) {
      const account = authUserIdRef.current;
      const left = (await loadPendingUploads()).find((p) => p.sessionId === sid);
      // The load was awaited, and this function outlives the effects that stop
      // pollers: the page may have moved to another account meanwhile (the
      // record is not ours to replay or delete, and the request would go out
      // under the new account's cookie), or the run been cancelled or ended.
      if (authUserIdRef.current !== account) return;
      const card = loadRecentUploads().find((u) => u.sessionId === sid);
      if (runCancelled(sid) || (card && card.status !== "Processing")) {
        // Another tab has already ended it and written how to the shared list.
        // This tab's poller is stopped, so it takes that up itself, as it does
        // for a session it waited on (takeUpAfter), or its card would go on
        // saying "Running" with nobody following it.
        setRecentUploads(loadRecentUploads());
        setPhase(sid);
        setQueuePosition(sid);
        clearEtaTracking(sid);
        return;
      }
      if (left?.uploadedFilename) {
        replayedAfterFollowRef.current.add(sid);
        await dispatchInference(sid, model, left.uploadedFilename, false);
        return;
      }
    }
    setPhase(sid);
    setQueuePosition(sid);
    clearEtaTracking(sid);
    setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
    if (didNotStart) {
      setMessage("This run did not start, so it was marked as failed. Run the scan again.");
      // Nothing will replay it now, and its file is nobody's.
      void deletePendingUpload(sid);
      discardServerUpload(sid);
    } else {
      setMessage("This session no longer exists on the server, so it was marked as failed.");
    }
  };

  const startInferencePolling = (sid: string, model: string, followed = false) => {
    // Only the page that is showing polls. A dispatch the page left behind
    // finishes in its old closures, and a poller started there would run on
    // with nobody looking, next to the one the returned page starts for the
    // same session (it takes the session up once the dispatch has settled).
    if (!mountedRef.current) return;
    stopPolling(sid);
    const generation = Symbol(sid);
    pollGenerationRef.current.set(sid, generation);
    let notFoundCount = 0;
    let jobWasSeen = false;
    // This poller watched the run wait in the queue, so the moment it turns
    // to "running" is a start it saw, not one it came in the middle of.
    let sawQueued = false;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/inference-status/${sid}`, {
          credentials: "include",
        });
        const data = await parseApiResponse(res);
        // The poll was stopped while this request was out (Cancel, another
        // tab's Cancel, a sign-out, a newer poller for the session): its reply
        // is old news, and applying it would put back the phase, estimate and
        // per-second refresh that stopping cleared.
        if (pollGenerationRef.current.get(sid) !== generation) return;
        const status = (data.status || "").toLowerCase();

        // The sign-in lapsed (or was ended elsewhere) while the run was going:
        // every further poll would be refused the same way. Stop, say so and
        // ask for sign-in; the run is taken up again once the person has.
        if (res.status === 401) {
          stopPolling(sid);
          signedOutPollsRef.current.set(sid, { model, followed });
          setPhase(sid, "signin");
          setQueuePosition(sid);
          setMessage("Your session expired. Sign in to see this scan's progress.");
          promptAuth();
          return;
        }
        if (res.status === 403) {
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          clearEtaTracking(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
          setMessage(FOREIGN_SESSION_MESSAGE);
          return;
        }

        // The server doesn't know this session: the upload never finished
        // (tab closed mid-upload) or the backend restarted and lost its
        // in-memory job table. A few consecutive hits = gone, not a blip.
        if (status === "not_found") {
          notFoundCount += 1;
          if (notFoundCount >= 3) {
            stopPolling(sid);
            void endMissingJob(sid, model, jobWasSeen, followed);
          }
          return;
        }
        notFoundCount = 0;

        if (!res.ok)
          throw new Error(data.error || data.status || "Status check failed");

        // A run request of this account's is still copying the CT and has not
        // made the job yet: not gone, and not counted towards it being gone.
        if (status === "starting") {
          setPhase(sid, "queued");
          return;
        }
        // The job is there, so the record kept for replaying its dispatch (after
        // a 409, see dispatchInference) has done its work.
        if (!jobWasSeen) {
          jobWasSeen = true;
          void deletePendingUpload(sid);
        }

        if (status === "completed") {
          setQueuePosition(sid);
          clearEtaTracking(sid);
          finishSession(sid);
        } else if (status === "failed") {
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          clearEtaTracking(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
          if (data.error) console.error("Inference failed:", data.error);
          setMessage("The scan couldn't be processed. Run it again.");
        } else if (status === "cancelled") {
          // Cancelled elsewhere (another tab, or the backend) - reflect it.
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          clearEtaTracking(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        } else if (status === "queued" || status === "running") {
          if (status === "queued") sawQueued = true;
          if (status === "running" && !runningStartedAtRef.current.has(sid)) {
            // The server does not say when a run began. A run this page
            // started, or watched leave the queue, began just now; one it
            // joined while running began when the page that saw it said so
            // (saved below), and with no such record there is no honest
            // start to count from, so no estimate is drawn.
            const saved = loadScanTiming(sid);
            const sizeBytes = sessionFileSizeRef.current.get(sid) ?? saved?.sizeBytes;
            const sawStart = sessionFileSizeRef.current.has(sid) || sawQueued;
            const startedAt = sawStart ? Date.now() : saved?.startedAt;
            runningStartedAtRef.current.set(sid, startedAt ?? Date.now());
            if (startedAt !== undefined) {
              if (sawStart) saveScanTiming(sid, { startedAt, sizeBytes });
              setEtaInputs((prev) => ({ ...prev, [sid]: { startedAt, sizeBytes } }));
            }
            fetchDurationEstimate(sid, model, sizeBytes);
          }
          setPhase(sid, status);
          setQueuePosition(
            sid,
            status === "queued" && typeof data.queue_position === "number"
              ? data.queue_position
              : undefined,
          );
        }
      } catch (err) {
        // Network blip or proxy error while the backend restarts - the job
        // may still be alive server-side, so keep polling.
        console.error(err);
      } finally {
        // Schedule only after this request settles. setInterval allowed slow
        // requests to overlap and stale responses to overwrite newer state.
        if (pollGenerationRef.current.get(sid) === generation) {
          const nextTimer = setTimeout(poll, 2500);
          pollTimersRef.current.set(sid, nextTimer);
        }
      }
    };
    const timer = setTimeout(poll, 0);
    pollTimersRef.current.set(sid, timer);
  };

  // Cancel one run, whatever phase it's in: aborts an in-flight upload or
  // kills a queued/running server job.
  const cancelRun = (upload: RecentUpload) => {
    const sid = upload.sessionId;
    track("upload_cancel_inference");
    stopPolling(sid);
    setPhase(sid);
    setQueuePosition(sid);
    clearEtaTracking(sid);

    // Abort it if it is on the wire, or take it out of the line if it is
    // still waiting behind another file.
    cancelSessionUpload(sid);
    deletePendingUpload(sid);

    // Fire-and-forget: if the job never reached the server (upload phase)
    // this 404s, which is fine - the client side is already torn down. What
    // that upload left on the server is then deleted, since no job will ever
    // use it (while a run request is still starting it, the server holds the
    // deletion for that request and carries it out when it ends without a job).
    // Signed out, there is no account to cancel it for: just drop the card.
    if (authUserIdRef.current) {
      fetch(`${API_BASE}/api/cancel-inference/${sid}`, {
        method: "POST",
        credentials: "include",
      })
        .then(async (res) => {
          if (!res.ok) {
            discardServerUpload(sid);
            return;
          }
          // The status poll only looks every 2.5 s, so the scan can have
          // finished a moment before Cancel was pressed. The server then
          // says so instead of cancelling, and the card has to follow it:
          // its result exists and the scan was spent.
          const data = await res.json().catch(() => null);
          if (data?.status === "completed") {
            finishSession(sid);
            setMessage("It had already finished.");
          } else if (data?.status === "failed") {
            setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
            setMessage("The scan couldn't be processed. Run it again.");
          }
        })
        .catch(() => {});
    }

    if (foregroundUploadSidRef.current === sid) {
      foregroundUploadSidRef.current = null;
      setIsUploading(false);
    }
    setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
    // Only now, so a tab that acts on it reads the card as Cancelled.
    announceCancel(sid);
    setMessage(`Cancelled ${upload.label}`);
  };

  // Another tab cancelled a run this page may be showing or carrying. Its
  // upload is already stopped (see openCancelChannel); what is left is this
  // page's own polling, phase and cards.
  useEffect(
    () =>
      onCancelFromOtherTab((sid) => {
        stopPolling(sid);
        setPhase(sid);
        setQueuePosition(sid);
        clearEtaTracking(sid);
        if (foregroundUploadSidRef.current === sid) {
          foregroundUploadSidRef.current = null;
          setIsUploading(false);
        }
        setRecentUploads(loadRecentUploads());
      }),
    // Refs and state setters only, so the first render's closure is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Only warn before an unload if the current upload could NOT be stored in
  // IndexedDB (quota/private-mode) - otherwise an interrupted upload resumes
  // automatically on reopen, so no scary dialog is needed.
  // closeInfo.active also covers bytes an earlier mount of this page is still
  // sending, which never set this mount's isUploading.
  useEffect(() => {
    if (!(isUploading || closeInfo.active) || uploadResumableRef.current) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isUploading, closeInfo.active, uploadResumableRef]);

  // "Safe to close" estimate. Only the upload needs this tab: once a file is
  // dispatched it lives in the server's DB-backed job queue behind the GPU lock,
  // so the tab becomes disposable the moment the last byte lands. Rather than
  // accumulating a fixed total (which a cancel or failure would leave stale),
  // both terms are re-derived every tick from live state: remaining bytes from
  // the per-session map, throughput from the delta in bytes actually sent.
  useEffect(() => {
    let lastBytes = bytesSentRef.current;
    let rate = 0; // bytes/sec, smoothed - raw per-second deltas are far too jumpy
    const timer = setInterval(() => {
      const sent = bytesSentRef.current;
      const delta = sent - lastBytes;
      lastBytes = sent;
      rate = rate === 0 ? delta : rate * 0.7 + delta * 0.3;

      let remaining = 0;
      uploadRemainingRef.current.forEach((bytes) => {
        remaining += bytes;
      });
      const active = uploadRemainingRef.current.size > 0;
      // Below ~1 KB/s the estimate is noise (or the connection stalled) -
      // show "uploading" with no number rather than an absurd one.
      const eta = active && rate > 1024 ? Math.max(1, Math.round(remaining / rate)) : null;
      // Hand back the same object when nothing changed so React skips the
      // render: a fresh {active:false, eta:null} every second re-rendered
      // this whole page once a second while it sat idle.
      setCloseInfo((prev) =>
        prev.active === active && prev.eta === eta ? prev : { active, eta },
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  /* ── Upload (chunked) ── */
  // 512 KiB, not 256 KiB. Measured against the live backend (67 MB payload, loopback
  // so the client's own uplink isn't in the path, median of 3 runs): 256 KiB chunks
  // sustained ~2.6-12.7 MB/s and were wildly unstable (one run took 1707s), while
  // 512 KiB sustained ~145 MB/s tightly (0.42-0.51s across every run). Halving the
  // request count removes most of the per-request multipart+fsync overhead that a
  // single-worker gunicorn pays.
  //
  // Do NOT raise this past ~960 KiB: nginx in front of the app enforces
  // client_max_body_size 1m, and chunks >= 1024 KiB get a hard 413 (measured -
  // 960 KiB passes, 1024 KiB fails). Lifting that ceiling is a server-config change,
  // not a client one.
  const CHUNK_SIZE = 512 * 1024;

  // Hand an already-uploaded file to the server's job queue. Split out of the
  // upload path because the two halves fail independently: the bytes are on the
  // server before this runs, so a tab closed in this window only needs the
  // inference call replayed, not the whole file re-sent. Once this returns
  // successfully the run is entirely server-side and the tab is free.
  const dispatchInference = async (
    sid: string,
    model: string,
    uploadedName: string,
    foreground: boolean,
    isDicom = false,
  ) => {
    // Never dispatched signed out; the resumable record (if any) waits for
    // the next sign-in, which replays this call.
    if (!authUserIdRef.current) return;
    // Cancelled while its bytes were on their way (a Cancel this tab could not
    // act on, or from another tab): no scan may be spent on it now.
    if (runCancelled(sid)) {
      await deletePendingUpload(sid);
      setPhase(sid);
      discardServerUpload(sid); // the file it uploaded is nobody's now
      if (foreground) clearRunMessage("Finalizing upload...");
      return;
    }
    // Reuse the upload's controller when there is one, so a Cancel pressed
    // during the upload still aborts this call.
    let controller = uploadAbortRef.current.get(sid);
    if (!controller) {
      controller = new AbortController();
      uploadAbortRef.current.set(sid, controller);
    }
    try {
      if (foreground) setMessage(`Starting ${model} inference...`);
      const inferFd = new FormData();
      inferFd.append("session_id", sid);
      inferFd.append("model_name", model);
      inferFd.append("uploaded_filename", uploadedName);
      if (model === "LesionSegmenter") {
        inferFd.append("lesion_target", lesionTarget);
      }
      const res = await fetch(`${API_BASE}/api/run-epai-inference`, {
        method: "POST",
        body: inferFd,
        credentials: "include",
        signal: controller.signal,
      });
      const data = await parseApiResponse(res);
      // 402 is the plan refusing, not a failure — the server's reason drives
      // the upgrade dialog. The scan goes to Cancelled rather than Failed:
      // nothing broke, it just never ran.
      if (res.status === 402 && data?.code === "plan_limit") {
        await deletePendingUpload(sid);
        // No job was made and nothing points at the file it uploaded any more.
        discardServerUpload(sid);
        setPhase(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        setUpgradeBlock({
          reason: data.reason, message: data.message, feature: data.feature,
          limit: data.limit, used: data.used, resetsAt: data.resets_at ?? null,
          plan: (data.plan as PlanId) ?? "free",
        });
        if (foreground) setMessage("");
        return;
      }
      // 401 is an expired or missing sign-in, not a failure of the scan
      // itself (the client can still believe it is signed in when the cookie
      // has lapsed). Mirror the 402 shape: mark Cancelled, say why, and open
      // the sign-in popup instead of leaving a wordless Failed card.
      if (res.status === 401) {
        await deletePendingUpload(sid);
        // A run again gets a new session, so nothing points at this upload any
        // more. Asking now would meet the same 401; it is asked again once the
        // person has signed in.
        discardServerUpload(sid);
        setPhase(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        setMessage(
          "Your session expired before the run could start. Sign in and run the scan again.",
        );
        promptAuth();
        return;
      }
      if (res.status === 403) {
        await deletePendingUpload(sid);
        setPhase(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
        setMessage(FOREIGN_SESSION_MESSAGE);
        return;
      }
      // The server already has a request for this session that made (or is
      // making) its job: this one is a replay after a reload, or came from
      // another tab. Nothing is wrong with the run and no scan was spent on
      // this request, so it is followed like any run, not failed or cancelled.
      // The record of the upload is kept until the job is seen: if that other
      // request was refused it never makes one, and the dispatch is asked for
      // again from the record (see endMissingJob).
      const alreadyRunning = res.status === 409 && data?.code === "run_in_progress";
      if (!res.ok && !alreadyRunning)
        throw new RunRejectedError(res.status, data.error || "Failed to start inference");

      // Cancelled while the request was in flight (this tab was not told in
      // time to abort it): the job exists now, and is stopped.
      if (runCancelled(sid)) {
        cancelServerJob(sid);
        await deletePendingUpload(sid);
        setPhase(sid);
        if (foreground) setMessage("");
        return;
      }

      // Queued server-side now - nothing here is needed to finish the run, so
      // drop the resumable record (unless it is being followed on a 409).
      if (!alreadyRunning) {
        await deletePendingUpload(sid);
        refreshUsage(); // a scan was just spent; keep the settings counter honest
      }
      setSessionId(sid);
      setPhase(sid, "queued"); // server queues for the GPU; poll refines this
      // No status-line message here: the processing card below already shows
      // "Running..." for this session, so a raw-UUID line would just duplicate it.
      if (foreground) setMessage("");
      // Followed when the server said another request is starting it: only
      // that poller can tell, if no job ever shows, that the run did not start.
      startInferencePolling(sid, model, alreadyRunning);
    } catch (err) {
      if (controller.signal.aborted || runCancelled(sid)) {
        // A Cancel aborted the request, which may have reached the server first.
        if (runCancelled(sid)) cancelServerJob(sid);
        if (foreground) clearRunMessage(`Starting ${model} inference...`);
        return;
      }
      console.error(err);
      setPhase(sid);
      await deletePendingUpload(sid);
      // Not resumable now, so the file it uploaded is nobody's. The server
      // keeps it if a job was made after all (the reply may only have been lost).
      discardServerUpload(sid);
      setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
      // The card only says "Failed", which does not tell a bad file from a
      // server that could not start. Say which, for a foreground and a
      // background run alike; it stays until the next Run clears it.
      // The server's own name for the upload (ct.nii.gz for a converted DICOM
      // series) is not what the person picked, so name the scan by the file or
      // folder it came from.
      const picked = loadRecentUploads().find((u) => u.sessionId === sid)?.sourceName;
      const thing = isDicom ? "folder" : "file";
      const what = isDicom ? "DICOM series" : "scan";
      setMessage(
        err instanceof RunRejectedError && err.status === 400
          ? `${picked || `This ${what}`} could not be run. ${
              isDicom
                ? "The server couldn't read this DICOM series as a single 3D CT scan."
                : "The server couldn't read it as a single 3D CT scan (.nii or .nii.gz)."
            } Check the ${thing} and select it again.`
          : `The server couldn't start the run for ${picked || `this ${what}`}. Select the ${thing} again and press Run to try again.`,
      );
    } finally {
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

  // Uploads a single NIfTI file the moment it's selected, before Run is
  // clicked and before a model is even chosen - just the bytes + finalize,
  // no dispatchInference (there's no model yet to dispatch with). Reuses
  // isUploading/message, the SAME state the foreground runUpload path
  // drives: only one upload is ever active at a time (both routes go
  // through uploadChainRef). Returns the uploaded filename, or null on
  // failure/abort.
  const preUploadOnly = async (
    sid: string,
    file: File,
    onProgress?: (pct: number) => void,
    onFailure?: (notice: string) => void,
  ): Promise<string | null> => {
    if (!authUserIdRef.current) return null; // never uploads signed out
    const controller = new AbortController();
    uploadAbortRef.current.set(sid, controller);
    uploadRemainingRef.current.set(sid, file.size);
    // Not resumable (no IndexedDB record for a pre-upload) - closing the tab
    // now really does lose progress, so the unload warning should fire.
    uploadResumableRef.current = false;
    foregroundUploadSidRef.current = sid;
    setIsUploading(true);
    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const CONCURRENCY = 6;
      let nextIndexToStart = 0;
      let completedChunks = 0;
      const uploadOneChunk = async (i: number) => {
        const chunk = file.slice(
          i * CHUNK_SIZE,
          Math.min((i + 1) * CHUNK_SIZE, file.size),
        );
        const formData = new FormData();
        formData.append("session_id", sid);
        formData.append("chunk_index", i.toString());
        formData.append("total_chunks", totalChunks.toString());
        formData.append("file", chunk);
        const res = await postWithRetry(
          `${API_BASE}/api/upload-inference-chunk`,
          { method: "POST", body: formData, credentials: "include", signal: controller.signal },
        );
        if (res.status === 413)
          throw new TooLargeError("The file is too large for the server to accept.");
        if (res.status === 401) throw new SignedOutError();
        const data = await parseApiResponse(res);
        if (!res.ok) throw uploadReplyError(res, data, "Chunk upload failed");
        bytesSentRef.current += chunk.size;
        // Not once this attempt has cleaned up: the entry would never go away.
        if (uploadRemainingRef.current.has(sid)) {
          uploadRemainingRef.current.set(
            sid,
            Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - chunk.size),
          );
        }
        completedChunks++;
        onProgress?.(Math.round((completedChunks / totalChunks) * 100));
      };
      const worker = async () => {
        while (true) {
          const i = nextIndexToStart++;
          if (i >= totalChunks) return;
          await uploadOneChunk(i);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, totalChunks) }, worker),
      );

      const finalizeRes = await fetch(`${API_BASE}/api/finalize-upload`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        body: new URLSearchParams({
          session_id: sid,
          total_chunks: totalChunks.toString(),
          output_filename: file.name,
        }),
      });
      if (finalizeRes.status === 401) throw new SignedOutError();
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok) throw uploadReplyError(finalizeRes, finalizeData, "The upload could not be finished.");
      return finalizeData.uploaded_filename || file.name;
    } catch (err) {
      if (controller.signal.aborted) return null;
      // A genuine failure: the other workers would otherwise keep posting the
      // rest of the file to a dead session, and each would re-register it as
      // still uploading after this attempt cleaned up (leaving "keep tab open"
      // on). A pre-upload is never resumed (Run starts a new session), so the
      // server's copy of what arrived is nobody's.
      controller.abort();
      discardServerUpload(sid);
      console.error("Background upload failed:", err);
      if (err instanceof SignedOutError) {
        onFailure?.(UPLOAD_SESSION_EXPIRED_MESSAGE);
        promptAuth();
        return null;
      }
      // Copy matters: the file chip is still selected and Run falls back to a
      // fresh resumable upload, so a retry really is one click away.
      const reason = uploadFailureReason(err);
      const next = err instanceof TooLargeError || isUnusableFileReply(err) ? "" : " Press Run to try again.";
      onFailure?.(`${file.name} could not be uploaded. ${reason}${next}`);
      return null;
    } finally {
      if (foregroundUploadSidRef.current === sid) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

  // Kick off a NIfTI item's upload in the background, keyed by item id.
  // Idempotent - safe to call repeatedly for the same item (e.g. once from
  // selection and again from the selectedModel-changed effect).
  const preStartUpload = (item: SelectedItem) => {
    if (item.kind !== "nifti") return; // DICOM still starts on Run
    if (itemUploadRef.current.has(item.id)) return;
    const sid = crypto.randomUUID();
    let resolveDone!: (name: string | null) => void;
    const uploadDone = new Promise<string | null>((res) => {
      resolveDone = res;
    });
    itemUploadRef.current.set(item.id, { sid, uploadDone });
    setItemUploadStatus((prev) => ({ ...prev, [item.id]: "uploading" }));
    setItemUploadProgress((prev) => ({ ...prev, [item.id]: 0 }));
    const file = item.file;
    const isCurrent = () => itemUploadRef.current.get(item.id)?.sid === sid;
    // Forgotten (None chosen, signed out, file removed) before or while it
    // ran: the chip goes back to plain "selected", with no upload state.
    const clearChip = () => {
      setItemUploadStatus((prev) => {
        if (prev[item.id] !== "uploading") return prev;
        const { [item.id]: _dropped, ...rest } = prev;
        return rest;
      });
    };
    enqueueUpload(
      async () => {
        // Waited its turn on the chain; it may have been forgotten since.
        if (!isCurrent()) {
          clearChip();
          resolveDone(null);
          return;
        }
        const uploadedName = await preUploadOnly(
          sid,
          file,
          (pct) => {
            setItemUploadProgress((prev) => ({ ...prev, [item.id]: pct }));
          },
          (notice) => setItemUploadError((prev) => ({ ...prev, [item.id]: notice })),
        );
        // Only the still-registered attempt may report the chip's status or
        // clean up - after an abort, or once a newer attempt for the same item
        // superseded this one, the chip belongs to that attempt, not to this
        // stale outcome.
        const cur = itemUploadRef.current.get(item.id);
        if (cur && cur.sid === sid) {
          setItemUploadStatus((prev) => ({
            ...prev,
            [item.id]: uploadedName ? "done" : "failed",
          }));
          // Failed: forget the attempt so the pre-upload effect can start a
          // fresh one instead of the idempotence check pinning the item to a
          // dead upload forever.
          if (!uploadedName) itemUploadRef.current.delete(item.id);
        } else if (!cur) {
          clearChip();
        }
        resolveDone(uploadedName);
      },
      () => {
        clearChip();
        resolveDone(null);
      },
    );
  };

  // Uploads the file described by `p`, finalizes, then starts inference.
  // Resumable: the file lives in IndexedDB and the chunk cursor is persisted, so
  // a reload can call this again to pick up where it left off - starting from
  // what the server confirms it holds, not from p.nextChunk directly.
  // `foreground` = the run the user just clicked (drives the progress
  // bar); resumed background runs show only their Active-section spinner.
  const runUpload = async (p: PendingUpload, foreground: boolean) => {
    const {
      sessionId: sid,
      file,
      filename,
      model,
      bdmapId: bid,
      totalChunks,
    } = p;
    // Signed out: leave the resumable record for the next sign-in.
    if (!authUserIdRef.current) return;
    const controller = new AbortController();
    uploadAbortRef.current.set(sid, controller);
    setPhase(sid, "uploading");
    try {
      // A resumed upload can't trust its own cursor - the server may have swept
      // its chunks (24h TTL) or lost the staging disk. Ask what it still holds
      // and continue from there; if nothing survived this comes back 0 and the
      // file re-sends from the start (it's still in IndexedDB). Fresh uploads
      // skip the round-trip.
      const startChunk = p.nextChunk > 0
        ? await resolveResumeStart(API_BASE, sid, p.nextChunk)
        : 0;

      // Correct the "safe to close" estimate for what the server already holds:
      // startScanRun registered the whole file, but a resume only re-sends the
      // tail.
      uploadRemainingRef.current.set(
        sid,
        Math.max(0, file.size - startChunk * chunkSizeOf(p)),
      );

      if (foreground) {
        foregroundUploadSidRef.current = sid;
        setIsUploading(true);
      }

      // Chunks upload with CONCURRENCY in flight at once instead of one at a time --
      // each chunk lands in its own server-side file (chunk-<index>), reassembled by
      // finalize-upload, so arrival order doesn't matter and parallelizing is safe.
      //
      // 6. An earlier revision lowered this to 3 on the strength of a loopback
      // benchmark where 3 in flight beat 6 (0.48s vs 0.84s for 67 MB). That
      // benchmark was measuring the wrong thing: over loopback the round-trip time
      // is ~0, so it only captured server-side processing contention and was blind
      // to the reason concurrency exists. Against the real site the change made a
      // 67 MB upload SLOWER, 18s -> 22s.
      //
      // The site serves HTTP/2 (confirmed via ALPN), so these requests multiplex
      // over a single TCP connection rather than opening one socket each --
      // concurrency here controls how many bytes are in flight against one
      // congestion window, not how many connections exist. HTTP/2 flow control
      // starts each stream at a 64 KiB window, so in-flight bytes track roughly
      // CONCURRENCY x 64 KiB independently of CHUNK_SIZE: ~192 KiB at 3, ~384 KiB
      // at 6. On a ~30 Mbps uplink the bandwidth-delay product is on the order of
      // 150 KiB, so 3 streams sits at the edge of under-filling the link while 6
      // keeps it saturated.
      //
      // Server-side contention is also less of a concern than the loopback numbers
      // implied, because nginx buffers request bodies by default and hands gunicorn
      // an already-complete request.
      const CONCURRENCY = 6;

      // Resumed uploads must be sliced exactly as they were originally sliced --
      // see chunkSizeOf(). New uploads record CHUNK_SIZE at creation. This guards
      // a *different* failure than startChunk below: chunkSizeOf keeps the byte
      // offsets right, startChunk keeps the index right. Both are needed.
      const chunkSize = chunkSizeOf(p);

      // Every cursor below starts from startChunk (what the SERVER confirmed it
      // holds), not p.nextChunk (what this tab last wrote to IndexedDB) - the
      // two differ whenever the staging area was swept or lost.
      let nextIndexToStart = startChunk;
      const completedIndices = new Set<number>();
      // The resume cursor must only ever advance over a CONTIGUOUS run of completed
      // chunks -- with parallel uploads, chunk 20 can finish before chunk 15, and
      // persisting past a gap would make a resumed run skip re-sending chunk 15.
      let contiguousWatermark = startChunk;
      const advanceWatermark = async () => {
        let advanced = false;
        while (completedIndices.has(contiguousWatermark)) {
          completedIndices.delete(contiguousWatermark);
          contiguousWatermark++;
          advanced = true;
        }
        // Same throttling intent as before (avoid an IDB write per chunk) -- persist
        // on every 16th advance, plus unconditionally once everything is done below.
        if (advanced && contiguousWatermark % 16 === 0) {
          await setPendingNextChunk(sid, contiguousWatermark);
        }
      };

      const uploadOneChunk = async (i: number) => {
        const chunk = file.slice(
          i * chunkSize,
          Math.min((i + 1) * chunkSize, file.size),
        );
        const formData = new FormData();
        formData.append("session_id", sid);
        formData.append("chunk_index", i.toString());
        formData.append("total_chunks", totalChunks.toString());
        formData.append("file", chunk);

        // Retried: a single dropped chunk used to fail the whole run and delete
        // its resumable copy, making a brief network blip worse than closing
        // the tab. A 413 or other 4xx still fails fast - it won't fix itself.
        const res = await postWithRetry(
          `${API_BASE}/api/upload-inference-chunk`,
          {
            method: "POST",
            body: formData,
            credentials: "include",
            signal: controller.signal,
          },
        );
        if (res.status === 413)
          throw new TooLargeError("The file is too large for the server to accept.");
        if (res.status === 403) throw new ForeignSessionError();
        if (res.status === 401) throw new SignedOutError();
        const data = await parseApiResponse(res);
        if (!res.ok) throw uploadReplyError(res, data, "Chunk upload failed");

        completedIndices.add(i);
        bytesSentRef.current += chunk.size;
        uploadRemainingRef.current.set(
          sid,
          Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - chunk.size),
        );
        await advanceWatermark();
      };

      const worker = async () => {
        while (true) {
          const i = nextIndexToStart++;
          if (i >= totalChunks) return;
          await uploadOneChunk(i);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENCY, totalChunks - startChunk) },
          worker,
        ),
      );
      // Final persist in case the last watermark advance(s) landed on a non-multiple
      // of 16 -- without this, a crash right after the loop could re-send a few
      // already-uploaded tail chunks on resume (harmless, but pointless to leave on
      // the table now that we track the exact watermark).
      if (contiguousWatermark > startChunk) {
        await setPendingNextChunk(sid, contiguousWatermark);
      }

      if (foreground) setMessage("Finalizing upload...");
      const finalizeRes = await fetch(`${API_BASE}/api/finalize-upload`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        body: new URLSearchParams({
          session_id: sid,
          total_chunks: totalChunks.toString(),
          output_filename: filename,
          ...(bid ? { bdmap_id: bid } : {}),
        }),
      });
      if (finalizeRes.status === 403) throw new ForeignSessionError();
      if (finalizeRes.status === 401) throw new SignedOutError();
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok) throw uploadReplyError(finalizeRes, finalizeData, "The upload could not be finished.");
      const uploadedName = finalizeData.uploaded_filename || filename;

      // The bytes are on the server but no job exists yet. Keep the IDB record
      // (minus the now-pointless file blob) flagged as uploaded, so a tab closed
      // in this window resumes by dispatching rather than by re-uploading a file
      // the server already has - or worse, failing it. dispatchInference clears it.
      await setPendingUploaded(sid, uploadedName);
      if (foreground) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }

      await dispatchInference(sid, model, uploadedName, foreground);
    } catch (err) {
      // A user cancel aborts our fetches - cancelRun already did the cleanup
      // and set the card to Cancelled, so don't overwrite that with Failed. A
      // cancel this tab was not told of fails the upload from the server's side
      // (its chunks are gone), and reads the same.
      if (controller.signal.aborted || runCancelled(sid)) {
        if (foreground) clearRunMessage("Finalizing upload...");
        return;
      }
      // A genuine failure (not a user cancel): with chunks now uploading in
      // parallel, other in-flight chunk requests would otherwise keep running
      // to completion for no reason after we've already given up on this
      // upload. Abort them too.
      controller.abort();
      console.error(err);
      setPhase(sid);
      if (foreground) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }
      // A lapsed sign-in is not the file's fault: say why with the sign-in
      // popup, as the dispatch does for a 401. The card is Cancelled and
      // nothing replays a Cancelled card's copy, so it goes like cancelRun's.
      if (err instanceof SignedOutError) {
        await deletePendingUpload(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        setMessage(UPLOAD_SESSION_EXPIRED_MESSAGE);
        promptAuth();
        return;
      }
      await deletePendingUpload(sid);
      setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
      // The card sits below the model cards, out of sight from the dropzone,
      // so the status line says why, for a resumed run as well as a
      // foreground one.
      if (err instanceof ForeignSessionError) setMessage(FOREIGN_SESSION_MESSAGE);
      else if (err instanceof TooLargeError) setMessage(`${filename} could not be uploaded. ${err.message}`);
      else if (isUnusableFileReply(err)) setMessage(`${filename} could not be uploaded. ${UNUSABLE_FILE_MESSAGE}`);
      else
        setMessage(`${filename} could not be uploaded. ${uploadFailureReason(err)} Select the file again and press Run.`);
    } finally {
      // Whatever happened, this file is no longer contributing bytes - drop it
      // so a cancel/failure can't leave its unsent bytes inflating the estimate.
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
      // Aborted by a sign-out rather than by Cancel (which already did this):
      // the foreground progress state must not outlive the upload.
      if (foregroundUploadSidRef.current === sid) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }
    }
  };

  // DICOM folder → inference. Uploads each raw slice, asks the server to convert
  // the series to NIfTI (SimpleITK), then hands off to the same inference + polling
  // flow as a NIfTI run. Not IndexedDB-resumable (a folder is many files); a reload
  // mid-upload marks the run Failed, consistent with the Active/Recent cards. Wired
  // into uploadAbortRef so the Active card's Cancel button aborts it cleanly.
  const runDicomUpload = async (sid: string, files: File[], model: string) => {
    if (!authUserIdRef.current) return; // never uploads signed out
    const controller = new AbortController();
    uploadAbortRef.current.set(sid, controller);
    foregroundUploadSidRef.current = sid;
    uploadResumableRef.current = false; // no IDB copy for a DICOM folder
    setPhase(sid, "uploading");
    try {
      setIsUploading(true);

      for (let i = 0; i < files.length; i++) {
        const formData = new FormData();
        formData.append("session_id", sid);
        // A retry keeps the same server-side filename, so it replaces only the
        // interrupted slice instead of creating a duplicate in the DICOM series.
        formData.append("slice_index", String(i));
        formData.append("file", files[i]);
        // Retried like NIfTI chunks, and it matters more here: a DICOM folder
        // has no IndexedDB copy, so a blip on any one slice means re-picking
        // the folder and starting over.
        const res = await postWithRetry(`${API_BASE}/api/upload-dicom-slice`, {
          method: "POST",
          credentials: "include",
          body: formData,
          signal: controller.signal,
        });
        if (res.status === 413)
          throw new TooLargeError("A slice in this folder is too large for the server to accept.");
        if (res.status === 401) throw new SignedOutError();
        const data = await parseApiResponse(res);
        if (!res.ok) throw uploadReplyError(res, data, "DICOM slice upload failed");
        bytesSentRef.current += files[i].size;
        uploadRemainingRef.current.set(
          sid,
          Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - files[i].size),
        );
      }

      setMessage("Converting DICOM series to NIfTI...");
      const finalizeRes = await fetch(`${API_BASE}/api/finalize-dicom`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        body: new URLSearchParams({ session_id: sid }),
      });
      if (finalizeRes.status === 401) throw new SignedOutError();
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok)
        throw uploadReplyError(finalizeRes, finalizeData, "DICOM conversion failed");
      const uploadedName = finalizeData.uploaded_filename || "ct.nii.gz";

      foregroundUploadSidRef.current = null;
      setIsUploading(false);

      await dispatchInference(sid, model, uploadedName, true, true);
    } catch (err) {
      // A user cancel aborts our fetches - cancelRun already set the card to
      // Cancelled, so don't overwrite that with Failed.
      if (controller.signal.aborted || runCancelled(sid)) {
        clearRunMessage("Converting DICOM series to NIfTI...");
        return;
      }
      console.error(err);
      setPhase(sid);
      foregroundUploadSidRef.current = null;
      setIsUploading(false);
      if (err instanceof SignedOutError) {
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        setMessage(UPLOAD_SESSION_EXPIRED_MESSAGE);
        promptAuth();
        return;
      }
      setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
      const next = err instanceof TooLargeError ? "" : " Select the folder again and press Run.";
      setMessage(`DICOM upload failed. ${uploadFailureReason(err)}${next}`);
    } finally {
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
      if (foregroundUploadSidRef.current === sid) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
      }
    }
  };

  /* ── Account boundary ── */
  // Runs whenever the signed-in account changes, including the first time
  // auth settles on page load. Two halves:
  //
  // 1. The account that was signed in is gone (signed out, or switched): stop
  //    everything it had going - abort every upload and dispatch in flight,
  //    stop the pollers, forget the pre-uploads so a later Run can't reuse
  //    one of its session ids, and move the epoch on so queued uploads skip.
  //    Their resumable records stay in IndexedDB for that account's return.
  // 2. Someone is signed in: resume every in-flight run this browser knows
  //    about that belongs to them - there can be several in parallel. Uploads
  //    that were still mid-transfer live in IndexedDB and must be *resumed*
  //    (not polled - the server has no job for them yet); the rest are
  //    already inferencing server-side, so we reconnect their pollers.
  //    Signed out, nothing resumes: a guest never uploads, dispatches or polls
  //    anything, even for leftovers from an earlier session in this browser.
  useEffect(() => {
    const prev = authUserIdRef.current;
    authUserIdRef.current = authUserId;
    if (prev !== null && prev !== authUserId) {
      authEpochRef.current += 1;
      uploadAbortRef.current.forEach((controller) => controller.abort());
      forgetPreUploads();
      // Their chips said "ready" for uploads that were just dropped, and the
      // next account's pre-upload effect starts them again from a clean slate.
      setItemUploadStatus({});
      setItemUploadProgress({});
      setItemUploadError({});
      stopAllPolling();
      // The "Inference complete" card is for the scan its account just ran.
      setSessionId("");
      setInferenceCompleted(false);
    }
    if (authUserId === null) return;

    let cancelled = false;
    // Ends the waits on sessions another tab is carrying when this run of the
    // effect is over.
    const stopWaiting = new AbortController();
    // Takes a session up again once another run of it has ended: the state
    // that run left behind decides what, if anything, is still to do.
    const takeUpAfter = async (u: RecentUpload): Promise<void> => {
      if (cancelled) return;
      const latest = loadRecentUploads();
      setRecentUploads(latest);
      setPhase(u.sessionId);
      if (latest.find((r) => r.sessionId === u.sessionId)?.status !== "Processing") return;
      const left = (await loadPendingUploads()).find((r) => r.sessionId === u.sessionId);
      if (cancelled) return;
      return resume(u, left);
    };

    const resume = async (u: RecentUpload, p: PendingUpload | undefined): Promise<void> => {
      const hold = sessionHolds.get(u.sessionId);
      if (hold) {
        // Still uploading or dispatching from before the page was left and
        // reopened. Starting it again would send the file twice (or poll a
        // job that doesn't exist yet), so wait for it, take up the state it
        // ended in, and carry on from there.
        setPhase(u.sessionId, "uploading");
        await hold.settled;
        return takeUpAfter(u);
      }
      // Another tab on /upload can be carrying this session (the holds above
      // only see this tab): resuming its upload would send the file twice,
      // and polling before it has dispatched would fail the run. Leave it to
      // that tab, and take it up if that tab finishes or closes.
      const release = p ? holdSession(u.sessionId) : undefined;
      const free = p ? await holdsTabLock(u.sessionId) : await sessionFreeAcrossTabs(u.sessionId);
      if (!free || cancelled) {
        release?.();
        if (cancelled) return;
        setPhase(u.sessionId, "elsewhere");
        await waitForSessionLock(u.sessionId, stopWaiting.signal);
        return takeUpAfter(u);
      }
      if (runCancelled(u.sessionId)) {
        // Cancelled while the lock check was out; p is what was stored before.
        release?.();
        setPhase(u.sessionId);
        discardServerUpload(u.sessionId);
        return;
      }
      if (p?.uploadedFilename) {
        // Fully uploaded, but the tab closed before its job was created. The
        // file is already on the server - just replay the inference call. Not
        // queued behind the resuming uploads: it costs one POST and getting it
        // into the GPU queue now is the whole point.
        const uploaded = p.uploadedFilename;
        void (async () => {
          // A tab closed while the run request was on its way leaves this
          // record behind although the server went on to make the job. Sending
          // the request again would be refused (the job is counted against the
          // plan) or, on a paid plan, run the scan twice, and either way the
          // card would stop following a run that is going. If the server has
          // the job, follow it. If it cannot be asked, send the request as
          // before: it is the same one the tab was making.
          const hasJob = await serverHasJob(p.sessionId);
          // The page may have moved to another account while the question was
          // out (and the answer with it: it was asked under whichever cookie
          // was current). Then this is not the run's to send or follow any
          // more: leave its record for when its account is back.
          if (cancelled || authUserIdRef.current !== authUserId) return;
          if (hasJob) {
            if (runCancelled(p.sessionId)) {
              cancelServerJob(p.sessionId);
              await deletePendingUpload(p.sessionId);
              setPhase(p.sessionId);
              return;
            }
            // The record goes when the poll sees the job: "starting" means a
            // request is still making it, and it may yet be refused. The server
            // has just said one exists or is being made, so this follows it
            // like a 409 does.
            startInferencePolling(p.sessionId, p.model, true);
            return;
          }
          await dispatchInference(p.sessionId, p.model, uploaded, false);
        })().finally(release);
      } else if (p) {
        setPhase(u.sessionId, "waiting");
        uploadRemainingRef.current.set(p.sessionId, p.file.size);
        // The record was just read from IndexedDB, so a reload mid-resume loses
        // nothing: set when this upload's turn starts, like the foreground Run.
        void enqueueUpload(() => { uploadResumableRef.current = true; return runUpload(p, false); }, undefined, p.sessionId).then(release); // resume the upload
      } else {
        startInferencePolling(u.sessionId, u.model); // resume polling
      }
    };

    // Runs the auth provider takes up after this effect ran (adoptLegacyRuns:
    // saved before entries carried an owner, so not this account's yet when it
    // looked) get the same treatment as the ones it found: one still going is
    // resumed from its pending record if it has one, and otherwise followed.
    // Polling alone would fail one whose upload finished but whose job was never
    // created.
    const resumeAdopted = async (entries: RecentUpload[]) => {
      const pending = await loadPendingUploads();
      if (cancelled) return;
      for (const u of entries) void resume(u, pending.find((p) => p.sessionId === u.sessionId));
    };
    resumeAdoptedRef.current = resumeAdopted;

    (async () => {
      // Only this account's own: a run nobody owns is a signed-out visitor's,
      // and no account takes it up.
      const processing = loadRecentUploads().filter(
        (u) => u.status === "Processing" && u.ownerId === authUserId,
      );
      const pending = await loadPendingUploads();
      if (cancelled) return;
      const pendingById = new Map(pending.map((p) => [p.sessionId, p]));

      for (const u of processing) void resume(u, pendingById.get(u.sessionId));

      // Clean up IndexedDB entries whose card no longer exists (deleted or
      // trimmed off the list) so the store can't leak.
      const known = new Set(loadRecentUploads().map((u) => u.sessionId));
      pending
        .filter((p) => !known.has(p.sessionId))
        .forEach((p) => deletePendingUpload(p.sessionId));

      if (processing.length > 0) {
        // Keep a session id bound for the action bar, but don't surface a
        // "Reconnected · N runs" message — the processing summary bar shows this.
        setSessionId(processing[0].sessionId);
      }
    })();
    return () => {
      cancelled = true;
      if (resumeAdoptedRef.current === resumeAdopted) resumeAdoptedRef.current = null;
      stopWaiting.abort();
      stopAllPolling();
    };
    // Keyed on the account alone: the helpers it calls are recreated every
    // render but only ever read refs and stable setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  // Recent uploads live in this browser's localStorage, so a signed-in person
  // on another browser or device would start with an empty list. The server
  // keeps each account's own runs too (GET /api/me/runs): the ones this browser
  // lacks are added, and what it already has is left as it is. Signed out, the
  // list stays local. A run the server is still working on is followed like
  // any other in-flight one.
  useEffect(() => {
    if (!authUserId) return;
    const controller = new AbortController();
    (async () => {
      try {
        // One request with the auth provider's own adoption (adoptLegacyRuns).
        const runs = await fetchListedRuns(authUserId);
        if (runs === null || controller.signal.aborted) return;
        // Read now, not before the request: the list may have changed meanwhile.
        // (Runs saved before entries carried an owner are taken up by the auth
        // provider, which tells this page; see adoptLegacyRuns.)
        const { list, added } = mergeServerRuns(loadRecentUploads(), runs, authUserId);
        if (added.length === 0) return;
        persistRecentUploads(list);
        setRecentUploads(list);
        added
          .filter((u) => u.status === "Processing")
          .forEach((u) => startInferencePolling(u.sessionId, u.model));
      } catch {
        // Best effort: the local list is all there is until the next visit.
      }
    })();
    return () => controller.abort();
    // Keyed on the account alone, like the effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId]);

  // Deletions the server has not answered for good wait here (see
  // discardServerUpload). Each sign-in gives a new `user`, so they are sent
  // then, and again on a later one or a later page load until they are.
  useEffect(() => {
    if (!user) return;
    // Runs left unpolled by a 401 follow on again now that someone is signed in
    // (unless they have ended meanwhile).
    const held = Array.from(signedOutPollsRef.current);
    signedOutPollsRef.current.clear();
    // Signed in again: the lines asking for that are done with.
    clearRunMessage(
      "Your session expired. Sign in to see this scan's progress.",
      "Your session expired before the run could start. Sign in and run the scan again.",
      UPLOAD_SESSION_EXPIRED_MESSAGE,
    );
    // The same sentence on a chip (a pre-upload that hit the 401) is done too:
    // the chip goes back to plain "selected" and Run uploads it afresh.
    const expiredIds = Object.keys(itemUploadErrorRef.current).filter(
      (id) => itemUploadErrorRef.current[id] === UPLOAD_SESSION_EXPIRED_MESSAGE,
    );
    if (expiredIds.length > 0) {
      setItemUploadError((prev) => {
        const next = { ...prev };
        expiredIds.forEach((id) => delete next[id]);
        return next;
      });
      setItemUploadStatus((prev) => {
        const next = { ...prev };
        expiredIds.forEach((id) => {
          if (next[id] === "failed") delete next[id];
        });
        return next;
      });
    }
    const stored = loadRecentUploads();
    held.forEach(([sid, { model, followed }]) => {
      const run = stored.find((r) => r.sessionId === sid);
      if (run?.status !== "Processing" || run.ownerId !== user.id) return;
      setPhase(sid);
      startInferencePolling(sid, model, followed);
    });
    queuedDiscards().forEach(discardServerUpload);
    // discardServerUpload only reads a ref: keyed on who is signed in, like the effects around it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // The auth provider stamps runs saved before entries carried an owner with
  // the account the server says they are (adoptLegacyRuns). One still running
  // is taken up like any other of the account's (resumed if its upload or
  // dispatch was cut short, followed otherwise), and the cards refresh either way.
  useEffect(() => {
    const onAdopted = (event: Event) => {
      const { userId, adopted } = (event as CustomEvent<RunsAdopted>).detail;
      if (userId !== authUserIdRef.current) return;
      setRecentUploads(loadRecentUploads());
      const going = adopted.filter((u) => u.status === "Processing");
      if (going.length > 0) void resumeAdoptedRef.current?.(going);
    };
    window.addEventListener(RUNS_ADOPTED_EVENT, onAdopted);
    return () => window.removeEventListener(RUNS_ADOPTED_EVENT, onAdopted);
    // Reads refs and stable setters only, like the effects around it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The daily scan allowance, when usage already says it is spent and the
  // window has not reset. Null when there is room, or when usage is not loaded
  // yet (the server's 402 at dispatch stays the fallback then).
  // `requested` is how many files are about to run: a batch bigger than what
  // is left would only have its first scans accepted, after every file had been
  // sent, so it is blocked up front like a spent allowance is.
  const dailyScansBlock = (requested = 1): UpgradeBlock | null => {
    const scans = usage?.scans;
    if (!scans || scans.limit == null || scans.used + requested <= scans.limit) return null;
    if (!scans.resets_at || !(Date.parse(scans.resets_at) > Date.now())) return null;
    return {
      reason: "daily_scans", limit: scans.limit, used: scans.used, resetsAt: scans.resets_at,
      requested, plan: plan as PlanId,
    };
  };

  // Declared after the account-boundary effect on purpose: after a switch of
  // account, that effect forgets the old account's pre-uploads first and this
  // one then starts fresh ones under the new account.
  //
  // Start uploading every selected NIfTI file the instant it's selected, once
  // a model that will run is chosen, so Run is instant. preStartUpload is
  // idempotent per item id, so this can safely re-run on every render where
  // any dependency changed; it only does real work the first time a given
  // item appears. Nothing uploads while the model is "None": that option
  // promises the file never leaves the browser (chooseModel also stops any
  // pre-upload a previous choice started). Picking a real model later starts
  // the upload then.
  //
  // Mirrors handleRunEpaiInference's own plan-limit check: a selection that
  // Run would refuse outright must not upload anything first - sending scan
  // data for a run the plan won't allow wastes bandwidth and, on a medical
  // imaging site, transmits patient data pointlessly. Skipping here just
  // means nothing pre-uploads; Run's existing check still explains why and
  // blocks the batch exactly as before.
  useEffect(() => {
    // Guests never pre-upload. Every setSelectedItems writer already sits
    // behind ensureAccount, but that is an invariant a refactor can break -
    // the server now refuses unauthenticated uploads, so failing closed here
    // just avoids a doomed request.
    if (!authUserId) return;
    // View only, or no model picked yet: nothing leaves the browser.
    if (selectedModel === "None" || selectedModel === "") return;
    // A model the plan locks would 402 at Run anyway - don't send scan data
    // for a run that can never start.
    if (isModelLocked(plan, selectedModel)) return;
    const slots = maxConcurrentScans(plan as PlanId);
    const running = ownRecentUploads.filter((u) => u.status === "Processing").length;
    if (selectedItems.length + running > slots) return;
    // Today's scans already spent: the server would 402 the run at dispatch.
    if (dailyScansBlock(selectedItems.length)) return;
    selectedItems.forEach(preStartUpload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authUserId, selectedModel, selectedItems, plan, ownRecentUploads, usage]);

  // Leaving the page drops its selection, so a pre-upload nobody pressed Run
  // for can never be used again: stop it and have the server delete what
  // arrived (the request is keepalive, so it outlives the page). One Run has
  // handed on stays with its run, which carries on without this page.
  useEffect(
    () => () => {
      itemUploadRef.current.forEach((pre, itemId) => {
        if (handedToRunRef.current.has(itemId)) return;
        discardPreUpload(pre);
        itemUploadRef.current.delete(itemId);
      });
    },
    // Refs only, so the first render's closure sees what the last one would.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /* ── Run inference ── */
  // Queue one scan's upload/inference. Shared by single and batch runs. The
  // upload itself waits its turn on uploadChainRef - only one file is on the
  // wire at a time - so every scan can drive the foreground progress bar when
  // it gets there, without two of them fighting over it.
  const startScanRun = async (
    item: SelectedItem,
    model: string,
    batch?: { batchId: string; batchLabel: string },
  ) => {
    // A NIfTI file already has a background upload in flight (or finished) if
    // one was started at selection time - reuse its session id and skip
    // straight to waiting on it instead of re-uploading from scratch.
    const pre = item.kind === "nifti" ? itemUploadRef.current.get(item.id) : undefined;
    const sid = pre?.sid ?? crypto.randomUUID();
    // Held until this run's upload and dispatch are over, so a remount of the
    // page meanwhile leaves it alone (see sessionHolds).
    const release = holdSession(sid);
    // Runs from the Run button, never during render; the compiler's purity
    // check reads this handler as render code once the rest of the component
    // analyses cleanly.
    // eslint-disable-next-line react-hooks/purity
    const ts = Date.now();
    // Keep the raw filename for reference, but name the scan meaningfully by
    // default (model + date); the user can rename it later.
    const sourceName = (item.kind === "dicom" ? item.label : item.file.name) || undefined;
    const label = friendlyScanName(model, ts);
    const fileSizeBytes =
      item.kind === "dicom"
        ? item.files.reduce((sum, f) => sum + f.size, 0)
        : item.file.size;
    sessionFileSizeRef.current.set(sid, fileSizeBytes);
    saveScanTiming(sid, { sizeBytes: fileSizeBytes });

    track("upload_start_inference");
    setRecentUploads(
      addRecentUpload({
        sessionId: sid,
        label,
        sourceName,
        model,
        status: "Processing",
        timestamp: ts,
        isReconstruction: model === "OpenVAE",
        batchId: batch?.batchId,
        batchLabel: batch?.batchLabel,
        ownerId: authUserIdRef.current ?? undefined,
      }),
    );

    handedToRunRef.current.delete(item.id);
    if (pre) {
      itemUploadRef.current.delete(item.id);
      setItemUploadStatus((prevStatus) => {
        if (!(item.id in prevStatus)) return prevStatus;
        const { [item.id]: _dropped, ...rest } = prevStatus;
        return rest;
      });
      setItemUploadProgress((prevProgress) => {
        if (!(item.id in prevProgress)) return prevProgress;
        const { [item.id]: _dropped, ...rest } = prevProgress;
        return rest;
      });
      setPhase(sid, "uploading"); // harmless if the background upload already finished
      const epoch = authEpochRef.current;
      void (async () => {
        const uploadedName = await pre.uploadDone;
        if (epoch !== authEpochRef.current) {
          // Signed out (or switched account) while this waited. Nothing more
          // goes on the wire now; park it where the account's next sign-in
          // picks it up (see the account-boundary effect) instead of
          // stranding a Processing card with nothing behind it.
          if (item.kind === "nifti") {
            await savePendingUpload({
              sessionId: sid,
              file: uploadedName ? new Blob() : item.file,
              filename: item.file.name,
              model,
              bdmapId: "",
              totalChunks: Math.ceil(item.file.size / CHUNK_SIZE),
              nextChunk: 0,
              chunkSize: CHUNK_SIZE,
              ...(uploadedName ? { uploadedFilename: uploadedName } : {}),
            });
          }
          return;
        }
        if (!uploadedName) {
          // Cancel aborts this same upload (same session id) - that run is
          // over, so it must neither be retried nor relabelled Failed.
          if (runCancelled(sid)) return;
          // The background pre-upload failed. The file is still in hand, so
          // retry through the normal resumable path under the same session
          // instead of insta-failing a run the user just asked for. runUpload
          // surfaces its own errors, so if this retry also fails the card
          // fails with a reason.
          if (item.kind === "nifti") {
            const retry: PendingUpload = {
              sessionId: sid,
              file: item.file,
              filename: item.file.name,
              model,
              bdmapId: "",
              totalChunks: Math.ceil(item.file.size / CHUNK_SIZE),
              nextChunk: 0,
              chunkSize: CHUNK_SIZE,
            };
            const resumable = await savePendingUpload(retry);
            uploadRemainingRef.current.set(sid, item.file.size);
            setPhase(sid, "waiting");
            await enqueueUpload(
              () => {
                uploadResumableRef.current = resumable;
                return runUpload(retry, true);
              },
              undefined,
              sid,
            );
            return;
          }
          setPhase(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
          return;
        }
        await dispatchInference(sid, model, uploadedName, false);
      })().finally(release);
      return;
    }

    // Sits behind other files on the upload chain until its turn.
    setPhase(sid, "waiting");

    // The caller clears the whole selection before looping, so there's nothing to
    // consume here. A DICOM folder uploads its slices and converts server-side; a
    // NIfTI file rides the resumable path (stashed in IndexedDB so an interrupted
    // upload can resume). Reached only when no background upload was already
    // started for this item (e.g. it was selected while the model was "None").
    if (item.kind === "dicom") {
      const bytes = item.files.reduce((sum, f) => sum + f.size, 0);
      uploadRemainingRef.current.set(sid, bytes);
      void enqueueUpload(() => runDicomUpload(sid, item.files, model), undefined, sid).then(release);
      return;
    }

    const file = item.file;
    const pending: PendingUpload = {
      sessionId: sid,
      file,
      filename: file.name,
      model,
      bdmapId: "",
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      nextChunk: 0,
      chunkSize: CHUNK_SIZE,
    };
    const resumable = await savePendingUpload(pending);
    uploadRemainingRef.current.set(sid, file.size);
    void enqueueUpload(
      () => {
        // Set when this file actually starts, not when it was queued - otherwise
        // the last file in a batch would decide the unload warning for all of them.
        uploadResumableRef.current = resumable;
        return runUpload(pending, true);
      },
      undefined,
      sid,
    ).then(release);
  };

  const handleRunEpaiInference = async () => {
    if (!ensureAccount()) return;
    setPickError("");
    clearOldMessage();
    const items = selectedItems;
    const first = items[0] ?? null;

    // "None" model = view only: open the scan in its full local viewer, nothing is
    // uploaded or run. DICOM opens the /dicom viewer, NIfTI the /local-nifti viewer.
    if (selectedModel === "None") {
      if (!first) { setPickError("Select a scan to view first."); return; }
      if (items.length > 1) {
        setPickError(VIEW_ONE_SCAN_MESSAGE);
        return;
      }
      if (first.kind === "dicom") {
        setLocalDicomFiles(first.files);
        navigate("/dicom");
      } else {
        setLocalNiftiFile(first.file);
        navigate("/local-nifti");
      }
      return;
    }

    if (!first) {
      setPickError("Select a file to upload first.");
      return;
    }

    // Before anything uploads: the server would refuse a locked model with a
    // 402 only after the whole CT had been sent.
    if (modelLocked(selectedModel)) {
      const opt = MODEL_OPTIONS.find((m) => m.id === selectedModel);
      setUpgradeBlock({ reason: "model_locked", feature: opt?.label ?? selectedModel, plan: plan as PlanId });
      return;
    }

    // Caught here rather than per-file, so a plan that runs one scan at a time
    // says so before anything uploads instead of accepting the first and
    // rejecting the rest one 402 at a time.
    const slots = maxConcurrentScans(plan as PlanId);
    const running = ownRecentUploads.filter((u) => u.status === "Processing").length;
    if (items.length + running > slots) {
      setUpgradeBlock({
        reason: "concurrent_scans", limit: slots, used: running, requested: items.length, plan: plan as PlanId,
      });
      return;
    }

    // Same for a daily allowance already spent: say so before the CT is sent.
    const spent = dailyScansBlock(items.length);
    if (spent) { setUpgradeBlock(spent); return; }

    const model = selectedModel;
    setInferenceCompleted(false);

    // Multiple selected scans run together as one batch (shared id + label). A
    // single scan runs on its own with no batch metadata.
    const batch =
      items.length > 1
        ? { batchId: crypto.randomUUID(), batchLabel: `${items.length} scans` }
        : undefined;
    // This run claims the drop zone's status slot - a single scan uses
    // sessionId/inferenceCompleted for that (set inside startScanRun), a
    // batch uses this ref. Either way, starting a new run releases whatever
    // the slot was previously showing.
    trackedBatchIdRef.current = batch ? batch.batchId : null;

    // Snapshot then clear the selection, and queue every scan's run. Each lands
    // on the upload chain in selection order and is dispatched to the GPU queue
    // as soon as its own upload finishes. Run is disabled by the empty
    // selection, so focus on it moves to the file picker rather than <body>.
    if (document.activeElement === runBtnRef.current) chipRefocusRef.current = "picker";
    setSelectedItems([]);
    items.forEach((item) => handedToRunRef.current.add(item.id));
    for (const item of items) {
      await startScanRun(item, model, batch);
    }
  };

  // Download one completed scan's result zip. Parameterised so it works from a
  // completed card and from inside the batch-details modal. Returns whether
  // the download actually started, so downloadBatch can report honestly.
  // `say` is where the progress and error lines go: the page's notice by
  // default, the popup's own line when called from inside it.
  const downloadResult = async (
    sid: string,
    say: (text: string) => void = setMessage,
    onSignedOut?: () => void,
  ): Promise<boolean> => {
    say("Preparing download...");
    try {
      const statusRes = await fetch(`${API_BASE}/api/inference-status/${sid}`, {
        credentials: "include",
      });
      const statusData = await parseApiResponse(statusRes);
      if (statusRes.status === 401) throw new SignedOutError();
      if (!statusRes.ok)
        throw new Error(
          statusData.error || statusData.status || "Status check failed",
        );
      if (statusData.status !== "completed") {
        say(
          `Status: ${statusData.status || "unknown"}. Please wait until completed.`,
        );
        return false;
      }
      stopPolling(sid);

      const resultRes = await fetch(`${API_BASE}/api/get_result/${sid}`, {
        credentials: "include",
      });
      if (resultRes.status === 401) throw new SignedOutError();
      // 202 is "ok" to fetch but its body is a note, not the archive: the
      // server waited for the file and it never showed up.
      if (resultRes.status === 202) throw new ResultNotReadyError();
      if (!resultRes.ok) {
        const maybeJson = await parseApiResponse(resultRes);
        throw new Error(maybeJson?.error || "The result isn't available.");
      }
      const blob = await resultRes.blob();
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `epai_output_${sid}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(objectUrl);
      say(
        "Download started: zip includes combined_labels.nii.gz and output.csv",
      );
      return true;
    } catch (err) {
      console.error(err);
      if (err instanceof SignedOutError) {
        say("Your session expired. Sign in and download again.");
        promptAuth();
        onSignedOut?.();
        return false;
      }
      if (err instanceof ResultNotReadyError) {
        say("The results aren't ready yet. Try again in a minute.");
        return false;
      }
      say(`Download failed. ${serverFailureReason(err, "The result isn't available.")}`);
      return false;
    }
  };

  // Download a whole batch: one result zip per completed scan, sequentially
  // through the same per-scan path the single Download button uses. Interim
  // until a server-side batch-zip endpoint exists (there is none today).
  const downloadBatch = async (uploads: RecentUpload[], say: (text: string) => void = setMessage) => {
    const completed = uploads.filter(u => u.status === "Completed");
    if (completed.length === 0) { say("No scans in this batch finished, so there is nothing to download."); return; }
    say(`Downloading ${completed.length} scan${completed.length === 1 ? "" : "s"}...`);
    let ok = 0;
    // A lapsed sign-in fails every scan the same way: ask once, then stop.
    let signedOut = false;
    // A scan whose own Download is already running is that button's to finish,
    // so it is left out of this run rather than saved twice.
    let attempted = 0;
    for (const u of completed) {
      if (busyDownloadsRef.current.includes(u.sessionId)) continue;
      busyDownloadsRef.current = [...busyDownloadsRef.current, u.sessionId];
      setBusyDownloads(busyDownloadsRef.current);
      attempted++;
      try {
        if (await downloadResult(u.sessionId, say, () => { signedOut = true; })) ok++;
      } finally {
        busyDownloadsRef.current = busyDownloadsRef.current.filter((k) => k !== u.sessionId);
        setBusyDownloads(busyDownloadsRef.current);
      }
      if (signedOut) break;
    }
    // downloadResult already said the sign-in lapsed and opened the prompt.
    if (signedOut) return;
    if (attempted === 0) return;
    say(
      ok === attempted
        ? `Downloaded ${ok} scan${ok === 1 ? "" : "s"}.`
        : attempted === 1
          ? "The download failed. Use Download on the scan to try again."
          : `Downloaded ${ok} of ${attempted} scans. The rest failed, use each scan's own Download button to retry.`,
    );
  };

  const handleRunEpaiOnReconstruction = async () => {
    if (!sessionId) {
      setMessage("No completed reconstruction session to run ePAI on.");
      return;
    }
    setInferenceCompleted(false);
    setMessage("Starting ePAI inference on reconstructed CT...");

    try {
      const started = await startEpaiOnReconstruction({
        sourceSessionId: sessionId,
        newSessionId: crypto.randomUUID(),
        // Whose run this is is read when it starts, not when the reply
        // arrives after a sign-out or an account switch.
        account: () => ({
          ownerId: authUserIdRef.current ?? undefined,
          epoch: authEpochRef.current,
        }),
        parseResponse: parseApiResponse,
      });
      // The run exists server-side either way, so it is listed under the
      // account that started it.
      setRecentUploads(addRecentUpload(started.entry));
      // A different account is looking at the page now: it neither adopts this
      // run as its current scan nor polls a session it can't read.
      if (started.superseded) return;
      const sid = started.sessionId;
      setSessionId(sid);
      setSelectedModel("ePAI" as const);
      setMessage("ePAI inference started on reconstructed CT.");
      startInferencePolling(sid, "ePAI");
    } catch (err) {
      console.error(err);
      setMessage(
        `ePAI couldn't be started on the reconstruction. ${serverFailureReason(err, "The server couldn't start it.")} Try again.`,
      );
    }
  };

  /* ── Render ── */
  const previewItem = selectedItems.find((i) => i.id === previewItemId) ?? null;
  // Whole-box "done" state: every selected NIfTI has finished uploading, and
  // there's at least one NIfTI item (a DICOM-only or empty selection has
  // nothing to have finished, so it stays neutral rather than reading as a
  // false "done").
  const niftiItems = selectedItems.filter((i) => i.kind === "nifti");
  const allUploadsDone =
    niftiItems.length > 0 &&
    niftiItems.every((i) => itemUploadStatus[i.id] === "done");

  // Hoisted above the JSX (rather than computed further down where these were
  // originally rendered) so the dropzone can show in-flight runs itself once
  // Run has been clicked, instead of a separate card appearing lower on the
  // page - the same box that took the upload keeps showing its status.
  const groups = groupUploads(ownRecentUploads);
  const batchNames = batchButtonNames(groups);
  const inFlight = groups.filter(isGroupInFlight);
  const closeNote = closeInfo.active
    ? closeInfo.eta === null
      ? "keep tab open"
      : `safe to close in ${formatEta(closeInfo.eta)}`
    : "safe to close";

  // The batch currently claiming the drop zone's status slot (see
  // trackedBatchIdRef), once it's fully resolved (no scan in it still
  // Processing). Single-scan completion uses sessionId/inferenceCompleted
  // instead - resolved separately below, right where it's rendered.
  const trackedBatchId = trackedBatchIdRef.current;
  const activeBatchGroup = trackedBatchId
    ? groups.find((g) => g.kind === "batch" && g.batchId === trackedBatchId)
    : undefined;
  const activeBatchCompleted =
    activeBatchGroup && activeBatchGroup.kind === "batch" && !isGroupInFlight(activeBatchGroup)
      ? activeBatchGroup
      : undefined;
  // finishSession sets sessionId/inferenceCompleted for EVERY finished scan,
  // batch members included (the last one to finish wins) - so this only
  // counts as "a single scan just finished" when that session isn't part of
  // a batch, letting the batch branch above take it instead.
  // The flags are loose and outlive the scan they were set for (a second run's
  // dispatch sets sessionId without clearing inferenceCompleted), so the card
  // also needs that scan itself to be Completed, not queued, running or cancelled.
  const shownUpload = ownRecentUploads.find((u) => u.sessionId === sessionId);
  const singleCompletedVisible =
    inferenceCompleted && shownUpload?.status === "Completed" && !shownUpload.batchId;

  // Completed Uploads (below) lists everything finished-and-unviewed - EXCEPT
  // whatever the drop zone itself is currently showing as just-completed, so
  // that scan/batch doesn't appear twice on the page at once. It reappears
  // there normally once its drop-zone slot is released.
  const { recent: finished, older } = splitByAge(
    groups.filter((g) => {
      if (isGroupInFlight(g)) return false;
      if (activeBatchCompleted && g.kind === "batch" && g.batchId === activeBatchCompleted.batchId) return false;
      if (singleCompletedVisible && g.kind === "single" && g.upload.sessionId === sessionId) return false;
      return true;
    }),
  );
  // The History link counts scans, as the History page lists them: a batch is
  // one group here but one row per scan there.
  const olderScans = older.reduce((n, g) => n + (g.kind === "batch" ? g.uploads.length : 1), 0);

  // A download line belongs to the rows it was pressed on: drop it when the
  // section's rows change or the section goes away.
  const finishedKey = finished.map((g) => (g.kind === "single" ? g.upload.sessionId : g.batchId)).join("|");
  useEffect(() => {
    clearListNote();
    // clearListNote only touches a ref and a setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finishedKey]);

  // Whether the drop zone is showing a run's progress or result; true whatever
  // the selection is, so picking another file never hides it.
  const hasStatusCards = inFlight.length > 0 || singleCompletedVisible || !!activeBatchCompleted;

  // An in-flight scan this tab isn't driving because nobody is signed in (a
  // guest never resumes anything). Says so instead of claiming it's running.
  // Not while auth is still settling, or every reload would flash it. Another
  // account's scans are not listed at all (see ownRecentUploads).
  const pausedLabel = (): string | null => {
    if (authLoading) return null;
    if (!authUserId) return "Paused, sign in to resume";
    return null;
  };

  // ── A single in-flight scan (not part of a batch) ──
  // A render helper, not a component declared in render: the ETA ticker
  // re-renders once a second, and a fresh component type each time would
  // remount the card and throw keyboard focus off its Cancel button.
  const processingCard = (u: RecentUpload) => {
    const phase = sessionPhases[u.sessionId];
    const queuePos = queuePositions[u.sessionId];
    const paused = pausedLabel();
    const phaseLabel =
      paused ??
      (phase === "waiting" ? "Waiting to upload…" :
      phase === "uploading" ? "Uploading…" :
      phase === "elsewhere" ? "Uploading in another tab…" :
      phase === "signin" ? "Sign in to see progress" :
      phase === "queued" ? (queuePos ? `#${queuePos} in queue` : "Queued for GPU") :
      "Running…");
    return (
      <div key={u.sessionId} className="upload-proc-card">
        <div className="upload-row">
          <div className="upload-row__main">
            <div className="upload-row__icon upload-row__icon--live">{/* A static pulsing dot per scan instead of a spinning wheel:
                 multiple in-flight scans shouldn't each spin. The single
                 spinner lives in the batch ProcessingSummaryBar. */}
              {!paused && <span className="animate-pulse upload-row__dot" />}
            </div>
            <div className="upload-row__text">
              <div className="upload-row__title">{u.label}</div>
              <div className="upload-row__meta">
                {scanMetaItems(u)}
                <span className={`proc-close-note${closeInfo.active ? "" : " proc-close-note--ready"}`}>
                  <span className="proc-close-note__sep" aria-hidden="true">• </span>{closeNote}
                </span>
              </div>
            </div>
          </div>
          <div className="upload-row__actions">
            <span className={`upload-row__status${phase === "queued" || paused ? " upload-row__status--quiet" : ""}`}>{phaseLabel}</span>
            <button type="button" className="active-cancel-btn" aria-label={`Cancel ${scanAccessibleName(u, ownRecentUploads)}`} onClick={() => { listRefocusRef.current = "@picker"; cancelRun(u); }}>Cancel</button>
          </div>
        </div>
        {/* No real percent-complete exists for inference (nnU-Net doesn't
            report progress mid-run), so instead of an indeterminate sweep
            that told the user nothing, this shows how long the run has
            left based on how this model's runs typically take. Only shown
            once actually running: during "queued" there's no dispatch-time
            signal to build an estimate from. */}
        {phase === "running" && !paused && etaInputs[u.sessionId] && (
          <div className="upload-row__eta">
            {estimateRemaining(
              u.model || "",
              etaInputs[u.sessionId].startedAt,
              etaInputs[u.sessionId].sizeBytes,
              durationEstimates[u.sessionId],
            )}
          </div>
        )}
      </div>
    );
  };

  const inFlightCards = inFlight.length > 0 && (
    <div className="dropzone-inflight" onClick={(e) => e.stopPropagation()} style={{ display: "flex", flexDirection: "column", gap: "8px", width: "100%" }}>
      {inFlight.map(g => {
        if (g.kind === "single") return processingCard(g.upload);
        const running = g.uploads.filter(u => u.status === "Processing");
        const done = g.uploads.filter(u => u.status === "Completed").length;
        // Failed/Cancelled scans stay in the total so the counter's
        // denominator never shrinks mid-batch.
        const failed = g.uploads.filter(u => u.status === "Failed").length;
        const cancelled = g.uploads.filter(u => u.status === "Cancelled").length;
        const phases = running.map(u => sessionPhases[u.sessionId]);
        const paused = running.length > 0 ? pausedLabel() : null;
        const statusLabel =
          paused ??
          (phases.some(p => p === "signin") ? "Sign in to see progress" :
          phases.some(p => p === undefined || p === "running") ? "Running…" :
          phases.some(p => p === "queued") ? "Queued for GPU" : "Uploading…");
        return (
          <ProcessingSummaryBar key={g.batchId} title={g.label} buttonName={batchNames.get(g.batchId)} running={running.length}
            done={done} failed={failed} cancelled={cancelled} statusLabel={statusLabel}
            closeNote={closeNote} closeReady={!closeInfo.active}
            onViewDetails={() => { track("upload_open_batch_details"); setDetailsBatchId(g.batchId); }}
            onCancelAll={() => {
              listRefocusRef.current = "@picker";
              running.forEach(u => cancelRun(u));
              // Each cancelRun says "Cancelled <its scan>" and the last one would
              // win: say it once for the whole batch instead.
              setMessage(running.length === 1 ? `Cancelled ${running[0].label}` : `Cancelled ${running.length} scans`);
            }} />
        );
      })}
    </div>
  );

  // Which buttons to offer follows the scan that finished, not the model
  // picked since: a reconstruction and a segmentation open at different routes.
  const finishedIsReconstruction = Boolean(
    ownRecentUploads.find((u) => u.sessionId === sessionId)?.isReconstruction,
  );

  // ── A single scan's finished state, shown in the SAME drop-zone slot that
  // showed its progress (and its file chip before that) - not a separate
  // panel appearing elsewhere on the page. ──
  const singleCompletedCard = singleCompletedVisible && (
    <div
      className="result-section dropzone-completed"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="result-title" role="status">
        <span className="result-title-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <span>Inference complete</span>
      </div>
      <div className="result-btns">
        {finishedIsReconstruction ? (
          <>
            <button
              className="result-btn"
              onClick={() => {
                setRecentUploads(markRecentUploadViewed(sessionId));
                navigate(`/reconstruction/${sessionId}`);
              }}
            >
              View reconstruction
            </button>
            <button className="result-btn" onClick={handleRunEpaiOnReconstruction}>
              Run ePAI on result
            </button>
            <button
              className="result-btn"
              aria-busy={busyDownloads.includes(sessionId) || undefined}
              style={busyDownloads.includes(sessionId) ? { opacity: 0.6, cursor: "progress" } : undefined}
              onClick={() => downloadFromList(sessionId, () => downloadResult(sessionId))}
            >
              Download
            </button>
          </>
        ) : (
          <>
            <button
              className="result-btn result-btn-primary"
              onClick={() => {
                setRecentUploads(markRecentUploadViewed(sessionId));
                navigate(`/session/${sessionId}`);
              }}
            >
              View visualization
            </button>
            <button
              className="result-btn"
              aria-busy={busyDownloads.includes(sessionId) || undefined}
              style={busyDownloads.includes(sessionId) ? { opacity: 0.6, cursor: "progress" } : undefined}
              onClick={() => downloadFromList(sessionId, () => downloadResult(sessionId))}
            >
              Download results
            </button>
          </>
        )}
      </div>
    </div>
  );

  // ── A batch's finished state, same idea: the ProcessingSummaryBar that
  // showed its progress just relabels itself instead of being replaced by
  // something else. No Cancel button (nothing left to cancel); View details
  // also releases the slot, so the box returns to normal once it's been seen. ──
  const batchCompletedCard = activeBatchCompleted && (
    <div className="dropzone-completed" onClick={(e) => e.stopPropagation()} style={{ width: "100%" }}>
      <ProcessingSummaryBar
        title={activeBatchCompleted.label}
        buttonName={batchNames.get(activeBatchCompleted.batchId)}
        running={0}
        done={activeBatchCompleted.uploads.filter((u) => u.status === "Completed").length}
        // Failed and cancelled scans stay in the total (e.g. 3/5, not 3/3); the
        // bar itself appends "· N failed" and "· N cancelled", so the label doesn't repeat them.
        failed={activeBatchCompleted.uploads.filter((u) => u.status === "Failed").length}
        cancelled={activeBatchCompleted.uploads.filter((u) => u.status === "Cancelled").length}
        // Nothing finished: the bar's own "· N failed" or "· N cancelled" says
        // which, so the label must not say it a second time.
        statusLabel={
          activeBatchCompleted.uploads.some((u) => u.status === "Completed")
            ? batchFinishedLabel(activeBatchCompleted.uploads)
            : "No scans finished"
        }
        onViewDetails={() => {
          track("upload_open_batch_details");
          setDetailsBatchId(activeBatchCompleted.batchId);
          trackedBatchIdRef.current = null;
        }}
      />
    </div>
  );

  // The Model step's rows. LesionSegmenter carries its lesion picker as a
  // submenu; lesionTarget keeps whatever it was last set to even while
  // another model is active, so a lesion only shows checked while
  // LesionSegmenter itself is the selected model.
  const modelMenuItems: PipelineMenuItem[] = MODEL_OPTIONS.map((m) => {
    const locked = modelLocked(m.id);
    return {
      id: m.id,
      label: m.label,
      desc: m.desc,
      checked: selectedModel === m.id,
      locked,
      badge: locked ? "Donate" : undefined,
      submenu:
        !locked && m.id === "LesionSegmenter"
          ? LESION_OPTIONS.map((l) => ({
              id: l.id,
              label: l.label,
              checked: selectedModel === "LesionSegmenter" && lesionTarget === l.id,
            }))
          : undefined,
    };
  });

  return (
    <div className="upload-page-wrapper">
      {/* Ambient glow */}
      <div className="ambient-orbs">
        <div className="orb orb-1" />
        <div className="orb orb-2" />
      </div>

      <Header />

      <main className="upload-main">
        <h1 ref={pageHeadingRef} tabIndex={-1} className="sr-only">Upload a CT scan</h1>
        <div className="upload-card">
          {/* ── Drop zone ── */}
          <div
            className={`dropzone${isDragOver ? " drag-over" : ""}${allUploadsDone ? " dropzone--all-done" : ""}`}
            onClick={(e) => {
              // The hidden pickers live inside this box, so a programmatic
              // input.click() (Select DICOM) bubbles up here. Ignore it, or
              // the NIfTI chooser opens over the DICOM one.
              if ((e.target as HTMLElement).tagName === "INPUT") return;
              // While a run is in-flight, or just finished and still showing
              // its result here, this box is showing status, not the picker -
              // a stray click on the card's own padding shouldn't pop the
              // file dialog.
              if (
                selectedItems.length === 0 &&
                (inFlight.length > 0 || singleCompletedVisible || activeBatchCompleted)
              ) return;
              if (ensureAccount()) fileInputRef.current?.click();
            }}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".nii,.gz"
              style={{ display: "none" }}
              onChange={handleFileSelect}
            />
            <input
              // Set the folder-picker attributes imperatively — passing webkitdirectory
              // as a JSX/spread prop doesn't reliably apply it, so the picker falls back
              // to single files. The IDL property is set too: engines disagree on which
              // one they read when it's applied after the element is parsed. On iOS and
              // Android none of this has any effect (no browser there can pick a folder),
              // so the picker hands back plain files — handleDicomInferenceSelect takes
              // any file list, so selecting the slices themselves works there.
              ref={(el) => {
                dicomUploadInputRef.current = el;
                if (el) {
                  el.webkitdirectory = true;
                  el.setAttribute("webkitdirectory", "");
                  el.setAttribute("directory", "");
                }
              }}
              type="file"
              multiple
              style={{ display: "none" }}
              onChange={handleDicomInferenceSelect}
            />
            <input
              ref={dicomFilesInputRef}
              type="file"
              multiple
              // Do not restrict this picker by extension: many valid DICOM
              // slices have no extension at all. addDicomFiles filters them.
              style={{ display: "none" }}
              onChange={handleDicomInferenceSelect}
            />
            {/* Always mounted, so the batch bar swapping for its finished card
                still changes this text instead of mounting new text. aria-live,
                not role=status, so the page's single-scan status card stays the
                only status role. */}
            <span className="sr-only" aria-live="polite" aria-atomic="true" data-testid="batch-announcement">
              {activeBatchCompleted
                ? batchAnnouncement({
                    title: activeBatchCompleted.label,
                    running: 0,
                    done: activeBatchCompleted.uploads.filter((u) => u.status === "Completed").length,
                    failed: activeBatchCompleted.uploads.filter((u) => u.status === "Failed").length,
                    cancelled: activeBatchCompleted.uploads.filter((u) => u.status === "Cancelled").length,
                  })
                : ""}
            </span>
            {hasStatusCards && (
              // A run that is going, or one that just finished and is still
              // showing its result, stays in this box - also while another file
              // is picked, so its progress, Cancel, View and Download never
              // vanish behind the new chip (the Completed uploads list below
              // leaves exactly these scans out, see `finished`).
              <div
                className="dropzone-status"
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                  width: "100%",
                  marginBottom: selectedItems.length > 0 ? "12px" : undefined,
                }}
              >
                {inFlightCards}
                {singleCompletedCard}
                {batchCompletedCard}
              </div>
            )}
            {selectedItems.length === 0 ? (
              hasStatusCards ? null : (
              <>
                <svg
                  className="dropzone-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
                <div className="dropzone-text">Click or drag to upload</div>
              </>
              )
            ) : (
              // ── Selected items: NIfTI files + DICOM series, each individually
              // previewable ── lives inside the dropzone itself now, so the file's
              // name/type/size sit in the same box as the picker instead of as a
              // separate row underneath it. Each chip reflects its own background
              // upload status: DICOM never pre-uploads (it starts on Run), so it
              // has no "uploading" state of its own here.
              <div
                className="file-chips"
                onClick={(e) => e.stopPropagation()}
              >
                {selectedItems.map((item) => {
                  const name =
                    item.kind === "dicom" ? item.label : item.file.name;
                  const subParts =
                    item.kind === "dicom"
                      ? ["DICOM series", `${item.files.length} slice${item.files.length === 1 ? "" : "s"}`]
                      : ["NIfTI", formatBytes(item.file.size)];
                  const isOpen = previewItemId === item.id;
                  const uploadStatus =
                    item.kind === "nifti" ? itemUploadStatus[item.id] : undefined;
                  const uploadPct = itemUploadProgress[item.id] ?? 0;
                  return (
                    <div
                      key={item.id}
                      className={`file-chip${isOpen ? " file-chip--active" : ""}${uploadStatus ? ` file-chip--${uploadStatus}` : ""}`}
                    >
                      <div className="file-chip-row">
                        <span className="file-chip-icon" aria-hidden="true">
                          {uploadStatus === "uploading" ? (
                            <span className="file-chip-spinner" />
                          ) : uploadStatus === "done" ? (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M20 6L9 17l-5-5" />
                            </svg>
                          ) : (
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                          )}
                        </span>
                        <span className="file-chip-text">
                          <span className="file-chip-name">{name}</span>
                          <span className="file-chip-sub">
                            {subParts.map((part, i) => (
                              <span key={part} className="file-chip-sub-part">
                                {i > 0 && <span className="file-chip-sub-sep"> · </span>}
                                {part}
                              </span>
                            ))}
                            {uploadStatus && (
                              <span className="file-chip-sub-part">
                                <span className="file-chip-sub-sep"> · </span>
                                {uploadStatus === "uploading"
                                  ? `uploading ${uploadPct}%`
                                  : uploadStatus === "done"
                                    ? "ready"
                                    : "upload failed"}
                              </span>
                            )}
                          </span>
                        </span>
                        <button
                          className="file-chip-preview"
                          aria-label={`${isOpen ? "Hide" : "Preview"} ${name}`}
                          aria-expanded={isOpen}
                          onClick={() =>
                            setPreviewItemId((prev) =>
                              prev === item.id ? null : item.id,
                            )
                          }
                        >
                          {isOpen ? "Hide" : "Preview"}
                        </button>
                        <button
                          className="file-chip-remove"
                          onClick={() => removeItem(item.id)}
                          aria-label={`Remove ${name}`}
                          data-chip-remove={item.id}
                        >
                          ×
                        </button>
                      </div>
                      {uploadStatus === "uploading" && (
                        <div className="file-chip-progress-track">
                          <div
                            className="file-chip-progress-fill"
                            style={{ transform: `scaleX(${uploadPct / 100})` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div className="dropzone-btn-row">
              <button
                type="button"
                className="dropzone-btn"
                ref={selectNiftiBtnRef}
                onClick={(e) => {
                  e.stopPropagation();
                  if (ensureAccount()) fileInputRef.current?.click();
                }}
              >
                Select NIfTI file
              </button>
              <button
                type="button"
                className="dropzone-btn"
                title="Choose a DICOM folder when supported, otherwise choose the DICOM slice files."
                onClick={(e) => {
                  e.stopPropagation();
                  void chooseDicomFiles();
                }}
              >
                Select DICOM
              </button>
            </div>
          </div>

          {/* ── Pre-inference preview: inspect the selected scan before running a model.
              Not held back while a transfer is sending: Preview would flip to Hide
              and show nothing for the minutes a large CT takes. ── */}
          {previewItem && (
            <>
              <div className="ct-preview-label">
                Preview ·{" "}
                {previewItem.kind === "dicom"
                  ? previewItem.label
                  : previewItem.file.name}
              </div>
              <Suspense
                fallback={
                  <div className="ct-preview ct-preview--msg" role="status">
                    Loading preview…
                  </div>
                }
              >
                {previewItem.kind === "dicom" ? (
                  <DicomPreview files={previewItem.files} />
                ) : (
                  <CtPreview file={previewItem.file} />
                )}
              </Suspense>
            </>
          )}

          {/* ── Pipeline row ── */}
          <div className="pipeline-row">
            {/* Step 1: Preprocessing */}
            <div className="pipeline-step">
              <div className="pipeline-step-header">
                <div className="pipeline-badge" aria-hidden="true">1</div>
                <span className="pipeline-label" id="upload-step-pre">Preprocessing</span>
                <span className="pipeline-optional">optional</span>
              </div>
              {/* OpenVAE preprocessing isn't wired into the run yet (nothing
                  consumes this value), so it's shown but disabled rather
                  than silently discarded. */}
              <UploadPipelineMenu
                labelId="upload-step-pre"
                valueText={preValue || "None (skip)"}
                hasValue={!!preValue}
                open={preDropOpen}
                onOpenChange={setPreDropOpen}
                items={PRE_OPTIONS.map((opt) => ({ ...opt, checked: preValue === opt.id }))}
                onSelect={(id) => setPreValue(id)}
              />
            </div>

            <div className="pipeline-arrow" aria-hidden="true">→</div>

            {/* Step 2: Model */}
            <div className="pipeline-step">
              <div className="pipeline-step-header">
                <div className="pipeline-badge" aria-hidden="true">2</div>
                <span className="pipeline-label" id="upload-step-model">Model</span>
              </div>
              <UploadPipelineMenu
                labelId="upload-step-model"
                valueText={
                  selectedModel === "None"
                    ? "None (view scan)"
                    : selectedModel === "LesionSegmenter"
                      ? `LesionSegmenter (${(
                          LESION_OPTIONS.find((l) => l.id === lesionTarget)?.label ?? "Pancreatic lesion"
                        ).toLowerCase()})`
                      : MODEL_OPTIONS.find((m) => m.id === selectedModel)?.label || "Select a model"
                }
                hasValue={!!selectedModel}
                open={modelDropOpen}
                onOpenChange={setModelDropOpen}
                items={modelMenuItems}
                onSelect={(id) => {
                  // Locked models stay visible with a "Donate" pill rather
                  // than being hidden (you can't want what you can't see),
                  // and picking one explains the lock instead of selecting.
                  if (modelLocked(id)) {
                    const opt = MODEL_OPTIONS.find((m) => m.id === id);
                    setUpgradeBlock({
                      reason: "model_locked", feature: opt?.label ?? id, plan: plan as PlanId,
                    });
                    return;
                  }
                  track("upload_select_model");
                  chooseModel(id as typeof selectedModel);
                }}
                onSelectSub={(_itemId, lesionId) => {
                  chooseModel("LesionSegmenter");
                  setLesionTarget(lesionId as typeof lesionTarget);
                }}
                footer={
                  isAuthenticated && modelLocked("ePAI") ? (
                    <div className="model-dropdown-access" onClick={(event) => event.stopPropagation()}>
                      <button
                        type="button"
                        className="model-dropdown-access__toggle"
                        aria-expanded={couponOpen}
                        onClick={() => {
                          setCouponOpen((open) => !open);
                          setCouponError(null);
                        }}
                      >
                        Have an admin access coupon?
                      </button>
                      {couponOpen && (
                        <form className="model-dropdown-access__form" onSubmit={submitAdminCoupon}>
                          <label htmlFor="admin-access-coupon">Access coupon</label>
                          <div className="model-dropdown-access__row">
                            <input
                              ref={couponInputRef}
                              id="admin-access-coupon"
                              type="password"
                              value={couponValue}
                              onChange={(event) => setCouponValue(event.target.value)}
                              placeholder="Enter coupon"
                              autoComplete="off"
                              // Not `disabled` while checking: a disabled control
                              // drops keyboard focus to the page.
                              readOnly={couponBusy}
                              aria-busy={couponBusy}
                            />
                            <button type="submit" aria-disabled={couponBusy} disabled={!couponBusy && !couponValue.trim()}>
                              {couponBusy ? "Checking…" : "Unlock"}
                            </button>
                          </div>
                          {couponError && <p role="alert">{couponError}</p>}
                          <small>Access is verified by the server and does not grant admin controls.</small>
                        </form>
                      )}
                    </div>
                  ) : undefined
                }
              />
            </div>

            <div className="pipeline-arrow" aria-hidden="true">→</div>

            {/* Step 3: Postprocessing */}
            <div className="pipeline-step pipeline-step--last">
              <div className="pipeline-step-header">
                <div className="pipeline-badge" aria-hidden="true">3</div>
                <span className="pipeline-label" id="upload-step-post">Postprocessing</span>
                <span className="pipeline-optional">optional</span>
              </div>
              {/* ShapeKit postprocessing isn't wired into the run yet (nothing
                  consumes this value), so it's shown but disabled - no Donate
                  lock on a control that does nothing. The plan gate returns
                  when the wiring lands. */}
              <UploadPipelineMenu
                labelId="upload-step-post"
                valueText={postValue || "None (skip)"}
                hasValue={!!postValue}
                open={postDropOpen}
                onOpenChange={setPostDropOpen}
                items={POST_OPTIONS.map((opt) => ({ ...opt, checked: postValue === opt.id }))}
                onSelect={(id) => {
                  track("upload_select_postprocessing");
                  setPostValue(id);
                }}
              />
            </div>

            <button
              type="button"
              className="run-btn"
              ref={runBtnRef}
              onClick={handleRunEpaiInference}
              // Not gated on isUploading: that flag now also covers background
              // pre-uploads (started the moment a file is selected, before Run
              // is even clickable), and Run needs to stay clickable while one
              // is in flight - handleRunEpaiInference's own empty-selection
              // check is what prevents a double-submit, not this.
              // Nothing selected means nothing to view or run, so it reads as
              // unavailable (and says why) instead of answering with an error.
              disabled={!selectedModel || selectedItems.length === 0}
              title={
                selectedItems.length === 0
                  ? (selectedModel === "None" ? "Select a scan to view first" : "Select a file to upload first")
                  : undefined
              }
            >
              {selectedModel === "None" ? "View" : "Run"}
            </button>
          </div>

          {/* Check Status removed (auto-polling covers it); Download now lives on
              completed entries in Completed Uploads, not as an always-on button.
              The old "Upload Progress" bar is gone too - uploads now start at
              selection time and finish well before Run is usually clicked, so a
              dedicated progress bar here was rarely seen and added a layout jump
              when it briefly appeared. The Active card below still reflects
              "Uploading…" phase for anyone who clicks Run while it's in flight. */}

          {/* ── Status messages (errors / transient feedback only) ──
              The live region is always in the page and only its content comes
              and goes, so screen readers announce each new message. */}
          <div aria-live="polite" aria-atomic="true">
            {selectedItems.map((item) =>
              itemUploadStatus[item.id] === "failed" && itemUploadError[item.id] ? (
                <div key={item.id} className="status-msg status-msg--error">
                  {itemUploadError[item.id]}
                </div>
              ) : null,
            )}
            {pickError && <div className="status-msg status-msg--error">{pickError}</div>}
            {message && <div className="status-msg">{message}</div>}
          </div>
        </div>

        {/* ── Sign-in prompt (signed-out only) ── */}
        {!authLoading && !isAuthenticated && (
          <div className="upload-account-banner">
            <span>
              <button type="button" className="upload-account-link" onClick={() => promptAuth()}>
                Sign in
              </button>{" "}
              to run inference.
            </span>
          </div>
        )}

        {/* ── Processing + Completed, grouped by batch ──
            Scans run together (multi-select) render as one batch bar; lone scans
            render as their own card. In-flight groups show above; finished ones
            drop into Completed Uploads, batches staying grouped. */}
        {(() => {
          // groups/inFlight/finished/older/closeNote are computed above (near
          // the top of render) so the dropzone can show the in-flight card
          // itself; reused here rather than recomputed.
          const canView = (u: RecentUpload) => u.status !== "Failed" && u.status !== "Cancelled";
          const openSession = (u: RecentUpload) => {
            if (!canView(u)) return;
            if (!u.viewed) setRecentUploads(markRecentUploadViewed(u.sessionId));
            navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${u.sessionId}`);
          };
          const removeBatch = (uploads: RecentUpload[]) => {
            let next = recentUploads;
            uploads.forEach(u => { next = removeRecentUpload(u.sessionId); });
            setRecentUploads(next);
          };

          // A row is taken out of the list by its key (session or batch id);
          // focus then goes to the next row's remove button, see listRefocusRef.
          const rowKeys = finished.map((g) => (g.kind === "single" ? g.upload.sessionId : g.batchId));
          const removeButton = (label: string, key: string, onClick: (e: React.MouseEvent) => void) => (
            <button
              type="button"
              className="upload-remove-btn"
              data-row-remove={key}
              onClick={(e) => {
                const at = rowKeys.indexOf(key);
                listRefocusRef.current = rowKeys[at + 1] ?? rowKeys[at - 1] ?? "@heading";
                onClick(e);
              }}
              title="Remove"
              aria-label={`Remove ${label}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          );

          // One shared icon container so single + batch entries line up identically.
          const fileIcon = (
            <div className="upload-row__icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
          );

          // Batch: stacked-layers glyph in the identical container (no ✓ — misleading
          // when a batch has 0 completed).
          const batchIcon = (
            <div className="upload-row__icon" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
              </svg>
            </div>
          );

          // processingCard is hoisted above (near the top of render) since the
          // dropzone now needs it too. The rows below are plain render
          // helpers rather than components declared in render, so a re-render
          // updates them in place instead of remounting them (which dropped
          // keyboard focus from their buttons). Single and batch rows share
          // the .upload-row shape, which stacks on phones (UploadPage.css).

          // ── A finished individual scan: status, View, Download, remove ──
          const completedCard = (u: RecentUpload) => (
            <div
              key={u.sessionId}
              className={`upload-row upload-row--card${canView(u) ? " upload-row--openable" : ""}`}
              // A drag that selects the name and is let go outside the field
              // clicks this row (the nearest common ancestor), not the input.
              onClick={() => { if (renamingId === u.sessionId) return; openSession(u); }}
            >
              <div className="upload-row__main">
                {fileIcon}
                <div className="upload-row__text">
                  {renamingId === u.sessionId ? (
                    // The field floats over a slot as tall as the title's line
                    // (see .upload-rename-slot), so starting a rename cannot
                    // grow the row or move the meta line.
                    <div className="upload-rename-slot">
                      <input
                        autoFocus
                        className="upload-rename-input"
                        aria-label="Scan name"
                        value={renameValue}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          // The Enter that picks an IME candidate (key 229 on
                          // some browsers) belongs to the composition.
                          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                          if (e.key !== "Enter" && e.key !== "Escape") return;
                          // Focus is about to land on the name button, which
                          // would otherwise take this same key press as its own
                          // Enter and reopen the edit.
                          e.preventDefault();
                          endRenameFromKeyboard(e.key === "Enter");
                        }}
                      />
                    </div>
                  ) : (
                    // Click the name itself to rename it - no separate pencil
                    // icon needed (matches how Claude's own chat titles work).
                    // Underline-on-hover is the only visual affordance; it is a
                    // real button, so it can be reached and used from the
                    // keyboard. The tooltip keeps surfacing the original
                    // filename once it's been renamed away from it.
                    <button
                      type="button"
                      title={u.sourceName || "Click to rename"}
                      aria-label={`Rename ${scanAccessibleName(u, ownRecentUploads)}`}
                      data-rename-trigger={u.sessionId}
                      onClick={(e) => { e.stopPropagation(); startRename(u); }}
                      className="upload-rename-trigger upload-row__title"
                    >
                      <span className="upload-rename-trigger__text">{u.label}</span>
                    </button>
                  )}
                  <div className="upload-row__meta">
                    {scanMetaItems(u)}
                  </div>
                </div>
              </div>
              <div className="upload-row__actions">
                <span className="upload-row__status" style={{ color: recentStatusColor(u.status) }}>{u.status}</span>
                {canView(u) && <button type="button" className="upload-small-btn" aria-label={`View ${scanAccessibleName(u, ownRecentUploads)}`} onClick={(e) => { e.stopPropagation(); openSession(u); }}>View</button>}
                {u.status === "Completed" && <button type="button" className="upload-small-btn" aria-label={`Download ${scanAccessibleName(u, ownRecentUploads)}`} aria-busy={busyDownloads.includes(u.sessionId) || undefined} style={busyDownloads.includes(u.sessionId) ? { opacity: 0.6, cursor: "progress" } : undefined} onClick={(e) => { e.stopPropagation(); downloadFromList(u.sessionId, (say) => downloadResult(u.sessionId, say)); }}>Download</button>}
                {removeButton(scanAccessibleName(u, ownRecentUploads), u.sessionId, (e) => { e.stopPropagation(); setRecentUploads(removeRecentUpload(u.sessionId)); })}
              </div>
            </div>
          );

          // ── A finished batch: same card shape as a single (uniform icon + height),
          //    a "N completed · M failed" line, View details + Download + remove ──
          const completedBatchBar = (batchId: string, label: string, uploads: RecentUpload[], timestamp: number) => {
            // Two batches of the same size read alike, so the row carries the model
            // (when every scan used one) and how long ago it finished, as a single does.
            const model = uploads.every((u) => u.model === uploads[0].model) ? uploads[0].model : "";
            const done = uploads.filter(u => u.status === "Completed").length;
            const failed = uploads.filter(u => u.status === "Failed").length;
            const cancelled = uploads.filter(u => u.status === "Cancelled").length;
            return (
              <div key={batchId} className="upload-row upload-row--card">
                <div className="upload-row__main">
                  {batchIcon}
                  <div className="upload-row__text">
                    <div className="upload-row__title">{label}</div>
                    {/* The dot between two facts is drawn by the part it leads and
                        clipped where a part starts a wrapped line, so no line of a
                        narrow row starts or ends with one. */}
                    <div className="upload-row__meta upload-row__meta--parts">
                      <span className="upload-row__parts">
                        {[
                          { key: "done", text: `${done} completed` },
                          model && { key: "model", text: model },
                          failed > 0 && { key: "failed", text: `${failed} failed`, className: "upload-row__failed" },
                          cancelled > 0 && { key: "cancelled", text: `${cancelled} cancelled`, className: "upload-row__cancelled" },
                          { key: "age", text: formatRelativeTime(timestamp) },
                        ].filter((part): part is { key: string; text: string; className?: string } => Boolean(part)).map((part, i) => (
                          <Fragment key={part.key}>
                            {/* Flex drops the space, but it keeps the facts apart for a
                                screen reader and for copied text. */}
                            {i > 0 && " "}
                            <span className={`upload-row__part${part.className ? ` ${part.className}` : ""}`}>{part.text}</span>
                          </Fragment>
                        ))}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="upload-row__actions">
                  <button type="button" className="upload-small-btn" aria-label={`View details for ${batchNames.get(batchId) ?? label}`} onClick={() => { track("upload_open_batch_details"); setDetailsBatchId(batchId); }}>View details</button>
                  <button type="button" className="upload-small-btn" aria-label={`Download ${batchNames.get(batchId) ?? label}`} disabled={done === 0} aria-busy={busyDownloads.includes(batchId) || undefined} style={busyDownloads.includes(batchId) ? { opacity: 0.6, cursor: "progress" } : undefined} onClick={() => downloadFromList(batchId, (say) => downloadBatch(uploads, say))}>Download</button>
                  {removeButton(batchNames.get(batchId) ?? label, batchId, () => removeBatch(uploads))}
                </div>
              </div>
            );
          };

          // ── Model comparison: one info card per model, always shown, so the
          // models can be weighed against each other. Clicking a card selects
          // it (the pipeline dropdown does the same, and neither asks a guest
          // to sign in: picking a model sends nothing, and Run still does);
          // the selected card is outlined + badged. The section stays put - it
          // doesn't collapse or rearrange based on what's been picked. ──
          const pickModelFromCard = (id: string) => {
            const opt = MODEL_OPTIONS.find((m) => m.id === id);
            if (modelLocked(id)) {
              setUpgradeBlock({ reason: "model_locked", feature: opt?.label ?? id, plan: plan as PlanId });
              return;
            }
            track("upload_select_model");
            chooseModel(id as typeof selectedModel);
          };
          const currentModelId = selectedModel === "" ? "None" : selectedModel;
          // "None" (view-only, no inference) is a real dropdown option but isn't
          // a model to compare against the other three, so it's left out of the
          // comparison grid.
          const cardModels = MODEL_OPTIONS.filter((m) => m.id !== "None");
          // A radio group is one tab stop: the checked card, or the first one
          // while none is (model "None"). Arrow keys move between cards and
          // select, as radios do; a locked card only takes focus, so arrowing
          // past it doesn't throw up the upgrade dialog (Enter or Space on it
          // explains the lock).
          const tabStopId = cardModels.some((m) => m.id === currentModelId)
            ? currentModelId
            : cardModels[0]?.id;
          const onCardKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, index: number) => {
            const last = cardModels.length - 1;
            let next: number | null = null;
            if (e.key === "ArrowRight" || e.key === "ArrowDown") next = index === last ? 0 : index + 1;
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = index === 0 ? last : index - 1;
            else if (e.key === "Home") next = 0;
            else if (e.key === "End") next = last;
            if (next !== null) {
              e.preventDefault();
              modelCardRefs.current[next]?.focus();
              const target = cardModels[next];
              if (!modelLocked(target.id)) pickModelFromCard(target.id);
              return;
            }
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              pickModelFromCard(cardModels[index].id);
            }
          };
          const modelCards = cardModels.map((m, index) => {
            const isCurrent = currentModelId === m.id;
            const locked = modelLocked(m.id);
            const idBase = `upload-model-${m.id}`;
            return (
              <div
                key={m.id}
                ref={(el) => { modelCardRefs.current[index] = el; }}
                role="radio"
                aria-checked={isCurrent}
                aria-labelledby={`${idBase}-name`}
                aria-describedby={`${idBase}-desc${locked ? ` ${idBase}-lock` : ""}`}
                tabIndex={m.id === tabStopId ? 0 : -1}
                className={`model-card${isCurrent ? " model-card--current" : ""}`}
                onClick={() => pickModelFromCard(m.id)}
                onKeyDown={(e) => onCardKeyDown(e, index)}
              >
                <div className="model-card-icon" aria-hidden="true">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2h5l.5 4.5 3.5 2-1 5-3 2.5-.5 4.5h-5l-.5-4.5-3-2.5-1-5 3.5-2z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                </div>

                <div id={`${idBase}-name`} className="model-card-name">
                  {m.label}
                </div>
                <div className="model-card-badges">
                  {isCurrent && <span className="model-card-badge">Selected</span>}
                  {locked && <span id={`${idBase}-lock`} className="model-card-badge model-card-badge--lock">Donate</span>}
                </div>

                <div id={`${idBase}-desc`} className="model-card-desc">
                  {m.desc}
                </div>

                {/* Looks like a button, but the whole card is the control: a
                    real button nested inside a radio would be a second,
                    unreachable control. */}
                <span className="model-card-cta" aria-hidden="true">
                  {isCurrent ? "Currently selected" : locked ? "Donate to unlock" : "Select this model"}
                </span>

                <div className="model-card-rule" />

                <div className="model-card-facts">
                  {m.quickFacts && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
                      {m.quickFacts.map((f) => (
                        <div key={f.label}>
                          <div className="model-card-fact-value">{f.value}</div>
                          <div className="model-card-fact-label">{f.label}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="model-card-rule model-card-rule--lower" />

                <div className="model-card-details">
                  {m.details && (
                    <ul>
                      {m.details.map((line, i) => (
                        <li key={i}>
                          <span aria-hidden="true">·</span>
                          {line}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            );
          });

          return (
            <>
              <section className="upload-section" aria-labelledby="upload-models-title">
                <h2 id="upload-models-title" className="upload-section-title">Choose a model</h2>
                <p className="upload-section-hint">
                  Compare what each model does and click one to pick it, or use the Model dropdown above.
                </p>
                <div role="radiogroup" aria-labelledby="upload-models-title" className="model-cards">
                  {modelCards}
                </div>
              </section>

              {finished.length > 0 && (
                <section className="upload-section" aria-labelledby="upload-completed-title">
                  <h2 id="upload-completed-title" className="upload-section-title">Completed uploads</h2>
                  <p className="upload-section-hint upload-section-hint--tight">
                    Scans waiting for you to look at them. Once viewed, they move to History.
                  </p>
                  {/* Where a row's Download reports: Preparing, started, or what went wrong. */}
                  <div role="status">
                    {listNote && <div className="status-msg" style={{ marginTop: 0, marginBottom: 12 }}>{listNote}</div>}
                  </div>
                  <div className="upload-rows">
                    {finished.map(g =>
                      g.kind === "single"
                        ? completedCard(g.upload)
                        : completedBatchBar(g.batchId, g.label, g.uploads, g.timestamp)
                    )}
                  </div>
                </section>
              )}

              {older.length > 0 && (
                <button type="button" className="upload-history-link"
                  onClick={() => navigate("/account/history")}
                  style={{ marginTop: finished.length > 0 ? undefined : "32px" }}>
                  {olderScans} {olderScans === 1 ? "scan" : "scans"} in History →
                </button>
              )}
            </>
          );
        })()}

        <UpgradeDialog block={upgradeBlock} onClose={() => setUpgradeBlock(null)} />

        {/* Batch "View details" popup */}
        {(() => {
          if (!detailsBatchId) return null;
          const uploads = ownRecentUploads.filter(u => u.batchId === detailsBatchId);
          if (uploads.length === 0) return null;
          const label = uploads[0].batchLabel || `${uploads.length} scans`;
          return (
            <BatchDetailsModal
              label={label}
              uploads={uploads}
              onClose={() => setDetailsBatchId(null)}
              note={detailsNote}
              restoreFocusRef={pageHeadingRef}
              onView={(u) => {
                if (!u.viewed) setRecentUploads(markRecentUploadViewed(u.sessionId));
                navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${u.sessionId}`);
              }}
              busyDownloads={busyDownloads}
              batchId={detailsBatchId}
              onDownloadScan={(u) => downloadFromList(u.sessionId, () => downloadResult(u.sessionId, sayInDetails()))}
              onDownloadAll={() => downloadFromList(detailsBatchId, () => downloadBatch(uploads, sayInDetails()))}
            />
          );
        })()}
      </main>
      <SiteFooter />
    </div>
  );
};

export default UploadPage;
