import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

// LesionSegmenter's four lesions, offered as a macOS-style submenu off the model
// item. Only pancreatic is GT-validated; the rest are flagged experimental.
const LESION_OPTIONS: {
  id: "pancreatic" | "liver" | "kidney" | "colon";
  label: string;
  experimental?: boolean;
}[] = [
  { id: "pancreatic", label: "Pancreatic lesion" },
  { id: "liver", label: "Liver lesion", experimental: true },
  { id: "kidney", label: "Kidney lesion", experimental: true },
  { id: "colon", label: "Colon lesion", experimental: true },
];

const MODEL_OPTIONS: { id: string; label: string; desc: string }[] = [
  {
    id: "None",
    label: "None",
    desc: "View only — files never leave your browser",
  },
  {
    id: "ePAI",
    label: "ePAI",
    desc: "For detailed pancreas and tumor analysis",
  },
  {
    id: "SuPreM",
    label: "SuPreM",
    desc: "For whole-body scans from lungs to legs",
  },
  {
    id: "MedFormer",
    label: "MedFormer",
    desc: "For reliable abdominal segmentation",
  },
  {
    id: "R-Super",
    label: "R-Super",
    desc: "For the highest tumor detection accuracy",
  },
  {
    id: "Atlas-Net",
    label: "Atlas-Net",
    desc: "For anatomically consistent results",
  },
  {
    id: "LesionSegmenter",
    label: "LesionSegmenter",
    desc: "For fast pancreatic lesion detection",
  },
];
import { useNavigate } from "react-router-dom";
import "./UploadPage.css";

// Lazy so NiiVue / Cornerstone aren't pulled into the upload bundle until a file
// is actually previewed. CtPreview handles NIfTI, DicomPreview handles a DICOM series.
const CtPreview = lazy(() => import("../components/CtPreview/CtPreview"));
const DicomPreview = lazy(() => import("../components/CtPreview/DicomPreview"));
import { API_BASE } from "../helpers/constants";
import {
  addRecentUpload,
  friendlyScanName,
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
  canPostprocess,
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

// A selection is either a single NIfTI file or a picked DICOM folder (the series'
// raw .dcm slices). Both are previewable individually and runnable through inference.
type SelectedItem =
  | { id: string; kind: "nifti"; file: File }
  | { id: string; kind: "dicom"; files: File[]; label: string };

const UploadPage: React.FC = () => {
  const navigate = useNavigate();
  // Only running inference requires an account. Picking files and the "None"
  // view-only mode stay open to everyone: that path never leaves the browser,
  // so the auth popup appears at Run, not at file selection. It opens on
  // sign-in: most people hitting this already have an account, and the popup
  // switches to sign-up in one click for the ones who don't.
  const { isAuthenticated, promptAuth, user, refreshUsage } = useAuth();
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
  // One poll timer per in-flight session so runs can proceed in parallel.
  const pollTimersRef = useRef<Map<string, ReturnType<typeof setInterval>>>(
    new Map(),
  );
  // Whether the current foreground upload got stored in IndexedDB (resumable).
  // If IDB was unavailable we fall back to warning before an unload instead.
  const uploadResumableRef = useRef<boolean>(false);
  // AbortController per session so a mid-upload run can be cancelled cleanly.
  const uploadAbortRef = useRef<Map<string, AbortController>>(new Map());
  // Which session currently drives the foreground upload progress bar.
  const foregroundUploadSidRef = useRef<string | null>(null);
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
  // Session ids of runs the user started in THIS page visit. Only these may
  // auto-open the viewer on completion; runs resumed on page load finish
  // quietly (finishSession announces them instead of navigating), so returning
  // to /upload mid-inference can't teleport the user away from what they're
  // doing.
  const userStartedRef = useRef<Set<string>>(new Set());

  const [selectedItems, setSelectedItems] = useState<SelectedItem[]>([]);
  // Which selected item's inline preview is open (null = none). One at a time.
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [inferenceCompleted, setInferenceCompleted] = useState<boolean>(false);
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
  const [modelDropOpen, setModelDropOpen] = useState(false);
  // LesionSegmenter computes liver/pancreatic/kidney/colon lesions in one pass;
  // this selects which lesion to feature. Only pancreatic is GT-validated; the
  // other three are surfaced as experimental.
  const [lesionTarget, setLesionTarget] = useState<
    "pancreatic" | "liver" | "kidney" | "colon"
  >("pancreatic");
  const modelDropRef = useRef<HTMLDivElement>(null);
  const [preDropOpen, setPreDropOpen] = useState(false);
  const preDropRef = useRef<HTMLDivElement>(null);
  const [preValue, setPreValue] = useState("");
  const [postDropOpen, setPostDropOpen] = useState(false);
  const postDropRef = useRef<HTMLDivElement>(null);
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
    if (!e.target.files) return;
    const filteredFiles = Array.from(e.target.files).filter((file) =>
      allowedExtensions.some((ext) => file.name.toLowerCase().endsWith(ext)),
    );
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
  }, []);

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
  };

  // Pick a DICOM folder to RUN INFERENCE on (distinct from the view-only opener):
  // the raw slices are added as one selectable item, previewable and runnable.
  const handleDicomInferenceSelect = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same folder later
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

  /* ── Inference polling (one timer per session) ── */
  const stopPolling = (sid: string) => {
    const timer = pollTimersRef.current.get(sid);
    if (timer) {
      clearInterval(timer);
      pollTimersRef.current.delete(sid);
    }
  };

  const stopAllPolling = () => {
    pollTimersRef.current.forEach((timer) => clearInterval(timer));
    pollTimersRef.current.clear();
  };

  const finishSession = (sid: string, model: string) => {
    stopPolling(sid);
    setPhase(sid);
    const uploads = updateRecentUploadStatus(sid, "Completed");
    setRecentUploads(uploads);
    setSessionId(sid);
    setInferenceCompleted(true);
    // Only auto-open the viewer for a run the user started in this page
    // visit, and only when no other run is still in flight. A run resumed on
    // page load finishing must never yank the user out of what they're doing
    // (renaming a scan, picking the next batch) - announce it instead.
    const startedHere = userStartedRef.current.has(sid);
    userStartedRef.current.delete(sid);
    if (!uploads.some((u) => u.status === "Processing")) {
      if (startedHere) {
        setTimeout(() => {
          navigate(
            model === "OpenVAE" ? `/reconstruction/${sid}` : `/session/${sid}`,
          );
        }, 600);
      } else {
        setMessage("Scan complete. Open it from Completed Uploads below.");
      }
    }
  };

  const startInferencePolling = (sid: string, model: string) => {
    stopPolling(sid);
    let notFoundCount = 0;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/inference-status/${sid}`);
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
          finishSession(sid, model);
        } else if (status === "failed") {
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Failed"));
          setMessage(`Inference failed${data.error ? `: ${data.error}` : ""}`);
        } else if (status === "cancelled") {
          // Cancelled elsewhere (another tab, or the backend) - reflect it.
          stopPolling(sid);
          setPhase(sid);
          setQueuePosition(sid);
          setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        } else if (status === "queued" || status === "running") {
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
      }
    }, 2500);
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

    const controller = uploadAbortRef.current.get(sid);
    if (controller) controller.abort();
    deletePendingUpload(sid);

    // Fire-and-forget: if the job never reached the server (upload phase)
    // this 404s, which is fine - the client side is already torn down.
    fetch(`${API_BASE}/api/cancel-inference/${sid}`, { method: "POST" }).catch(
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

  useEffect(() => {
    if (!modelDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        modelDropRef.current &&
        !modelDropRef.current.contains(e.target as Node)
      )
        setModelDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [modelDropOpen]);

  useEffect(() => {
    if (!preDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (preDropRef.current && !preDropRef.current.contains(e.target as Node))
        setPreDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [preDropOpen]);

  useEffect(() => {
    if (!postDropOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        postDropRef.current &&
        !postDropRef.current.contains(e.target as Node)
      )
        setPostDropOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [postDropOpen]);

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
      // 401 is an expired or missing sign-in, not a failure of the scan
      // itself (the client can still believe it is signed in when the cookie
      // has lapsed). Mirror the 402 shape: mark Cancelled, say why, and open
      // the sign-in popup instead of leaving a wordless Failed card.
      if (res.status === 401) {
        await deletePendingUpload(sid);
        setPhase(sid);
        setRecentUploads(updateRecentUploadStatus(sid, "Cancelled"));
        setMessage(
          "Your session expired before the run could start. Sign in and run the scan again.",
        );
        promptAuth();
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
  // isUploading/uploadProgress/message, the SAME state the foreground runUpload
  // path drives: only one upload is ever active at a time (both routes go
  // through uploadChainRef), so there is exactly one "Upload Progress" bar
  // for whichever file is currently on the wire, whether or not Run has been
  // pressed yet. Returns the uploaded filename, or null on failure/abort.
  const preUploadOnly = async (
    sid: string,
    file: File,
  ): Promise<string | null> => {
    const controller = new AbortController();
    uploadAbortRef.current.set(sid, controller);
    uploadRemainingRef.current.set(sid, file.size);
    // Not resumable (no IndexedDB record for a pre-upload) - closing the tab
    // now really does lose progress, so the unload warning should fire.
    uploadResumableRef.current = false;
    foregroundUploadSidRef.current = sid;
    setIsUploading(true);
    setUploadProgress(0);
    setMessage(`Uploading ${file.name}...`);
    let completedCount = 0;
    try {
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const CONCURRENCY = 6;
      let nextIndexToStart = 0;
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
          { method: "POST", body: formData, signal: controller.signal },
        );
        if (res.status === 413)
          throw new Error(
            "Upload chunk too large for server/proxy limit (HTTP 413).",
          );
        const data = await parseApiResponse(res);
        if (!res.ok) throw new Error(data.error || "Chunk upload failed");
        completedCount++;
        bytesSentRef.current += chunk.size;
        uploadRemainingRef.current.set(
          sid,
          Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - chunk.size),
        );
        setUploadProgress(Math.round((completedCount / totalChunks) * 100));
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
      // The finally below clears the status line for the foreground sid, so
      // this failure notice is deferred one tick to survive it. Copy matters:
      // the file chip is still selected and Run falls back to a fresh
      // resumable upload, so a retry really is one click away.
      const detail = err instanceof Error ? err.message : "network error";
      setTimeout(() => {
        setMessage(
          `Upload of ${file.name} failed (${detail}). It will be retried when you press Run.`,
        );
      }, 0);
      return null;
    } finally {
      if (foregroundUploadSidRef.current === sid) {
        foregroundUploadSidRef.current = null;
        setIsUploading(false);
        setMessage("");
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
    const file = item.file;
    enqueueUpload(async () => {
      const name = await preUploadOnly(sid, file);
      if (!name) {
        // Failed (or aborted): forget this attempt so the selection/model
        // effect can start a fresh one instead of the idempotence check
        // pinning the item to a dead upload forever. Guarded so a newer
        // attempt for the same item is never deleted by an older failure.
        const cur = itemUploadRef.current.get(item.id);
        if (cur && cur.sid === sid) itemUploadRef.current.delete(item.id);
      }
      resolveDone(name);
    });
  };

  // Start uploading every selected NIfTI file as soon as there's a model to
  // run it with, instead of waiting for Run - re-checked whenever a file is
  // added or the model changes, so picking the file first then the model (or
  // the other way around) both start the transfer at the earliest point
  // either is known. "None" (view-only) is excluded on purpose: that mode's
  // whole promise is the file never leaves the browser. preStartUpload is
  // idempotent per item id, so this can safely re-run on every render where
  // any dependency changed.
  //
  // Mirrors handleRunEpaiInference's own plan-limit check: a selection that
  // Run would refuse outright must not upload anything first - sending scan
  // data for a run the plan won't allow wastes bandwidth and, on a medical
  // imaging site, transmits patient data pointlessly. Skipping here just
  // means nothing pre-uploads; Run's existing check still explains why and
  // blocks the batch exactly as before.
  useEffect(() => {
    if (selectedModel === "None") return;
    // Signed-out users can pick files and browse freely, but no scan data may
    // leave the browser before the account gate at Run (ensureAccount) has
    // been passed. Once they sign in this effect re-runs and the pre-upload
    // starts then.
    if (!isAuthenticated) return;
    // A model the plan locks would 402 at Run anyway - don't send scan data
    // for a run that can never start.
    if (isModelLocked(plan, selectedModel)) return;
    const slots = maxConcurrentScans(plan as PlanId);
    const running = recentUploads.filter((u) => u.status === "Processing").length;
    if (selectedItems.length + running > slots) return;
    selectedItems.forEach(preStartUpload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel, selectedItems, plan, recentUploads, isAuthenticated]);

  // Retroactive half of the same gate: if the model returns to "None" (whose
  // promise is "files never leave your browser") or the user signs out, any
  // pre-upload already in flight is aborted and forgotten - switching the
  // gate off must stop bytes that are mid-transfer, not just future ones.
  useEffect(() => {
    if (selectedModel !== "None" && isAuthenticated) return;
    itemUploadRef.current.forEach((pre) => {
      uploadAbortRef.current.get(pre.sid)?.abort();
    });
    itemUploadRef.current.clear();
  }, [selectedModel, isAuthenticated]);

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
        setUploadProgress(Math.round((startChunk / totalChunks) * 100));
        setMessage(`Uploading ${filename}...`);
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
      let completedCount = startChunk;
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
            signal: controller.signal,
          },
        );
        if (res.status === 413)
          throw new Error(
            "Upload chunk too large for server/proxy limit (HTTP 413).",
          );
        const data = await parseApiResponse(res);
        if (!res.ok) throw new Error(data.error || "Chunk upload failed");

        completedCount++;
        completedIndices.add(i);
        bytesSentRef.current += chunk.size;
        uploadRemainingRef.current.set(
          sid,
          Math.max(0, (uploadRemainingRef.current.get(sid) ?? 0) - chunk.size),
        );
        await advanceWatermark();
        if (foreground)
          setUploadProgress(Math.round((completedCount / totalChunks) * 100));
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
        setUploadProgress(100);
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
      setUploadProgress(0);
      setMessage(`Uploading DICOM series (${files.length} slices)...`);

      for (let i = 0; i < files.length; i++) {
        const formData = new FormData();
        formData.append("session_id", sid);
        formData.append("file", files[i]);
        // Retried like NIfTI chunks, and it matters more here: a DICOM folder
        // has no IndexedDB copy, so a blip on any one slice means re-picking
        // the folder and starting over.
        const res = await postWithRetry(`${API_BASE}/api/upload-dicom-slice`, {
          method: "POST",
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
        setUploadProgress(Math.round(((i + 1) / files.length) * 100));
      }

      setMessage("Converting DICOM series to NIfTI...");
      const finalizeRes = await fetch(`${API_BASE}/api/finalize-dicom`, {
        method: "POST",
        signal: controller.signal,
        body: new URLSearchParams({ session_id: sid }),
      });
      const finalizeData = await parseApiResponse(finalizeRes);
      if (!finalizeRes.ok)
        throw new Error(finalizeData.error || "DICOM conversion failed");
      const uploadedName = finalizeData.uploaded_filename || "ct.nii.gz";

      foregroundUploadSidRef.current = null;
      setUploadProgress(100);
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
      // Card already shows "Failed"; don't duplicate it in the status line.
      setMessage("");
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

    // Started by the user in this visit - allowed to auto-open the viewer.
    userStartedRef.current.add(sid);

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
      setPhase(sid, "uploading"); // harmless if the background upload already finished
      (async () => {
        const uploadedName = await pre.uploadDone;
        if (!uploadedName) {
          // The background pre-upload failed or was aborted. The file is
          // still in hand, so retry through the normal resumable path under
          // the same session instead of insta-failing a run the user just
          // asked for. runUpload surfaces its own errors, so if this retry
          // also fails the card fails with a reason.
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
            enqueueUpload(() => {
              uploadResumableRef.current = resumable;
              return runUpload(retry, true);
            });
            return;
          }
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
    const items = selectedItems;
    const first = items[0] ?? null;

    // "None" model = view only: open the scan in its full local viewer, nothing is
    // uploaded or run, so no account is needed. DICOM opens the /dicom viewer,
    // NIfTI the /local-nifti viewer.
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

    // Real models upload and run on the servers, and that is the point where an
    // account becomes necessary.
    if (!ensureAccount()) return;

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
      const statusRes = await fetch(`${API_BASE}/api/inference-status/${sid}`);
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

      const resultRes = await fetch(`${API_BASE}/api/get_result/${sid}`);
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
      userStartedRef.current.add(sid); // user-started: may auto-open on completion
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
            className={`dropzone${isDragOver ? " drag-over" : ""}`}
            onClick={() => fileInputRef.current?.click()}
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
            <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
              <button
                type="button"
                className="dropzone-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
              >
                Select NIfTI file
              </button>
              <button
                type="button"
                className="dropzone-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  dicomUploadInputRef.current?.click();
                }}
              >
                Select DICOM folder
              </button>
            </div>
          </div>

          {/* ── Selected items: NIfTI files + DICOM series, each individually previewable ──
              Card rows (matching the Completed Uploads treatment below) instead of small
              inline pills, so a selected file reads as clearly as everything else on the
              page rather than looking like a stray tag. */}
          {selectedItems.length > 0 && (
            <div className="file-chips">
              {selectedItems.map((item) => {
                const name =
                  item.kind === "dicom" ? item.label : item.file.name;
                const subtext =
                  item.kind === "dicom"
                    ? `DICOM series · ${item.files.length} slice${item.files.length === 1 ? "" : "s"}`
                    : `NIfTI · ${formatBytes(item.file.size)}`;
                const isOpen = previewItemId === item.id;
                return (
                  <div
                    key={item.id}
                    className={`file-chip${isOpen ? " file-chip--active" : ""}`}
                  >
                    <span className="file-chip-icon" aria-hidden="true">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    </span>
                    <span className="file-chip-text">
                      <span className="file-chip-name">{name}</span>
                      <span className="file-chip-sub">{subtext}</span>
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
                );
              })}
            </div>
          )}

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
                <div className="pipeline-badge">1</div>
                <span className="pipeline-label">Preprocessing</span>
                <span className="pipeline-optional">optional</span>
              </div>
              <div className="model-dropdown" ref={preDropRef}>
                <button
                  className={`model-dropdown-btn${preValue ? " has-value" : ""}${preDropOpen ? " open" : ""}`}
                  onClick={() => setPreDropOpen((o) => !o)}
                  type="button"
                >
                  <span>{preValue || "None (skip)"}</span>
                  <svg
                    className={`model-dropdown-chevron${preDropOpen ? " rotated" : ""}`}
                    width="10"
                    height="6"
                    viewBox="0 0 10 6"
                    fill="none"
                  >
                    <path
                      d="M1 1l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {preDropOpen && (
                  <div className="model-dropdown-menu">
                    {[
                      {
                        id: "",
                        label: "None (skip)",
                        desc: "Upload and segment as-is",
                      },
                      {
                        id: "OpenVAE",
                        label: "OpenVAE",
                        desc: "Enhance the scan quality before segmenting",
                      },
                    ].map((opt) => (
                      <div
                        key={opt.id}
                        className={`model-dropdown-item${preValue === opt.id ? " selected" : ""}`}
                        onClick={() => {
                          setPreValue(opt.id);
                          setPreDropOpen(false);
                        }}
                      >
                        <div className="model-dropdown-item-content">
                          <span className="model-dropdown-item-name">
                            {opt.label}
                          </span>
                          <span className="model-dropdown-item-desc">
                            {opt.desc}
                          </span>
                        </div>
                        <div className="model-dropdown-item-side">
                          {preValue === opt.id && (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              className="model-dropdown-check"
                            >
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="pipeline-arrow">→</div>

            {/* Step 2: Model */}
            <div className="pipeline-step">
              <div className="pipeline-step-header">
                <div className="pipeline-badge">2</div>
                <span className="pipeline-label">Model</span>
              </div>
              <div className="model-dropdown" ref={modelDropRef}>
                <button
                  className={`model-dropdown-btn${selectedModel && selectedModel !== "None" ? " has-value" : ""}${modelDropOpen ? " open" : ""}`}
                  onClick={() => setModelDropOpen((o) => !o)}
                  type="button"
                >
                  <span>
                    {selectedModel === "None"
                      ? "None (view scan)"
                      : selectedModel === "LesionSegmenter"
                        ? `LesionSegmenter — ${
                            LESION_OPTIONS.find((l) => l.id === lesionTarget)
                              ?.label ?? "Pancreatic lesion"
                          }`
                        : MODEL_OPTIONS.find((m) => m.id === selectedModel)
                            ?.label || "Select a model"}
                  </span>
                  <svg
                    className={`model-dropdown-chevron${modelDropOpen ? " rotated" : ""}`}
                    width="10"
                    height="6"
                    viewBox="0 0 10 6"
                    fill="none"
                  >
                    <path
                      d="M1 1l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {modelDropOpen && (
                  <div className="model-dropdown-menu">
                    {MODEL_OPTIONS.map((m) => {
                      // Locked models stay visible with an "Upgrade" pill rather
                      // than being hidden — you can't want what you can't see,
                      // and ChatGPT's model picker works the same way.
                      const locked = modelLocked(m.id);
                      const hasSubmenu = !locked && m.id === "LesionSegmenter";
                      return (
                      <div
                        key={m.id}
                        className={`model-dropdown-item${selectedModel === m.id ? " selected" : ""}${locked ? " locked" : ""}${hasSubmenu ? " has-submenu" : ""}`}
                        onClick={() => {
                          if (locked) {
                            setModelDropOpen(false);
                            setUpgradeBlock({
                              reason: "model_locked", feature: m.label, plan: plan as PlanId,
                            });
                            return;
                          }
                          track("upload_select_model");
                          setSelectedModel(m.id as typeof selectedModel);
                          setModelDropOpen(false);
                        }}
                      >
                        <div className="model-dropdown-item-content">
                          <span className="model-dropdown-item-name">
                            {m.label}
                          </span>
                          <span className="model-dropdown-item-desc">
                            {m.desc}
                          </span>
                        </div>
                        <div className="model-dropdown-item-side">
                          {locked && <span className="model-dropdown-lock">Donate</span>}
                          {hasSubmenu ? (
                            <svg
                              className="model-submenu-arrow"
                              width="7"
                              height="10"
                              viewBox="0 0 7 10"
                              fill="none"
                            >
                              <path
                                d="M1 1l4 4-4 4"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : (
                            !locked && selectedModel === m.id && (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              className="model-dropdown-check"
                            >
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                            )
                          )}
                        </div>
                        {hasSubmenu && (
                          <div className="model-submenu" role="menu">
                            {LESION_OPTIONS.map((l) => (
                              <div
                                key={l.id}
                                role="menuitemradio"
                                aria-checked={lesionTarget === l.id}
                                className={`model-submenu-item${lesionTarget === l.id ? " selected" : ""}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedModel("LesionSegmenter");
                                  setLesionTarget(l.id);
                                  setModelDropOpen(false);
                                }}
                              >
                                <span className="model-submenu-check">
                                  {lesionTarget === l.id && (
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 12 12"
                                      fill="none"
                                    >
                                      <path
                                        d="M2 6l3 3 5-5"
                                        stroke="currentColor"
                                        strokeWidth="1.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </span>
                                <span className="model-submenu-label">
                                  {l.label}
                                  {l.experimental && (
                                    <span className="model-submenu-exp">
                                      experimental
                                    </span>
                                  )}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="pipeline-arrow">→</div>

            {/* Step 3: Postprocessing */}
            <div className="pipeline-step">
              <div className="pipeline-step-header">
                <div className="pipeline-badge">3</div>
                <span className="pipeline-label">Postprocessing</span>
                <span className="pipeline-optional">optional</span>
              </div>
              <div className="model-dropdown" ref={postDropRef}>
                <button
                  className={`model-dropdown-btn${postValue ? " has-value" : ""}${postDropOpen ? " open" : ""}`}
                  onClick={() => setPostDropOpen((o) => !o)}
                  type="button"
                >
                  <span>{postValue || "None (skip)"}</span>
                  <svg
                    className={`model-dropdown-chevron${postDropOpen ? " rotated" : ""}`}
                    width="10"
                    height="6"
                    viewBox="0 0 10 6"
                    fill="none"
                  >
                    <path
                      d="M1 1l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {postDropOpen && (
                  <div className="model-dropdown-menu">
                    {[
                      {
                        id: "",
                        label: "None (skip)",
                        desc: "Use results as-is",
                      },
                      {
                        id: "ShapeKit",
                        label: "ShapeKit",
                        desc: "Clean up and smooth organ outlines",
                      },
                    ].map((opt) => {
                      const locked =
                        opt.id !== "" && isAuthenticated && !canPostprocess(plan);
                      return (
                      <div
                        key={opt.id}
                        className={`model-dropdown-item${postValue === opt.id ? " selected" : ""}${locked ? " locked" : ""}`}
                        onClick={() => {
                          if (locked) {
                            setPostDropOpen(false);
                            setUpgradeBlock({
                              reason: "postprocessing", feature: opt.label, plan: plan as PlanId,
                            });
                            return;
                          }
                          track("upload_select_postprocessing");
                          setPostValue(opt.id);
                          setPostDropOpen(false);
                        }}
                      >
                        <div className="model-dropdown-item-content">
                          <span className="model-dropdown-item-name">
                            {opt.label}
                          </span>
                          <span className="model-dropdown-item-desc">
                            {opt.desc}
                          </span>
                        </div>
                        <div className="model-dropdown-item-side">
                          {locked && <span className="model-dropdown-lock">Donate</span>}
                          {!locked && postValue === opt.id && (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 12 12"
                              fill="none"
                              className="model-dropdown-check"
                            >
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                )}
              </div>
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
              completed entries in Completed Uploads, not as an always-on button. */}

          {/* ── Progress (upload phase only - running inference shows in Active below) ── */}
          {isUploading && (
            <div className="progress-section">
              <div className="progress-item">
                <div className="progress-label">
                  <span className="progress-label-text">Upload Progress</span>
                  <span className="progress-label-pct">{uploadProgress}%</span>
                </div>
                <div className="progress-track">
                  <div
                    className="progress-fill progress-fill-upload"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Results ── */}
          {inferenceCompleted && sessionId && (
            <div className="result-section">
              <div className="result-title">✓ Inference Complete</div>
              <div className="result-btns">
                {selectedModel === "OpenVAE" ? (
                  <>
                    <button
                      className="result-btn"
                      onClick={() => navigate(`/reconstruction/${sessionId}`)}
                    >
                      View Reconstruction
                    </button>
                    <button
                      className="result-btn"
                      onClick={handleRunEpaiOnReconstruction}
                    >
                      Run ePAI on Result
                    </button>
                    <button
                      className="result-btn"
                      onClick={() => downloadResult(sessionId)}
                    >
                      Download
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="result-btn result-btn-primary"
                      onClick={() => navigate(`/session/${sessionId}`)}
                    >
                      View Visualization
                    </button>
                    <button
                      className="result-btn"
                      onClick={() => downloadResult(sessionId)}
                    >
                      Download Results
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

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
          const groups = groupUploads(recentUploads);
          const inFlight = groups.filter(isGroupInFlight);
          // Only the last day stays here. Anything older is history, and lives
          // in settings — this page is for the work in front of you.
          const { recent: finished, older } = splitByAge(groups.filter(g => !isGroupInFlight(g)));

          // Only the upload needs this tab open; past that the job lives in the
          // server's queue. Rides along on each card's status line rather than as
          // its own banner - it's reassurance, not a state the user must act on.
          const closeNote = closeInfo.active
            ? closeInfo.eta === null
              ? "keep tab open"
              : `safe to close in ${formatEta(closeInfo.eta)}`
            : "safe to close";

          const canView = (u: RecentUpload) => u.status !== "Failed" && u.status !== "Cancelled";
          const openSession = (u: RecentUpload) => {
            if (!canView(u)) return;
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
                {/* No real percent-complete exists for inference, so this is an
                    indeterminate sweep — honest motion, not a fabricated number.
                    Suppressed during waiting/uploading: the real Upload Progress
                    bar above already covers this scan, so both at once was two
                    progress bars for one event. */}
                {phase !== "waiting" && phase !== "uploading" && (
                  <div className="progress-track">
                    <div className="progress-fill progress-fill--indeterminate" />
                  </div>
                )}
              </div>
            );
          };

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
                    <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                      <span title={u.sourceName || undefined} style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "14px", fontWeight: 600, color: "#111111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.label}</span>
                      <button
                        title="Rename scan"
                        onClick={(e) => { e.stopPropagation(); startRename(u); }}
                        style={{ background: "none", border: "none", cursor: "pointer", padding: "2px", color: "#6a6a6a", flexShrink: 0, lineHeight: 0 }}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                      </button>
                    </div>
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

          // ── Model card: replaces the old placeholder text with a preview of what
          // will actually run, using the same name the "Run" button will use. An
          // empty state that just says "nothing here yet" wastes the space; showing
          // the selected model gives the user something to check before they run it. ──
          const selectedModelLabel =
            selectedModel === "None"
              ? "None (view scan)"
              : selectedModel === "LesionSegmenter"
                ? `LesionSegmenter — ${
                    LESION_OPTIONS.find((l) => l.id === lesionTarget)?.label ??
                    "Pancreatic lesion"
                  }`
                : MODEL_OPTIONS.find((m) => m.id === selectedModel)?.label ?? null;
          const selectedModelDesc =
            selectedModel === "LesionSegmenter"
              ? LESION_OPTIONS.find((l) => l.id === lesionTarget)?.experimental
                ? "Experimental — not yet validated against ground truth"
                : MODEL_OPTIONS.find((m) => m.id === "LesionSegmenter")?.desc
              : MODEL_OPTIONS.find((m) => m.id === selectedModel)?.desc;

          const emptyBox = (
            <div style={{
              background: "#f5f5f5", border: "1px dashed rgba(0,0,0,0.12)", borderRadius: "12px",
              padding: "20px", display: "flex", alignItems: "center", gap: "16px",
            }}>
              <div style={{
                width: "40px", height: "40px", borderRadius: "8px", flexShrink: 0,
                background: "rgba(0,0,0,0.06)", border: "1px solid rgba(0,0,0,0.12)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#111111" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9.5 2h5l.5 4.5 3.5 2-1 5-3 2.5-.5 4.5h-5l-.5-4.5-3-2.5-1-5 3.5-2z" />
                  <circle cx="12" cy="12" r="2.5" />
                </svg>
              </div>
              <div style={{ minWidth: 0, textAlign: "left" }}>
                {selectedModelLabel ? (
                  <>
                    <div style={{ fontFamily: "'Space Grotesk', sans-serif", fontSize: "13px", fontWeight: 600, color: "#111111" }}>
                      {selectedModelLabel}
                    </div>
                    {selectedModelDesc && (
                      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#8f8f8f", marginTop: "3px" }}>
                        {selectedModelDesc}
                      </div>
                    )}
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "11px", color: "#8f8f8f", marginTop: "6px" }}>
                      Select a file above and run to see results here.
                    </div>
                  </>
                ) : (
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: "12px", color: "#8f8f8f" }}>
                    No uploads yet - run a model above and your results will appear here.
                  </div>
                )}
              </div>
            </div>
          );

          return (
            <>
              {inFlight.length > 0 && (
                <div style={{ marginTop: "32px", display: "flex", flexDirection: "column", gap: "8px" }}>
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
              )}

              <div style={{ marginTop: "32px" }}>
                <SectionLabel>Completed Uploads</SectionLabel>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {finished.length === 0 ? emptyBox : finished.map(g =>
                    g.kind === "single"
                      ? <CompletedCard key={g.upload.sessionId} u={g.upload} />
                      : <CompletedBatchBar key={g.batchId} batchId={g.batchId} label={g.label} uploads={g.uploads} />
                  )}
                </div>
                {older.length > 0 && (
                  <button type="button" className="upload-history-link"
                    onClick={() => navigate("/account/history")}>
                    {older.length} older {older.length === 1 ? "scan" : "scans"} in History →
                  </button>
                )}
              </div>
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
              onView={(u) => navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${u.sessionId}`)}
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
