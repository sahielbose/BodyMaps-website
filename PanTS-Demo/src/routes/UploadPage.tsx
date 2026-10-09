import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
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
  groupUploads,
  isGroupInFlight,
  loadRecentUploads,
  recentStatusColor,
  removeRecentUpload,
  splitByAge,
  updateRecentUploadStatus,
  type RecentUpload,
} from "../helpers/recentUploads";
import Header from "../components/Header";
import ProcessingSummaryBar from "../components/ProcessingSummaryBar";
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
import { looksLikeDicom, setLocalDicomFiles } from "../helpers/dicomLocal";
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
import SiteFooter from "../components/SiteFooter";

const parseApiResponse = async (res: Response): Promise<any> => {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  const text = await res.text();
  const shortBody = text.slice(0, 200).replace(/\s+/g, " ").trim();
  throw new Error(
    `Expected JSON but got ${contentType || "unknown content-type"} (HTTP ${res.status}). Body: ${shortBody}`,
  );
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

const UploadPage: React.FC = () => {
  const navigate = useNavigate();
  // Running inference requires an account, so any upload action while signed
  // out opens the auth popup instead of proceeding. It opens on sign-in: most
  // people hitting this already have an account, and the popup switches to
  // sign-up in one click for the ones who don't.
  const { isAuthenticated, promptAuth, user, refreshUsage, redeemAdminCoupon } = useAuth();
  const ensureAccount = (): boolean => {
    if (isAuthenticated) return true;
    promptAuth();
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
  // Whether the current foreground upload got stored in IndexedDB (resumable).
  // If IDB was unavailable we fall back to warning before an unload instead.
  const uploadResumableRef = useRef<boolean>(false);
  // AbortController per session so a mid-upload run can be cancelled cleanly.
  const uploadAbortRef = useRef<Map<string, AbortController>>(new Map());
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
  const uploadRemainingRef = useRef<Map<string, number>>(new Map());
  // Monotonic count of bytes actually put on the wire; the ticker below diffs
  // it to measure throughput.
  const bytesSentRef = useRef(0);
  // Background uploads started the moment a file is selected, keyed by the
  // selected item's id (not its session id, since Run hasn't created one of
  // those yet when this starts). Not IndexedDB-resumable: a reload drops
  // selectedItems entirely (it was never persisted), so there's nothing to
  // resume - the upload just restarts next time the file is picked.
  const itemUploadRef = useRef<
    Map<string, { sid: string; uploadDone: Promise<string | null> }>
  >(new Map());

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
  // Inline rename of a scan in the history list: which one is being edited and
  // the working text.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const startRename = (u: RecentUpload) => {
    setRenamingId(u.sessionId);
    setRenameValue(u.label);
  };
  const commitRename = () => {
    if (renamingId) setRecentUploads(renameRecentUpload(renamingId, renameValue));
    setRenamingId(null);
  };
  // Which batch's "View details" popup is open (null = none).
  const [detailsBatchId, setDetailsBatchId] = useState<string | null>(null);
  // Sub-state of each Active card: "waiting" | "uploading" | "queued" | "running".
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
  // inference time and shouldn't count against the estimate. A plain ref, not
  // state: it's read once a second by the ticking clock below rather than
  // needing its own re-render.
  const runningStartedAtRef = useRef<Map<string, number>>(new Map());
  // File size per in-flight session, for the ETA formula's size scaling and
  // for asking the server for a real historical estimate (see
  // fetchDurationEstimate) - a plain ref since it's write-once at run start
  // and only ever read by the ETA display, no re-render needed on its own.
  const sessionFileSizeRef = useRef<Map<string, number>>(new Map());
  // Re-renders ProcessingCard once a second while anything is running, purely
  // so the "~N min left" text advances - nothing else here depends on it.
  // Gated on there actually being a running scan: an unconditional 1s re-render
  // of the whole page while idle is wasted work, and it kept the dropzone in a
  // constant reflow (see the transition note in UploadPage.css).
  const [, setEtaTick] = useState(0);
  const anyRunning = recentUploads.some((u) => u.status === "Processing");
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setEtaTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, plan]);
  // Drives the "safe to close this tab" line. `active` = bytes still going up
  // (the tab is needed); `eta` = seconds until that stops, or null while
  // throughput is still being measured.
  const [closeInfo, setCloseInfo] = useState<{
    active: boolean;
    eta: number | null;
  }>({ active: false, eta: null });

  // Queue a file's upload behind whatever is already uploading.
  const enqueueUpload = (task: () => Promise<void>): void => {
    uploadChainRef.current = uploadChainRef.current
      .catch(() => {})
      .then(task)
      .catch(() => {});
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
      alert("Please select .nii or .nii.gz files only");
      return;
    }
    track("upload_files_selected");
    setSelectedItems((prev) => [
      ...prev,
      ...filteredFiles.map((f) => ({
        id: crypto.randomUUID(),
        kind: "nifti" as const,
        file: f,
      })),
    ]);
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    // Inlined (not via ensureAccount) so the memoized closure sees fresh auth.
    if (!isAuthenticated) { promptAuth(); return; }
    if (!e.dataTransfer.files) return;
    const filteredFiles = Array.from(e.dataTransfer.files).filter((file) =>
      allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
    if (filteredFiles.length === 0) {
      alert("Please drop .nii or .nii.gz files only");
      return;
    }
    track("upload_files_selected");
    setSelectedItems((prev) => [
      ...prev,
      ...filteredFiles.map((f) => ({
        id: crypto.randomUUID(),
        kind: "nifti" as const,
        file: f,
      })),
    ]);
  }, [isAuthenticated, promptAuth]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const removeItem = (id: string) => {
    const pre = itemUploadRef.current.get(id);
    if (pre) {
      uploadAbortRef.current.get(pre.sid)?.abort();
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
  };

  // Treat folder and manual multi-file selection identically after the browser
  // gives us File objects. Folder support differs among browsers, but the upload
  // pipeline itself must not.
  const addDicomFiles = (files: File[]) => {
    const candidates = files.filter(looksLikeDicom);
    if (!candidates.length) {
      alert(
        "No DICOM files found. Pick the folder holding the .dcm slices — or, on a phone or tablet (where folders can't be picked), select the slice files themselves.",
      );
      return;
    }
    setSelectedItems((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "dicom",
        files: candidates,
        label: `DICOM series (${candidates.length} slices)`,
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
        addDicomFiles(await readDirectoryFiles(directory));
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
    addDicomFiles(files);
  };

  /* ── Inference polling (one timer per session) ── */
  const stopPolling = (sid: string) => {
    const timer = pollTimersRef.current.get(sid);
    if (timer !== undefined) {
      clearTimeout(timer);
      pollTimersRef.current.delete(sid);
    }
    pollGenerationRef.current.delete(sid);
  };

  const stopAllPolling = () => {
    pollTimersRef.current.forEach((timer) => clearTimeout(timer));
    pollTimersRef.current.clear();
    pollGenerationRef.current.clear();
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

  const startInferencePolling = (sid: string, model: string) => {
    stopPolling(sid);
    const generation = Symbol(sid);
    pollGenerationRef.current.set(sid, generation);
    let notFoundCount = 0;
    const poll = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/inference-status/${sid}`, {
          credentials: "include",
        });
        const data = await parseApiResponse(res);
        const status = (data.status || "").toLowerCase();

        // The server doesn't know this session: the upload never finished
        // (tab closed mid-upload) or the backend restarted and lost its
        // in-memory job table. A few consecutive hits = gone, not a blip.
        if (status === "not_found") {
          notFoundCount += 1;
          if (notFoundCount >= 3) {
            stopPolling(sid);
            setPhase(sid);
            setQueuePosition(sid);
            clearEtaTracking(sid);
            setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
            setMessage(
              "Session no longer exists on the server - marked as Failed.",
            );
          }
          return;
        }
        notFoundCount = 0;

        if (!res.ok)
          throw new Error(data.error || data.status || "Status check failed");

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
          setMessage(`Inference failed${data.error ? `: ${data.error}` : ""}`);
        } else if (status === "cancelled") {
          // Cancelled elsewhere (another tab, or the backend) - reflect it.
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          clearEtaTracking(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        } else if (status === "queued" || status === "running") {
          if (status === "running" && !runningStartedAtRef.current.has(sid)) {
            runningStartedAtRef.current.set(sid, Date.now());
            fetchDurationEstimate(sid, model, sessionFileSizeRef.current.get(sid));
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

    const controller = uploadAbortRef.current.get(sid);
    if (controller) controller.abort();
    deletePendingUpload(sid);

    // Fire-and-forget: if the job never reached the server (upload phase)
    // this 404s, which is fine - the client side is already torn down.
    fetch(`${API_BASE}/api/cancel-inference/${sid}`, {
      method: "POST",
      credentials: "include",
    }).catch(
      () => {},
    );

    if (foregroundUploadSidRef.current === sid) {
      foregroundUploadSidRef.current = null;
      setIsUploading(false);
    }
    setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
    setMessage(`Cancelled ${upload.label}`);
  };

  useEffect(() => {
    // Resume every in-flight run - there can be several in parallel. Uploads
    // that were still mid-transfer live in IndexedDB and must be *resumed*
    // (not polled - the server has no job for them yet); the rest are already
    // inferencing server-side, so we reconnect their pollers.
    let cancelled = false;
    (async () => {
      const processing = loadRecentUploads().filter(
        (u) => u.status === "Processing",
      );
      const pending = await loadPendingUploads();
      if (cancelled) return;
      const pendingById = new Map(pending.map((p) => [p.sessionId, p]));

      for (const u of processing) {
        const p = pendingById.get(u.sessionId);
        if (p?.uploadedFilename) {
          // Fully uploaded, but the tab closed before its job was created. The
          // file is already on the server - just replay the inference call. Not
          // queued behind the resuming uploads: it costs one POST and getting it
          // into the GPU queue now is the whole point.
          dispatchInference(p.sessionId, p.model, p.uploadedFilename, false);
        } else if (p) {
          setPhase(u.sessionId, "waiting");
          uploadRemainingRef.current.set(p.sessionId, p.file.size);
          enqueueUpload(() => runUpload(p, false)); // resume the upload
        } else {
          startInferencePolling(u.sessionId, u.model); // resume polling
        }
      }

      // Clean up IndexedDB entries whose card no longer exists (deleted or
      // trimmed off the 8-entry list) so the store can't leak.
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
      stopAllPolling();
    };
  }, []);

  // Only warn before an unload if the current upload could NOT be stored in
  // IndexedDB (quota/private-mode) - otherwise an interrupted upload resumes
  // automatically on reopen, so no scary dialog is needed.
  useEffect(() => {
    if (!isUploading || uploadResumableRef.current) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isUploading]);

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
      setCloseInfo({
        active,
        // Below ~1 KB/s the estimate is noise (or the connection stalled) -
        // show "uploading" with no number rather than an absurd one.
        eta: active && rate > 1024 ? Math.max(1, Math.round(remaining / rate)) : null,
      });
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
  ) => {
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
      if (!res.ok) throw new Error(data.error || "Failed to start inference");

      // Queued server-side now - nothing here is needed to finish the run, so
      // drop the resumable record.
      await deletePendingUpload(sid);
      refreshUsage(); // a scan was just spent; keep the settings counter honest
      setSessionId(sid);
      setPhase(sid, "queued"); // server queues for the GPU; poll refines this
      // No status-line message here: the processing card below already shows
      // "Running..." for this session, so a raw-UUID line would just duplicate it.
      if (foreground) setMessage("");
      startInferencePolling(sid, model);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error(err);
      setPhase(sid);
      await deletePendingUpload(sid);
      setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
      // The card already shows "Failed" — don't duplicate it in the status line.
      if (foreground) setMessage("");
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
  ): Promise<string | null> => {
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
          throw new Error(
            "Upload chunk too large for server/proxy limit (HTTP 413).",
          );
        const data = await parseApiResponse(res);
        if (!res.ok) throw new Error(data.error || "Chunk upload failed");
        bytesSentRef.current += chunk.size;
        uploadRemainingRef.current.set(
          sid,
          Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - chunk.size),
        );
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
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok) throw new Error(finalizeData.error);
      return finalizeData.uploaded_filename || file.name;
    } catch (err) {
      if (controller.signal.aborted) return null;
      console.error("Background upload failed:", err);
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
    enqueueUpload(async () => {
      const uploadedName = await preUploadOnly(sid, file, (pct) => {
        setItemUploadProgress((prev) => ({ ...prev, [item.id]: pct }));
      });
      setItemUploadStatus((prev) => ({
        ...prev,
        [item.id]: uploadedName ? "done" : "failed",
      }));
      resolveDone(uploadedName);
    });
  };

  // Start uploading every selected NIfTI file the instant it's selected -
  // before a model is even picked. preStartUpload is idempotent per item id,
  // so this can safely re-run on every render where any dependency changed;
  // it only does real work the first time a given item appears. A file
  // picked while model is still "None" uploads anyway: if the user then
  // picks a real model, dispatchInference already has the bytes waiting and
  // Run is instant. The rare case where they truly stay on "None" (view
  // only, never run inference) just means the pre-upload was unused - cheap
  // compared to the latency saved on every run that DOES follow.
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
    if (!isAuthenticated) return;
    const slots = maxConcurrentScans(plan as PlanId);
    const running = recentUploads.filter((u) => u.status === "Processing").length;
    if (selectedItems.length + running > slots) return;
    selectedItems.forEach(preStartUpload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, selectedItems, plan, recentUploads]);

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
          throw new Error(
            "Upload chunk too large for server/proxy limit (HTTP 413).",
          );
        const data = await parseApiResponse(res);
        if (!res.ok) throw new Error(data.error || "Chunk upload failed");

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
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok) throw new Error(finalizeData.error);
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
      // and set the card to Cancelled, so don't overwrite that with Failed.
      if (controller.signal.aborted) return;
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
      await deletePendingUpload(sid);
      setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
      // The card already shows "Failed" — don't duplicate it in the status line.
      if (foreground) setMessage("");
    } finally {
      // Whatever happened, this file is no longer contributing bytes - drop it
      // so a cancel/failure can't leave its unsent bytes inflating the estimate.
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

  // DICOM folder → inference. Uploads each raw slice, asks the server to convert
  // the series to NIfTI (SimpleITK), then hands off to the same inference + polling
  // flow as a NIfTI run. Not IndexedDB-resumable (a folder is many files); a reload
  // mid-upload marks the run Failed, consistent with the Active/Recent cards. Wired
  // into uploadAbortRef so the Active card's Cancel button aborts it cleanly.
  const runDicomUpload = async (sid: string, files: File[], model: string) => {
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
          throw new Error(
            "DICOM slice too large for server/proxy limit (HTTP 413).",
          );
        const data = await parseApiResponse(res);
        if (!res.ok) throw new Error(data.error || "DICOM slice upload failed");
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
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok)
        throw new Error(finalizeData.error || "DICOM conversion failed");
      const uploadedName = finalizeData.uploaded_filename || "ct.nii.gz";

      foregroundUploadSidRef.current = null;
      setIsUploading(false);

      await dispatchInference(sid, model, uploadedName, true);
    } catch (err) {
      // A user cancel aborts our fetches - cancelRun already set the card to
      // Cancelled, so don't overwrite that with Failed.
      if (controller.signal.aborted) return;
      console.error(err);
      setPhase(sid);
      foregroundUploadSidRef.current = null;
      setIsUploading(false);
      setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
      const reason = err instanceof Error ? err.message : "Unknown upload error";
      setMessage(`DICOM upload failed: ${reason}`);
    } finally {
      uploadRemainingRef.current.delete(sid);
      if (uploadAbortRef.current.get(sid) === controller) {
        uploadAbortRef.current.delete(sid);
      }
    }
  };

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
      }),
    );

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
      (async () => {
        const uploadedName = await pre.uploadDone;
        if (!uploadedName) {
          setPhase(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
          return;
        }
        await dispatchInference(sid, model, uploadedName, false);
      })();
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
      enqueueUpload(() => runDicomUpload(sid, item.files, model));
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
    enqueueUpload(() => {
      // Set when this file actually starts, not when it was queued - otherwise
      // the last file in a batch would decide the unload warning for all of them.
      uploadResumableRef.current = resumable;
      return runUpload(pending, true);
    });
  };

  const handleRunEpaiInference = async () => {
    if (!ensureAccount()) return;
    const items = selectedItems;
    const first = items[0] ?? null;

    // "None" model = view only: open the scan in its full local viewer, nothing is
    // uploaded or run. DICOM opens the /dicom viewer, NIfTI the /local-nifti viewer.
    if (selectedModel === "None") {
      if (!first) { alert("Select a scan to view first."); return; }
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
      alert("Select a file to upload first.");
      return;
    }

    // Caught here rather than per-file, so a plan that runs one scan at a time
    // says so before anything uploads instead of accepting the first and
    // rejecting the rest one 402 at a time.
    const slots = maxConcurrentScans(plan as PlanId);
    const running = recentUploads.filter((u) => u.status === "Processing").length;
    if (items.length + running > slots) {
      setUpgradeBlock({
        reason: "concurrent_scans", limit: slots, used: running, plan: plan as PlanId,
      });
      return;
    }

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
    // as soon as its own upload finishes.
    setSelectedItems([]);
    for (const item of items) {
      await startScanRun(item, model, batch);
    }
  };

  // Download one completed scan's result zip. Parameterised so it works from a
  // completed card and from inside the batch-details modal.
  const downloadResult = async (sid: string) => {
    setMessage("Preparing download...");
    try {
      const statusRes = await fetch(`${API_BASE}/api/inference-status/${sid}`, {
        credentials: "include",
      });
      const statusData = await parseApiResponse(statusRes);
      if (!statusRes.ok)
        throw new Error(
          statusData.error || statusData.status || "Status check failed",
        );
      if (statusData.status !== "completed") {
        setMessage(
          `Status: ${statusData.status || "unknown"}. Please wait until completed.`,
        );
        return;
      }
      stopPolling(sid);

      const resultRes = await fetch(`${API_BASE}/api/get_result/${sid}`, {
        credentials: "include",
      });
      if (!resultRes.ok) {
        const maybeJson = await parseApiResponse(resultRes);
        throw new Error(maybeJson?.error || "Failed to download result zip");
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
      setMessage(
        "Download started: zip includes combined_labels.nii.gz and output.csv",
      );
    } catch (err) {
      console.error(err);
      setMessage("Download failed: " + (err as Error).message);
    }
  };

  // Download a whole batch as one archive. In this mock there's no server-side
  // bundling endpoint yet, so it surfaces intent; wire to a real batch-zip
  // endpoint when the backend supports it.
  const downloadBatch = (uploads: RecentUpload[]) => {
    const completed = uploads.filter(u => u.status === "Completed");
    if (completed.length === 0) { setMessage("No completed scans to download yet."); return; }
    setMessage(`Downloading ${completed.length} scan${completed.length === 1 ? "" : "s"} as a batch…`);
  };

  const handleRunEpaiOnReconstruction = async () => {
    if (!sessionId) {
      alert("No completed reconstruction session to run ePAI on.");
      return;
    }
    const newSessionId = crypto.randomUUID();
    setInferenceCompleted(false);
    setMessage("Starting ePAI inference on reconstructed CT...");

    const formData = new FormData();
    formData.append("session_id", newSessionId);
    formData.append("model_name", "ePAI");
    formData.append("source_reconstruction_session_id", sessionId);

    try {
      const res = await fetch(`${API_BASE}/api/run-epai-inference`, {
        method: "POST",
        body: formData,
      });
      const data = await parseApiResponse(res);
      if (!res.ok)
        throw new Error(
          data.error || "Failed to start ePAI inference on reconstruction",
        );

      const sid = data.session_id || newSessionId;
      setSessionId(sid);
      setSelectedModel("ePAI" as const);
      setMessage(`ePAI inference started on reconstructed CT. Session: ${sid}`);
      if (sid) {
        setRecentUploads(
          addRecentUpload({
            sessionId: sid,
            label: "ePAI on reconstruction",
            model: "ePAI",
            status: "Processing",
            timestamp: Date.now(),
          }),
        );
        startInferencePolling(sid, "ePAI");
      }
    } catch (err) {
      console.error(err);
      setMessage(
        "Failed to start ePAI on reconstruction: " + (err as Error).message,
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
  const groups = groupUploads(recentUploads);
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
  const singleCompletedVisible =
    inferenceCompleted &&
    !!sessionId &&
    !recentUploads.find((u) => u.sessionId === sessionId)?.batchId;

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

  // ── A single in-flight scan (not part of a batch) ──
  const ProcessingCard = ({ u }: { u: RecentUpload }) => {
    const phase = sessionPhases[u.sessionId];
    const queuePos = queuePositions[u.sessionId];
    const phaseLabel =
      phase === "waiting" ? "Waiting to upload…" :
      phase === "uploading" ? "Uploading…" :
      phase === "queued" ? (queuePos ? `#${queuePos} in queue` : "Queued for GPU") :
      "Running…";
    return (
      <div style={{
        background: "#f5f5f5", border: "1px solid rgba(0, 45, 114, 0.14)", borderRadius: "12px",
        padding: "16px 20px", display: "flex", flexDirection: "column", gap: "12px",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <div style={{
              width: "36px", height: "36px", borderRadius: "8px", flexShrink: 0,
              background: "rgba(0, 45, 114, 0.04)", border: "1px solid rgba(0, 45, 114, 0.12)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>{/* A static pulsing dot per scan instead of a spinning wheel:
                 multiple in-flight scans shouldn't each spin. The single
                 spinner lives in the batch ProcessingSummaryBar. */}
              <span className="animate-pulse" style={{ width: 8, height: 8, borderRadius: "50%", background: "#002d72", display: "block" }} />
            </div>
            <div>
              <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "14px", fontWeight: 600, color: "#111111" }}>{u.label}</div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#6a6a6a", marginTop: "2px" }}>
                {u.model ? `${u.model} · ` : ""}{formatRelativeTime(u.timestamp)}
                <span className={`proc-close-note${closeInfo.active ? "" : " proc-close-note--ready"}`}>
                  {" "}· {closeNote}
                </span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "12px", fontWeight: 500, color: phase === "queued" ? "#6a6a6a" : "#002d72" }}>{phaseLabel}</span>
            <button className="active-cancel-btn" onClick={() => cancelRun(u)}>Cancel</button>
          </div>
        </div>
        {/* No real percent-complete exists for inference (nnU-Net doesn't
            report progress mid-run), so instead of an indeterminate sweep
            that told the user nothing, this shows how long the run has
            left based on how this model's runs typically take. Only shown
            once actually running: during "queued" there's no dispatch-time
            signal to build an estimate from. */}
        {phase === "running" && (
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#6a6a6a" }}>
            {estimateRemaining(
              u.model || "",
              runningStartedAtRef.current.get(u.sessionId) ?? Date.now(),
              sessionFileSizeRef.current.get(u.sessionId),
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
        if (g.kind === "single") return <ProcessingCard key={g.upload.sessionId} u={g.upload} />;
        const running = g.uploads.filter(u => u.status === "Processing");
        const done = g.uploads.filter(u => u.status === "Completed").length;
        const phases = running.map(u => sessionPhases[u.sessionId]);
        const statusLabel =
          phases.some(p => p === undefined || p === "running") ? "Running…" :
          phases.some(p => p === "queued") ? "Queued for GPU" : "Uploading…";
        return (
          <ProcessingSummaryBar key={g.batchId} title={g.label} running={running.length}
            done={done} statusLabel={statusLabel}
            closeNote={closeNote} closeReady={!closeInfo.active}
            onViewDetails={() => { track("upload_open_batch_details"); setDetailsBatchId(g.batchId); }}
            onCancelAll={() => running.forEach(u => cancelRun(u))} />
        );
      })}
    </div>
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
        {selectedModel === "OpenVAE" ? (
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
            <button className="result-btn" onClick={() => downloadResult(sessionId)}>
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
            <button className="result-btn" onClick={() => downloadResult(sessionId)}>
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
        running={0}
        done={activeBatchCompleted.uploads.filter((u) => u.status === "Completed").length}
        statusLabel={
          activeBatchCompleted.uploads.every((u) => u.status === "Completed")
            ? "Inference complete"
            : `Completed - ${activeBatchCompleted.uploads.filter((u) => u.status === "Failed" || u.status === "Cancelled").length} failed`
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

      <div className="upload-main">
        <div className="upload-card">
          {/* ── Drop zone ── */}
          <div
            className={`dropzone${isDragOver ? " drag-over" : ""}${allUploadsDone ? " dropzone--all-done" : ""}`}
            onClick={() => {
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
            {selectedItems.length === 0 && inFlight.length > 0 ? (
              // A run is already going - this box stays the single place to
              // watch it instead of reverting to the empty picker while a
              // separate card appears elsewhere on the page.
              inFlightCards
            ) : selectedItems.length === 0 && singleCompletedVisible ? (
              // The run that WAS showing progress in this box just finished -
              // it keeps the same slot rather than the box going empty while a
              // result panel pops up elsewhere.
              singleCompletedCard
            ) : selectedItems.length === 0 && activeBatchCompleted ? (
              batchCompletedCard
            ) : selectedItems.length === 0 ? (
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
                  const subtext =
                    item.kind === "dicom"
                      ? `DICOM series · ${item.files.length} slice${item.files.length === 1 ? "" : "s"}`
                      : `NIfTI · ${formatBytes(item.file.size)}`;
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
                            {subtext}
                            {uploadStatus === "uploading" && ` · uploading ${uploadPct}%`}
                            {uploadStatus === "done" && " · ready"}
                            {uploadStatus === "failed" && " · upload failed"}
                          </span>
                        </span>
                        <button
                          className="file-chip-preview"
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
                        >
                          ×
                        </button>
                      </div>
                      {uploadStatus === "uploading" && (
                        <div className="file-chip-progress-track">
                          <div
                            className="file-chip-progress-fill"
                            style={{ width: `${uploadPct}%` }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
              <button
                type="button"
                className="dropzone-btn"
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

          {/* ── Pre-inference preview: inspect the selected scan before running a model ── */}
          {previewItem && !isUploading && (
            <>
              <div className="ct-preview-label">
                Preview ·{" "}
                {previewItem.kind === "dicom"
                  ? previewItem.label
                  : previewItem.file.name}
              </div>
              <Suspense
                fallback={
                  <div className="ct-preview ct-preview--msg">
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
                  modelTouchedRef.current = true;
                  setSelectedModel(id as typeof selectedModel);
                }}
                onSelectSub={(_itemId, lesionId) => {
                  modelTouchedRef.current = true;
                  setSelectedModel("LesionSegmenter");
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
              className="run-btn"
              onClick={handleRunEpaiInference}
              // Not gated on isUploading: that flag now also covers background
              // pre-uploads (started the moment a file is selected, before Run
              // is even clickable), and Run needs to stay clickable while one
              // is in flight - handleRunEpaiInference's own empty-selection
              // check is what prevents a double-submit, not this.
              disabled={!selectedModel}
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

          {/* ── Status messages (errors / transient feedback only) ── */}
          {message && <div className="status-msg">{message}</div>}
        </div>

        {/* ── Sign-in prompt (signed-out only) ── */}
        {!isAuthenticated && (
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

          const SectionLabel = ({ children }: { children: React.ReactNode }) => (
            <div style={{
              fontFamily: "'Space Grotesk', sans-serif", fontSize: "11px", fontWeight: 600,
              letterSpacing: "0.12em", textTransform: "uppercase", color: "#8f8f8f",
              marginBottom: "16px", paddingLeft: "4px",
            }}>{children}</div>
          );

          const RemoveBtn = ({ onClick }: { onClick: (e: React.MouseEvent) => void }) => (
            <button onClick={onClick} title="Remove" style={{
              background: "transparent", border: "none", padding: "4px", cursor: "pointer",
              color: "rgba(0,0,0,0.2)", lineHeight: 0, borderRadius: "4px", transition: "color 0.15s",
            }}
              onMouseEnter={e => (e.currentTarget.style.color = "#ef4444")}
              onMouseLeave={e => (e.currentTarget.style.color = "rgba(0,0,0,0.2)")}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
            </button>
          );

          // One shared icon container so single + batch entries line up identically.
          const iconBox = {
            width: "40px", height: "40px", borderRadius: "8px", flexShrink: 0,
            background: "rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.12)",
            display: "flex", alignItems: "center", justifyContent: "center",
          } as const;

          const FileIcon = () => (
            <div style={iconBox}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
          );

          // Batch: stacked-layers glyph in the identical container (no ✓ — misleading
          // when a batch has 0 completed).
          const BatchIcon = () => (
            <div style={iconBox}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 2 7 12 12 22 7 12 2" />
                <polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" />
              </svg>
            </div>
          );

          // Shared card wrapper — identical padding/min-height for single + batch.
          const cardWrap = {
            background: "#f5f5f5", border: "1px solid rgba(0,0,0,0.06)", borderRadius: "12px",
            padding: "14px 20px", minHeight: "72px", boxSizing: "border-box",
            display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px",
          } as const;

          const smallBtn = {
            background: "transparent", border: "1px solid rgba(0,0,0,0.1)", borderRadius: "6px",
            padding: "6px 12px", color: "#111111", fontFamily: "'Space Grotesk', sans-serif",
            fontSize: "11px", cursor: "pointer",
          } as const;

          // ProcessingCard is hoisted above (near the top of render) since the
          // dropzone now needs it too.

          // ── A finished individual scan: status, View, Download, remove ──
          const CompletedCard = ({ u }: { u: RecentUpload }) => (
            <div onClick={() => openSession(u)} style={{ ...cardWrap, cursor: canView(u) ? "pointer" : "default" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "16px", minWidth: 0 }}>
                <FileIcon />
                <div style={{ minWidth: 0 }}>
                  {renamingId === u.sessionId ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        else if (e.key === "Escape") setRenamingId(null);
                      }}
                      style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "14px", fontWeight: 600, color: "#111111", border: "1px solid rgba(0, 45, 114, 0.3)", borderRadius: "6px", padding: "2px 6px", width: "100%", maxWidth: "260px" }}
                    />
                  ) : (
                    // Click the name itself to rename it - no separate pencil
                    // icon needed (matches how Claude's own chat titles work).
                    // Underline-on-hover is the only affordance that this text
                    // is interactive; the tooltip keeps surfacing the original
                    // filename once it's been renamed away from it.
                    <span
                      title={u.sourceName || "Click to rename"}
                      onClick={(e) => { e.stopPropagation(); startRename(u); }}
                      className="upload-rename-trigger"
                      style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "14px", fontWeight: 600, color: "#111111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", cursor: "text", maxWidth: "260px" }}
                    >
                      {u.label}
                    </span>
                  )}
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#6a6a6a", marginTop: "2px" }}>
                    {u.model ? `${u.model} · ` : ""}{formatRelativeTime(u.timestamp)}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
                <span style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "12px", fontWeight: 500, color: recentStatusColor(u.status) }}>{u.status}</span>
                {canView(u) && <button style={smallBtn} onClick={(e) => { e.stopPropagation(); openSession(u); }}>View</button>}
                {u.status === "Completed" && <button style={smallBtn} onClick={(e) => { e.stopPropagation(); downloadResult(u.sessionId); }}>Download</button>}
                <RemoveBtn onClick={(e) => { e.stopPropagation(); setRecentUploads(removeRecentUpload(u.sessionId)); }} />
              </div>
            </div>
          );

          // ── A finished batch: same card shape as a single (uniform icon + height),
          //    a "N completed · M failed" line, View details + Download + remove ──
          const CompletedBatchBar = ({ batchId, label, uploads }: { batchId: string; label: string; uploads: RecentUpload[] }) => {
            const done = uploads.filter(u => u.status === "Completed").length;
            const failed = uploads.filter(u => u.status === "Failed" || u.status === "Cancelled").length;
            return (
              <div style={cardWrap}>
                <div style={{ display: "flex", alignItems: "center", gap: "16px", minWidth: 0 }}>
                  <BatchIcon />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "14px", fontWeight: 600, color: "#111111" }}>{label}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#6a6a6a", marginTop: "2px", display: "flex", alignItems: "center", gap: "6px" }}>
                      <span>{done} completed</span>
                      {failed > 0 && (
                        <>
                          <span style={{ color: "rgba(0,0,0,0.3)" }}>•</span>
                          <span style={{ color: "#ef4444" }}>{failed} failed</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
                  <button style={smallBtn} onClick={() => { track("upload_open_batch_details"); setDetailsBatchId(batchId); }}>View details</button>
                  <button style={{ ...smallBtn, background: "#002d72", color: "#fff", borderColor: "#002d72" }} onClick={() => downloadBatch(uploads)}>Download</button>
                  <RemoveBtn onClick={() => removeBatch(uploads)} />
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
            modelTouchedRef.current = true;
            setSelectedModel(id as typeof selectedModel);
          };
          const currentModelId = selectedModel === "" ? "None" : selectedModel;
          const modelBadge = (text: string, color: string) => (
            <span style={{
              fontFamily: "'Space Grotesk', sans-serif", fontSize: "9px", fontWeight: 700,
              letterSpacing: "0.08em", textTransform: "uppercase", color,
              border: `1px solid ${color}`, borderRadius: "4px", padding: "2px 5px", flexShrink: 0,
            }}>{text}</span>
          );
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
            return (
              <div
                key={m.id}
                ref={(el) => { modelCardRefs.current[index] = el; }}
                role="radio"
                aria-checked={isCurrent}
                aria-label={`Select the ${m.label} model`}
                tabIndex={m.id === tabStopId ? 0 : -1}
                onClick={() => pickModelFromCard(m.id)}
                onKeyDown={(e) => onCardKeyDown(e, index)}
                style={{
                  background: "#fff",
                  border: isCurrent ? "1.5px solid #002d72" : "1px solid rgba(0,0,0,0.08)",
                  boxShadow: isCurrent ? "0 6px 24px rgba(0,45,114,0.12)" : "0 1px 2px rgba(0,0,0,0.04)",
                  borderRadius: "18px", padding: "32px 28px",
                  // subgrid: each row below (icon, name, badge, desc, button,
                  // divider, stats, divider, bullets) shares its height with the
                  // same row in the other cards, sized to the tallest one - so a
                  // 3-line description in one card doesn't just push that card's
                  // own button down, it grows the desc row for every card and
                  // everything below stays aligned. The parent grid declares the
                  // 9 row tracks; grid-row: span 9 hands them all to this card.
                  display: "grid", gridTemplateRows: "subgrid", gridRow: "span 9", rowGap: 0,
                  cursor: "pointer", textAlign: "center", minWidth: 0, height: "100%",
                  transition: "border-color 0.15s, box-shadow 0.15s",
                }}
              >
                <div style={{
                  width: "48px", height: "48px", borderRadius: "12px", flexShrink: 0,
                  background: isCurrent ? "rgba(0,45,114,0.08)" : "rgba(0,0,0,0.05)",
                  border: `1px solid ${isCurrent ? "rgba(0,45,114,0.18)" : "rgba(0,0,0,0.1)"}`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  margin: "0 auto 20px",
                }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={isCurrent ? "#002d72" : "#111111"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2h5l.5 4.5 3.5 2-1 5-3 2.5-.5 4.5h-5l-.5-4.5-3-2.5-1-5 3.5-2z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                </div>

                <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "18px", fontWeight: 700, color: "#111111", alignSelf: "start" }}>
                  {m.label}
                </div>
                <div style={{ display: "flex", justifyContent: "center", alignItems: "start", gap: "6px", flexWrap: "wrap", marginTop: "8px" }}>
                  {isCurrent && modelBadge("Selected", "#002d72")}
                  {locked && modelBadge("Donate", "#8f6a00")}
                </div>

                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", color: "#6a6a6a", lineHeight: 1.6, marginTop: "14px", alignSelf: "start" }}>
                  {m.desc}
                </div>

                <button
                  type="button"
                  tabIndex={-1}
                  style={{
                    alignSelf: "start", marginTop: "24px", width: "100%", padding: "11px 16px", borderRadius: "999px",
                    fontFamily: "'Space Grotesk', sans-serif", fontSize: "13px", fontWeight: 600,
                    background: isCurrent ? "#002d72" : "#fff",
                    color: isCurrent ? "#fff" : "#002d72",
                    border: "1.5px solid #002d72", cursor: "pointer", pointerEvents: "none",
                  }}
                >
                  {isCurrent ? "Currently selected" : locked ? "Donate to unlock" : "Select this model"}
                </button>

                <div style={{ height: "1px", background: "rgba(0,0,0,0.08)", margin: "28px 0 0", alignSelf: "start", width: "100%" }} />

                <div style={{ alignSelf: "start", marginTop: "24px" }}>
                  {m.quickFacts && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "22px" }}>
                      {m.quickFacts.map((f) => (
                        <div key={f.label}>
                          <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "21px", fontWeight: 700, color: "#111111" }}>
                            {f.value}
                          </div>
                          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "10px", color: "#8f8f8f", marginTop: "4px" }}>
                            {f.label}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div style={{ height: "1px", background: "rgba(0,0,0,0.08)", margin: "24px 0 0", alignSelf: "start", width: "100%" }} />

                <div style={{ alignSelf: "start", marginTop: "20px" }}>
                  {m.details && (
                    <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "12px", textAlign: "left" }}>
                      {m.details.map((line, i) => (
                        <li key={i} style={{
                          fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", color: "#6a6a6a",
                          lineHeight: 1.5, paddingLeft: "14px", position: "relative",
                        }}>
                          <span style={{ position: "absolute", left: 0, color: "#002d72" }}>·</span>
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
              <div style={{ marginTop: "32px" }}>
                <SectionLabel>Choose a model</SectionLabel>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#8f8f8f", marginTop: "-8px", marginBottom: "20px" }}>
                  Compare what each model does and click one to pick it - or use the Model dropdown above.
                </div>
                <div
                  role="radiogroup"
                  aria-label="Segmentation model"
                  style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gridTemplateRows: "repeat(9, auto)", gap: "28px" }}
                >
                  {modelCards}
                </div>
              </div>


              {finished.length > 0 && (
                <div style={{ marginTop: "32px" }}>
                  <SectionLabel>Completed Uploads</SectionLabel>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#8f8f8f", marginTop: "-8px", marginBottom: "12px" }}>
                    Scans waiting for you to look at them - once viewed, they move to History.
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {finished.map(g =>
                      g.kind === "single"
                        ? <CompletedCard key={g.upload.sessionId} u={g.upload} />
                        : <CompletedBatchBar key={g.batchId} batchId={g.batchId} label={g.label} uploads={g.uploads} />
                    )}
                  </div>
                </div>
              )}

              {older.length > 0 && (
                <button type="button" className="upload-history-link"
                  onClick={() => navigate("/account/history")}
                  style={{ marginTop: finished.length > 0 ? undefined : "32px" }}>
                  {older.length} {older.length === 1 ? "scan" : "scans"} in History →
                </button>
              )}
            </>
          );
        })()}

        <UpgradeDialog block={upgradeBlock} onClose={() => setUpgradeBlock(null)} />

        {/* Batch "View details" popup */}
        {(() => {
          if (!detailsBatchId) return null;
          const uploads = recentUploads.filter(u => u.batchId === detailsBatchId);
          if (uploads.length === 0) return null;
          const label = uploads[0].batchLabel || `${uploads.length} scans`;
          return (
            <BatchDetailsModal
              label={label}
              uploads={uploads}
              onClose={() => setDetailsBatchId(null)}
              onView={(u) => {
                if (!u.viewed) setRecentUploads(markRecentUploadViewed(u.sessionId));
                navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${u.sessionId}`);
              }}
              onDownloadScan={(u) => downloadResult(u.sessionId)}
              onDownloadAll={() => downloadBatch(uploads)}
            />
          );
        })()}
      </div>
      <SiteFooter />
    </div>
  );
};

export default UploadPage;
