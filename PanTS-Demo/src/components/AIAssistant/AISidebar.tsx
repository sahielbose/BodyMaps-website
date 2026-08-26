import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../../contexts/authContext";
import { track } from "../../helpers/analytics";
import { API_BASE } from "../../helpers/constants";
import type {
  AIAction,
  AIModelInfo,
  AISidebarProps,
  ChatAttachment,
  ChatMessage,
} from "./types";
import "./AISidebar.css";

// The plan's daily message allowance is spent (HTTP 402). Distinguished from a
// transport error so the streaming path doesn't retry on the non-streaming one,
// which would be refused for the same reason.
class PlanLimitError extends Error {}

// Signed out (HTTP 401). The assistant needs an account, same as inference.
// Also its own type, for the same no-pointless-retry reason.
class AuthRequiredError extends Error {}

// Turn a send failure into something the person reading it can act on.
//
// Both endpoints failing used to collapse into one sentence — "The assistant
// service is unavailable right now" — which is true of a stopped backend, a
// crashed request, and a vision model that was never pulled alike. That single
// string sent people looking in the wrong place every time.
function describeSendFailure(error: unknown, hadImages: boolean): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");

  // fetch() rejects with a TypeError when it never reached a server at all.
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    return (
      `I couldn't reach the BodyMaps backend at ${API_BASE}. Check that the ` +
      "Flask server is running and that VITE_API_BASE points at it."
    );
  }

  const status = /HTTP (\d{3})/.exec(raw)?.[1];

  if (status === "413") {
    return "The captured views were too large for the server to accept. Try attaching fewer panes.";
  }

  if (status && status.startsWith("5")) {
    return (
      `The backend returned an error (HTTP ${status}) while answering` +
      (hadImages ? " a request with attached views" : "") +
      ". The Flask terminal has the traceback."
    );
  }

  if (hadImages) {
    return (
      "I couldn't complete the read of the attached views. If this keeps " +
      "happening, check that a vision model is installed on the server " +
      "(`ollama list`) — image messages need one."
    );
  }

  return "The assistant didn't return an answer. Viewer controls still work from the top panel.";
}

// Bumped to v2 so a previously-stored reasoning model (e.g. qwen3) is reset —
// the default now prefers a non-reasoning model that never leaks "thinking".
const MODEL_STORAGE_KEY = "bodymaps-ai-model-v2";

// Reasoning models emit a chain-of-thought that can leak into the answer on
// older Ollama; we avoid picking them as the initial default.
const REASONING_MODEL = /qwen3(?!-vl)|deepseek-r1|-r1\b|:think|marco-o1|qwq/i;

// Short "best for ..." line shown under each model in the picker, so someone
// who has never used local models knows which one to pick. Order matters:
// vision ("vl") must match before the generic qwen check.
function modelDescription(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("vl") || n.includes("vision")) {
    return "For complex image and snapshot tasks";
  }
  if (n.includes("llama")) {
    return "Best all-around";
  }
  if (n.includes("qwen")) {
    return "Fastest for quick answers";
  }
  return "General-purpose local model";
}

const SendIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2.1}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M22 2 11 13" />
    <path d="m22 2-7 20-4-9-9-4 20-7Z" />
  </svg>
);

const CloseIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="m7 7 10 10M17 7 7 17" />
  </svg>
);

const PlusIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const CameraIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 8h3l1.6-2.2a1 1 0 0 1 .8-.4h5.2a1 1 0 0 1 .8.4L20 8h0a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z" />
    <circle cx="12" cy="13" r="3.2" />
  </svg>
);

const BotIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="4" y="10" width="16" height="10" rx="2.8" />
    <path d="M12 10V6" />
    <circle cx="12" cy="5" r="2" />
    <path d="M8.5 15h.01M15.5 15h.01M9 18c1.4.9 4.6.9 6 0" />
  </svg>
);

const CopyIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="9" y="9" width="12" height="12" rx="2.5" />
    <path d="M6 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </svg>
);

const SpeakerIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8 8 0 0 1 0 12" />
  </svg>
);

const StopIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const ChevronIcon = () => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m6.5 8 3.5 3.5L13.5 8" />
  </svg>
);

// Attachment type → a distinct little icon (PDF / image / scan / generic file).
type FileType = "pdf" | "image" | "scan" | "file";

function fileTypeOf(name: string): FileType {
  const n = name.toLowerCase();
  if (n.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpe?g|gif|webp|bmp|tiff?)$/.test(n)) return "image";
  if (/\.(nii|nii\.gz|dcm|dicom|nrrd|mha|mhd)$/.test(n)) return "scan";
  return "file";
}

const DocIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </svg>
);

const ImageFileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2.4" />
    <circle cx="8.5" cy="9" r="1.6" />
    <path d="m4 17 5-5 4 4 3-3 4 4" />
  </svg>
);

const ScanFileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <circle cx="12" cy="12" r="3.4" />
  </svg>
);

function AttachmentTypeIcon({ name }: { name: string }) {
  const type = fileTypeOf(name);
  if (type === "image") return <ImageFileIcon />;
  if (type === "scan") return <ScanFileIcon />;
  return <DocIcon />;
}

const CheckIcon = () => (
  <svg
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m5 10 3 3 7-7" />
  </svg>
);

let idCounter = 0;
function makeId(prefix = "id") {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Cap on extracted document text sent to the model — keeps the prompt inside
// the local model's context window (roughly 1.5k tokens of document).
const PDF_TEXT_LIMIT = 6000;

// Extract the text layer of an attached PDF in the browser, so the model can
// actually read the document instead of only seeing its filename. Returns null
// for scanned/image-only PDFs (no text layer) and on any parse failure.
async function extractPdfText(file: File): Promise<string | null> {
  try {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() });
    try {
      const doc = await loadingTask.promise;
      const maxPages = Math.min(doc.numPages, 12);
      let text = "";
      for (let pageNum = 1; pageNum <= maxPages && text.length < PDF_TEXT_LIMIT; pageNum++) {
        const page = await doc.getPage(pageNum);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (pageText) text += pageText + "\n";
      }
      const trimmed = text.trim();
      return trimmed ? trimmed.slice(0, PDF_TEXT_LIMIT) : null;
    } finally {
      // Release the worker-side parsed document — pdf.js pins it otherwise,
      // so attaching several PDFs would grow tab memory until reload.
      void loadingTask.destroy();
    }
  } catch (error) {
    console.warn("[BodyMaps AI pdf extract]", error);
    return null;
  }
}

// Minimal markdown: **bold** and line breaks. Kept intentionally small so the
// assistant text stays clean and minimalist rather than heavily styled.
function renderMessageText(content: string) {
  return content.split("\n").map((line, lineIndex, lines) => {
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    return (
      <React.Fragment key={`${lineIndex}-${line}`}>
        {parts.map((part, partIndex) => {
          if (part.startsWith("**") && part.endsWith("**")) {
            return <strong key={`${lineIndex}-${partIndex}`}>{part.slice(2, -2)}</strong>;
          }
          return (
            <React.Fragment key={`${lineIndex}-${partIndex}`}>{part}</React.Fragment>
          );
        })}
        {lineIndex < lines.length - 1 ? <br /> : null}
      </React.Fragment>
    );
  });
}

type ModelState = "loading" | "ollama" | "fallback";

type StreamEvent =
  | { type: "status"; text?: string }
  | { type: "thinking"; delta?: string }
  | { type: "reply"; delta?: string }
  | { type: "actions"; actions?: AIAction[] }
  | { type: "final"; reply?: string; actions?: AIAction[]; source?: string; model?: string | null }
  | { type: "done" }
  | { type: "error"; message?: string }
  // The agent decided it needs to SEE the CT views: the browser captures the
  // four panes and re-sends this turn with the images attached (self-capture).
  | { type: "need_capture" };

export default function AISidebar({
  open,
  onClose,
  caseId,
  sessionId,
  availableOrgans,
  viewerState,
  organMetrics = [],
  organReferences = [],
  demographics = null,
  actions,
  captureViewport,
  getMaskLegend,
  onResize,
  onResizeEnd,
}: AISidebarProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [models, setModels] = useState<AIModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  // Backend's vision model — shown as the active model whenever images are
  // attached, because the backend switches to it for those messages.
  const [visionModel, setVisionModel] = useState("");
  // Whether the server actually has a vision-capable model pulled. The configured
  // name is not proof: qwen3-vl needs Ollama 0.12.7+, and when it was never
  // downloaded every image message failed with a generic "unavailable" error
  // that gave no hint the cause was a missing model.
  const [visionAvailable, setVisionAvailable] = useState(true);
  // The assistant is open to everyone — no sign-in required. promptAuth is
  // kept only to handle a 401 from an older backend that still gates it.
  const { promptAuth } = useAuth();

  const [modelState, setModelState] = useState<ModelState>("loading");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Whether the chat is scrolled to (near) the bottom. Only auto-scroll when it
  // is, so scrolling up to read during generation isn't yanked back down.
  const pinnedToBottomRef = useRef(true);

  const loadModels = useCallback(async () => {
    setModelState("loading");
    try {
      const response = await fetch(`${API_BASE}/api/ai-models`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);

      const nextModels: AIModelInfo[] = Array.isArray(data.models) ? data.models : [];
      setModels(nextModels);
      setVisionModel(String(data.vision_model || ""));
      // Older backends do not report this field; treat its absence as "assume
      // yes" so this never invents a warning on a server that works fine.
      setVisionAvailable(data.vision_available !== false);

      if (!data.available || nextModels.length === 0) {
        setSelectedModel("");
        setModelState("fallback");
        return;
      }

      const storedModel = window.localStorage.getItem(MODEL_STORAGE_KEY) ?? "";
      const backendDefault = String(data.default_model || "");
      // Prefer a non-reasoning model as the initial default (clean output),
      // unless the user has already picked one this session.
      const cleanModel = nextModels.find((model) => !REASONING_MODEL.test(model.name));
      const nextSelection = nextModels.some((model) => model.name === storedModel)
        ? storedModel
        : !REASONING_MODEL.test(backendDefault) &&
            nextModels.some((model) => model.name === backendDefault)
          ? backendDefault
          : cleanModel?.name ?? (backendDefault || nextModels[0].name);

      setSelectedModel(nextSelection);
      setModelState("ollama");
    } catch (error) {
      console.warn("[BodyMaps AI models]", error);
      setModels([]);
      setSelectedModel("");
      setModelState("fallback");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setModelMenuOpen(false);
    void loadModels();
    const focusTimer = window.setTimeout(() => textareaRef.current?.focus(), 180);
    return () => window.clearTimeout(focusTimer);
  }, [open, loadModels]);

  useEffect(() => {
    abortRef.current?.abort();
    setMessages([]);
    setInput("");
    setAttachments([]);
    setModelMenuOpen(false);
    setLightboxUrl(null);
  }, [caseId, sessionId]);

  // Auto-scroll to the newest content ONLY when the user is already near the
  // bottom. If they've scrolled up to read, leave them where they are.
  useEffect(() => {
    if (pinnedToBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages, loading]);

  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedToBottomRef.current = distanceFromBottom < 80;
  }, []);

  const closeSidebar = useCallback(() => {
    setModelMenuOpen(false);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (
        modelMenuOpen &&
        modelPickerRef.current &&
        !modelPickerRef.current.contains(event.target as Node)
      ) {
        setModelMenuOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Innermost layer first: the full-screen lightbox sits above the
      // sidebar, so Escape must dismiss it before closing anything else.
      if (lightboxUrl) setLightboxUrl(null);
      else if (modelMenuOpen) setModelMenuOpen(false);
      else closeSidebar();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeSidebar, lightboxUrl, modelMenuOpen, open]);

  const selectModel = (value: string) => {
    setSelectedModel(value);
    setModelMenuOpen(false);
    if (value) {
      window.localStorage.setItem(MODEL_STORAGE_KEY, value);
      setModelState("ollama");
    } else {
      window.localStorage.removeItem(MODEL_STORAGE_KEY);
      setModelState(models.length > 0 ? "ollama" : "fallback");
    }
  };

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
    const element = event.target;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 124)}px`;
  };

  const updateMessage = useCallback(
    (id: string, updater: (message: ChatMessage) => ChatMessage) => {
      setMessages((previous) =>
        previous.map((message) => (message.id === id ? updater(message) : message))
      );
    },
    []
  );

  const executeAction = useCallback(
    async (action: AIAction): Promise<void> => {
      switch (action.type) {
        case "isolate_organs":
          actions.isolateOrgans(action.organs);
          break;
        case "show_organs":
          actions.showOrgans(action.organs);
          break;
        case "hide_organs":
          actions.hideOrgans(action.organs);
          break;
        case "focus_organ":
          actions.focusOrgan(action.organ);
          break;
        case "set_opacity":
          actions.setOpacity(action.value);
          break;
        case "set_window":
          actions.setWindow(action.width, action.center);
          break;
        case "set_window_preset":
          actions.setWindowPreset(action.preset);
          break;
        case "set_zoom":
          actions.setZoom(action.value);
          break;
        case "zoom_to_fit":
          actions.zoomToFit();
          break;
        case "set_view":
          actions.setViewMode(action.view);
          break;
        case "activate_measurement_tool":
          actions.activateMeasurementTool(action.tool);
          break;
        case "clear_measurements":
          actions.clearMeasurements();
          break;
        case "get_largest_structure":
          await actions.getLargestStructure();
          break;
        case "get_smallest_structure":
          await actions.getSmallestStructure();
          break;
        case "get_organ_metric":
        case "list_structures":
        case "get_structure_count":
          // The Flask response is already grounded with these values.
          break;
      }
    },
    [actions]
  );

  const applyReturnedActions = useCallback(
    async (returnedActions: AIAction[]) => {
      for (const action of returnedActions) {
        try {
          await executeAction(action);
        } catch (error) {
          console.error("[BodyMaps AI action error]", error, action);
        }
      }
    },
    [executeAction]
  );

  // ---- Attachments ---------------------------------------------------------

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    const next: ChatAttachment[] = [];
    for (const file of list) {
      if (file.type.startsWith("image/")) {
        try {
          const dataUrl = await readFileAsDataURL(file);
          next.push({ id: makeId("att"), name: file.name, kind: "image", dataUrl, source: "upload" });
        } catch {
          next.push({ id: makeId("att"), name: file.name, kind: "file", source: "upload" });
        }
      } else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        // Pull the PDF's text so the model can read the document and react to
        // its content (and ask follow-ups), not just see a filename.
        const textContent = await extractPdfText(file);
        next.push({
          id: makeId("att"),
          name: file.name,
          kind: "file",
          source: "upload",
          textContent: textContent ?? undefined,
        });
      } else {
        next.push({ id: makeId("att"), name: file.name, kind: "file", source: "upload" });
      }
    }
    if (next.length) setAttachments((previous) => [...previous, ...next]);
  }, []);

  const handleFilePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files && event.target.files.length) void addFiles(event.target.files);
    event.target.value = "";
  };

  const handleCapture = useCallback(async () => {
    if (!captureViewport || capturing) return;
    // Toggle: if screenshots are already attached, one more click clears them
    // all instead of stacking another set.
    if (attachments.some((att) => att.source === "screenshot")) {
      setAttachments((previous) => previous.filter((att) => att.source !== "screenshot"));
      return;
    }
    setCapturing(true);
    try {
      const shots = await captureViewport();
      if (!shots.length) return;
      const next: ChatAttachment[] = shots.map((shot) => ({
        id: makeId("shot"),
        name: `${shot.name} view`,
        kind: "image",
        dataUrl: shot.dataUrl,
        label: shot.name,
        source: "screenshot",
      }));
      setAttachments((previous) => [...previous, ...next]);
    } catch (error) {
      console.error("[BodyMaps AI capture error]", error);
    } finally {
      setCapturing(false);
    }
  }, [captureViewport, capturing, attachments]);

  const removeAttachment = (id: string) => {
    setAttachments((previous) => previous.filter((item) => item.id !== id));
  };

  // ---- Copy / read aloud (per assistant message) ---------------------------

  const handleCopy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1400);
    } catch (error) {
      console.error("[BodyMaps AI copy error]", error);
    }
  }, []);

  const handleSpeak = useCallback(
    (id: string, text: string) => {
      const synth = window.speechSynthesis;
      if (!synth) return;
      // Toggle: clicking the speaker on the message that's talking stops it.
      if (speakingId === id) {
        synth.cancel();
        setSpeakingId(null);
        return;
      }
      synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.02;
      utterance.onend = () => setSpeakingId((current) => (current === id ? null : current));
      utterance.onerror = () => setSpeakingId((current) => (current === id ? null : current));
      setSpeakingId(id);
      synth.speak(utterance);
    },
    [speakingId]
  );

  // ---- Drag-to-resize (left edge) ------------------------------------------

  const startResize = useCallback(
    (event: React.PointerEvent) => {
      if (!onResize) return;
      event.preventDefault();
      const move = (e: PointerEvent) => onResize(e.clientX);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        onResizeEnd?.();
      };
      document.body.style.cursor = "ew-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onResize, onResizeEnd]
  );

  // Stop any narration when the panel closes or the case changes. Also drop
  // the lightbox: it portals to <body>, so left open it would outlive the
  // sidebar and strand a full-screen overlay over the viewer.
  useEffect(() => {
    if (!open) {
      window.speechSynthesis?.cancel();
      setSpeakingId(null);
      setLightboxUrl(null);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);

  // ---- Streaming send ------------------------------------------------------

  const streamResponse = useCallback(
    async (
      assistantId: string,
      payload: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<{ captureRequested: boolean }> => {
      const response = await fetch(`${API_BASE}/api/ai-command-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
        signal,
      });
      // 402 = the plan's daily message allowance is spent. Surfaced as the
      // assistant's own reply rather than a modal: the sidebar is a
      // conversation, and a dialog over it would lose the thread.
      if (response.status === 401) {
        throw new AuthRequiredError("Sign in to use the assistant.");
      }
      if (response.status === 402) {
        const limit = await response.json().catch(() => ({}));
        throw new PlanLimitError(limit.message || "You've reached today's message limit.");
      }
      if (!response.ok || !response.body) {
        // Carry the server's own words along with the status: a 500 from the
        // assistant endpoint usually explains itself, and swallowing that text
        // is what made every failure look identical from the chat panel.
        const detail = await response.text().catch(() => "");
        throw new Error(
          `HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let actionsApplied = false;
      let captureRequested = false;

      const handleEvent = (event: StreamEvent) => {
        switch (event.type) {
          case "need_capture":
            captureRequested = true;
            break;
          case "status":
            updateMessage(assistantId, (m) => ({ ...m, status: event.text ?? "" }));
            break;
          case "thinking":
            updateMessage(assistantId, (m) => ({
              ...m,
              thinking: (m.thinking ?? "") + (event.delta ?? ""),
            }));
            break;
          case "reply":
            updateMessage(assistantId, (m) => ({
              ...m,
              content: m.content + (event.delta ?? ""),
              status: undefined,
            }));
            break;
          case "actions":
            if (Array.isArray(event.actions) && event.actions.length) {
              actionsApplied = true;
              void applyReturnedActions(event.actions);
            }
            break;
          case "final":
            if (typeof event.reply === "string") {
              updateMessage(assistantId, (m) => ({ ...m, content: event.reply as string, status: undefined }));
            }
            if (!actionsApplied && Array.isArray(event.actions) && event.actions.length) {
              actionsApplied = true;
              void applyReturnedActions(event.actions);
            }
            break;
          case "error":
            updateMessage(assistantId, (m) => ({
              ...m,
              content:
                m.content ||
                event.message ||
                "The assistant ran into an error while answering.",
              status: undefined,
            }));
            break;
          case "done":
            break;
        }
      };

      // Read the NDJSON stream line by line.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) {
            try {
              handleEvent(JSON.parse(line) as StreamEvent);
            } catch (error) {
              console.warn("[BodyMaps AI stream parse]", error, line);
            }
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      const tail = buffer.trim();
      if (tail) {
        try {
          handleEvent(JSON.parse(tail) as StreamEvent);
        } catch {
          /* ignore trailing partial */
        }
      }
      return { captureRequested };
    },
    [applyReturnedActions, updateMessage]
  );

  // Non-streaming fallback for environments where the stream endpoint is
  // unavailable (older backend, proxy that buffers the response, etc.).
  const sendNonStreaming = useCallback(
    async (assistantId: string, payload: Record<string, unknown>, signal?: AbortSignal) => {
      const response = await fetch(`${API_BASE}/api/ai-command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "include",
        signal,
      });
      const data = await response.json();
      if (response.status === 401) {
        throw new AuthRequiredError(data.reply || "Sign in to use the assistant.");
      }
      if (response.status === 402) {
        throw new PlanLimitError(data.message || "You've reached today's message limit.");
      }
      if (!response.ok) throw new Error(data.reply || `HTTP ${response.status}`);
      const returnedActions: AIAction[] = Array.isArray(data.actions) ? data.actions : [];
      if (returnedActions.length) void applyReturnedActions(returnedActions);
      updateMessage(assistantId, (m) => ({
        ...m,
        content: data.reply ?? "Done.",
        status: undefined,
      }));
    },
    [applyReturnedActions, updateMessage]
  );

  const handleSend = useCallback(
    async (overrideText?: string) => {
      const text = (overrideText ?? input).trim();
      const outgoingAttachments = attachments;
      if ((!text && outgoingAttachments.length === 0) || loading) return;
      track("assistant_send_message");

      const conversation = messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .slice(-12)
        .map((message) => ({ role: message.role, content: message.content }));

      setInput("");
      setAttachments([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";

      // A new turn: pin to the bottom so the reply is visible as it starts.
      pinnedToBottomRef.current = true;

      const userId = makeId("user");
      const assistantId = makeId("assistant");

      setMessages((previous) => [
        ...previous,
        {
          id: userId,
          role: "user",
          content: text,
          timestamp: Date.now(),
          attachments: outgoingAttachments.length ? outgoingAttachments : undefined,
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          timestamp: Date.now(),
          streaming: true,
          status: "Thinking",
        },
      ]);
      setLoading(true);

      const images = outgoingAttachments
        .filter((item) => item.kind === "image" && item.dataUrl)
        .map((item) => item.dataUrl as string);

      const fileNames = outgoingAttachments
        .filter((item) => item.kind === "file")
        .map((item) => item.name);

      // Extracted document text rides inside the message so the model can
      // read what was attached and respond to its actual content.
      const documentExcerpts = outgoingAttachments
        .filter((item) => item.kind === "file" && item.textContent)
        .map((item) => `Content of attached document "${item.name}":\n${item.textContent}`);

      let composedMessage = text;
      if (fileNames.length) {
        composedMessage = `${composedMessage}\n\n[Attached files: ${fileNames.join(", ")}]`.trim();
      }
      if (documentExcerpts.length) {
        composedMessage = `${composedMessage}\n\n${documentExcerpts.join("\n\n")}`.trim();
      }

      // When screenshots are attached, include the color→organ legend so the
      // vision model can identify each colored region.
      const maskLegend =
        images.length && getMaskLegend ? getMaskLegend() : [];

      const payload: Record<string, unknown> = {
        message: composedMessage,
        conversation,
        case_id: caseId,
        session_id: sessionId ?? null,
        available_organs: availableOrgans,
        viewer_state: viewerState,
        organ_metrics: organMetrics,
        organ_references: organReferences,
        demographics,
        model: selectedModel || null,
        images,
        mask_legend: maskLegend,
        // Lets the backend's agent offer its capture_views tool; auto_captured
        // marks the follow-up request so capture is requested at most once.
        can_capture: !!captureViewport,
        auto_captured: false,
      };

      const controller = new AbortController();
      abortRef.current = controller;
      const isAbort = (e: unknown) =>
        e instanceof DOMException ? e.name === "AbortError" : (e as { name?: string })?.name === "AbortError";

      try {
        const first = await streamResponse(assistantId, payload, controller.signal);
        // Self-capture: the agent asked to SEE the views. Capture the four
        // panes right here in the browser and continue the same turn with the
        // images attached (the backend switches to the vision model).
        if (first.captureRequested && captureViewport && !controller.signal.aborted) {
          updateMessage(assistantId, (m) => ({ ...m, status: "Capturing the CT views" }));
          let shots: { name: string; dataUrl: string }[] = [];
          try {
            shots = await captureViewport();
          } catch (error) {
            console.error("[BodyMaps AI self-capture]", error);
          }
          if (shots.length) {
            // Transparency: show the shots the assistant took on the user's
            // message, exactly as if they had clicked the camera themselves.
            const shotAttachments: ChatAttachment[] = shots.map((shot) => ({
              id: makeId("shot"),
              name: `${shot.name} view`,
              kind: "image",
              dataUrl: shot.dataUrl,
              label: shot.name,
              source: "screenshot",
            }));
            updateMessage(userId, (m) => ({
              ...m,
              attachments: [...(m.attachments ?? []), ...shotAttachments],
            }));
          }
          updateMessage(assistantId, (m) => ({ ...m, status: "Reading the views" }));
          const followPayload: Record<string, unknown> = {
            ...payload,
            images: shots.map((shot) => shot.dataUrl),
            mask_legend: getMaskLegend ? getMaskLegend() : maskLegend,
            auto_captured: true,
          };
          await streamResponse(assistantId, followPayload, controller.signal);
        }
      } catch (streamError) {
        if (isAbort(streamError)) {
          // User pressed Stop — keep whatever was streamed, no error.
        } else if (streamError instanceof AuthRequiredError) {
          updateMessage(assistantId, (m) => ({
            ...m, content: streamError.message, status: undefined,
          }));
          promptAuth();
        } else if (streamError instanceof PlanLimitError) {
          // A spent allowance is an answer, not a transport failure: retrying
          // on the non-streaming endpoint would just be refused again.
          updateMessage(assistantId, (m) => ({
            ...m, content: streamError.message, status: undefined,
          }));
        } else {
          console.warn("[BodyMaps AI stream] falling back:", streamError);
          try {
            await sendNonStreaming(assistantId, payload, controller.signal);
          } catch (error) {
            if (error instanceof AuthRequiredError) {
              updateMessage(assistantId, (m) => ({
                ...m, content: error.message, status: undefined,
              }));
              promptAuth();
            } else if (error instanceof PlanLimitError) {
              updateMessage(assistantId, (m) => ({
                ...m, content: error.message, status: undefined,
              }));
            } else if (!isAbort(error)) {
              // Log BOTH failures: the streaming error is the real cause, and
              // the fallback error is usually just the same thing again.
              console.error("[BodyMaps AI] streaming endpoint failed:", streamError);
              console.error("[BodyMaps AI] fallback endpoint failed:", error);
              updateMessage(assistantId, (m) => ({
                ...m,
                content: m.content || describeSendFailure(streamError, images.length > 0),
                status: undefined,
              }));
            }
          }
        }
      } finally {
        updateMessage(assistantId, (m) => ({ ...m, streaming: false, status: undefined }));
        setLoading(false);
        abortRef.current = null;
      }
    },
    [
      input,
      attachments,
      loading,
      messages,
      promptAuth,
      caseId,
      sessionId,
      availableOrgans,
      viewerState,
      organMetrics,
      organReferences,
      demographics,
      selectedModel,
      getMaskLegend,
      streamResponse,
      sendNonStreaming,
      updateMessage,
    ]
  );

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  // The instant images are attached, the picker reflects the vision model —
  // that IS the model that will answer this message (backend switches too).
  const hasImageAttachments = attachments.some((att) => att.kind === "image");
  const effectiveModel =
    hasImageAttachments && visionModel ? visionModel : selectedModel;

  const modelLabel =
    modelState === "loading"
      ? "Loading models"
      : modelState === "fallback"
        ? "Local fallback"
        : effectiveModel || models[0]?.name || "Model";

  const canSend = !loading && (input.trim().length > 0 || attachments.length > 0);

  return (
    <aside
      id="bodymaps-ai-sidebar"
      className={open ? "ai-sidebar is-open" : "ai-sidebar"}
      aria-label="BodyMaps AI assistant"
      aria-hidden={!open}
    >
      {onResize && (
        <div
          className="ai-resize-handle"
          onPointerDown={startResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the AI panel"
          title="Drag to resize"
        />
      )}

      <header className="ai-sidebar__header">
        <div className="ai-sidebar__brand">
          <span className="ai-sidebar__mark">
            <BotIcon />
          </span>
          <span className="ai-sidebar__title">BodyMaps AI</span>
        </div>
        <button
          className="ai-sidebar__close"
          onClick={closeSidebar}
          aria-label="Close AI assistant"
          title="Close"
          type="button"
        >
          <CloseIcon />
        </button>
      </header>

      <div
        className="ai-sidebar__chat"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        ref={chatScrollRef}
        onScroll={handleChatScroll}
      >
        {messages.length === 0 && !loading && (
          <div className="ai-welcome">
            <span className="ai-welcome__mark">
              <BotIcon />
            </span>
            <h2 className="ai-welcome__title">BodyMaps AI</h2>
            <p className="ai-welcome__text">
              Ask me anything about this scan or medicine in general. Try “segment
              the liver and tell me its volume,” or attach a file and CT views.
            </p>
          </div>
        )}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="ai-msg ai-msg--user">
              {message.attachments && message.attachments.length > 0 && (
                <div className="ai-msg__attachments">
                  {message.attachments.map((att) =>
                    att.kind === "image" && att.dataUrl ? (
                      <img
                        key={att.id}
                        className="ai-attach-thumb"
                        src={att.dataUrl}
                        alt={att.name}
                        title={`${att.name} — click to enlarge`}
                        onClick={() => setLightboxUrl(att.dataUrl ?? null)}
                      />
                    ) : (
                      <span key={att.id} className="ai-attach-file" title={att.name}>
                        <span className="ai-attach-file__icon" data-type={fileTypeOf(att.name)}>
                          <AttachmentTypeIcon name={att.name} />
                        </span>
                        <span className="ai-attach-file__name">{att.name}</span>
                      </span>
                    )
                  )}
                </div>
              )}
              {message.content && (
                <div className="ai-msg__content">{renderMessageText(message.content)}</div>
              )}
            </div>
          ) : (
            <div key={message.id} className="ai-msg ai-msg--assistant">
              {message.status && !message.content && (
                <div className="ai-status" aria-live="polite">
                  <span className="ai-status__shimmer">{message.status}</span>
                  <span className="ai-status__dots">
                    <span className="ai-typing__dot" />
                    <span className="ai-typing__dot" />
                    <span className="ai-typing__dot" />
                  </span>
                </div>
              )}

              {message.content && (
                <div className="ai-msg__content">
                  {renderMessageText(message.content)}
                  {message.streaming && <span className="ai-caret" aria-hidden="true" />}
                </div>
              )}

              {!message.streaming && message.content.trim().length > 0 && (
                <div className="ai-msg__actions">
                  <button
                    className="ai-msg-action"
                    onClick={() => void handleCopy(message.id, message.content)}
                    aria-label="Copy response"
                    title={copiedId === message.id ? "Copied" : "Copy"}
                    type="button"
                  >
                    {copiedId === message.id ? <CheckIcon /> : <CopyIcon />}
                  </button>
                  <button
                    className="ai-msg-action"
                    data-active={speakingId === message.id}
                    onClick={() => handleSpeak(message.id, message.content)}
                    aria-label={speakingId === message.id ? "Stop reading" : "Read aloud"}
                    title={speakingId === message.id ? "Stop" : "Read aloud"}
                    type="button"
                  >
                    {speakingId === message.id ? <StopIcon /> : <SpeakerIcon />}
                  </button>
                </div>
              )}
            </div>
          )
        )}
        <div ref={chatEndRef} />
      </div>

      <div className="ai-sidebar__composer-wrap">
        {hasImageAttachments && !visionAvailable && (
          // Say this BEFORE the message is sent. Discovering that no vision
          // model exists only after the answer fails is the worst possible time.
          <div className="ai-composer__warning" role="status">
            No vision model is installed on the server, so these views can't be
            read. Run <code>ollama pull qwen3-vl:4b</code> on the backend host
            and restart it.
          </div>
        )}
        {attachments.length > 0 && (
          <div className="ai-composer__chips" aria-label="Attachments">
            {attachments.map((att) =>
              att.kind === "image" && att.dataUrl ? (
                // Compact thumbnail so the four captured views fit on one row.
                <span key={att.id} className="ai-thumb-chip" title={`${att.name} — click to enlarge`}>
                  <img
                    className="ai-thumb-chip__img"
                    src={att.dataUrl}
                    alt={att.name}
                    onClick={() => setLightboxUrl(att.dataUrl ?? null)}
                  />
                  <button
                    className="ai-thumb-chip__remove"
                    onClick={() => removeAttachment(att.id)}
                    aria-label={`Remove ${att.name}`}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </span>
              ) : (
                <span key={att.id} className="ai-chip" title={att.name}>
                  <span className="ai-chip__type" data-type={fileTypeOf(att.name)}>
                    <AttachmentTypeIcon name={att.name} />
                  </span>
                  <span className="ai-chip__label">{att.name}</span>
                  <button
                    className="ai-chip__remove"
                    onClick={() => removeAttachment(att.id)}
                    aria-label={`Remove ${att.name}`}
                    type="button"
                  >
                    <CloseIcon />
                  </button>
                </span>
              )
            )}
          </div>
        )}

        <div className="ai-composer">
          <textarea
            ref={textareaRef}
            className="ai-composer__textarea"
            rows={1}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask about this scan…"
            aria-label="Message BodyMaps AI"
          />

          <div className="ai-composer__footer">
            <div className="ai-composer__tools">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,.pdf,.nii,.nii.gz,.dcm"
                className="ai-hidden-file"
                onChange={handleFilePick}
                aria-hidden="true"
                tabIndex={-1}
              />
              {/* Attach stays usable while a reply is generating, so the next
                  message can be prepared without waiting. */}
              <button
                className="ai-tool-btn"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach a file"
                title="Attach image, PDF, or scan"
                type="button"
              >
                <PlusIcon />
              </button>
              {captureViewport && (
                <button
                  className="ai-tool-btn"
                  data-active={attachments.some((att) => att.source === "screenshot")}
                  onClick={() => void handleCapture()}
                  disabled={capturing}
                  aria-label={
                    attachments.some((att) => att.source === "screenshot")
                      ? "Remove the captured CT views"
                      : "Attach screenshots of the four CT views"
                  }
                  title={
                    attachments.some((att) => att.source === "screenshot")
                      ? "Remove the captured views"
                      : "Capture the four CT views"
                  }
                  type="button"
                >
                  <CameraIcon />
                </button>
              )}
            </div>

            <div className="ai-composer__right">
              <div ref={modelPickerRef} className="ai-model-picker">
                {modelMenuOpen && (
                  <div className="ai-model-menu ai-model-menu--right" role="menu" aria-label="Choose an Ollama model">
                    <div className="ai-model-menu__heading">Local models</div>
                    {hasImageAttachments && visionModel && (
                      <div className="ai-model-menu__note">
                        Images attached — {visionModel} will answer this message.
                      </div>
                    )}
                    {models.length > 0 ? (
                      models.map((model) => (
                        <button
                          key={model.name}
                          className="ai-model-menu__item"
                          data-selected={selectedModel === model.name}
                          onClick={() => selectModel(model.name)}
                          role="menuitemradio"
                          aria-checked={selectedModel === model.name}
                          type="button"
                        >
                          <span className="ai-model-menu__info">
                            <strong>{model.name}</strong>
                            <span className="ai-model-menu__desc">
                              {modelDescription(model.name)}
                            </span>
                          </span>
                          {selectedModel === model.name ? <CheckIcon /> : null}
                        </button>
                      ))
                    ) : (
                      <div className="ai-model-menu__empty">No Ollama models available</div>
                    )}
                  </div>
                )}
                <button
                  className="ai-model-picker__button"
                  data-state={modelState}
                  data-vision={hasImageAttachments && !!visionModel}
                  onClick={() => setModelMenuOpen((current) => !current)}
                  disabled={modelState === "loading"}
                  aria-haspopup="menu"
                  aria-expanded={modelMenuOpen}
                  title={
                    hasImageAttachments && visionModel
                      ? "Images attached — the vision model answers this message"
                      : "Choose the local model"
                  }
                  type="button"
                >
                  <span className="ai-model-picker__dot" aria-hidden="true" />
                  <span className="ai-model-picker__text">{modelLabel}</span>
                  <ChevronIcon />
                </button>
              </div>

              {loading ? (
                <button
                  className="ai-composer__send ai-composer__send--stop"
                  onClick={handleStop}
                  aria-label="Stop generating"
                  title="Stop"
                  type="button"
                >
                  <span className="ai-stop-square" aria-hidden="true" />
                </button>
              ) : (
                <button
                  className="ai-composer__send"
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                  aria-label="Send message"
                  type="button"
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Rendered through a portal to <body> so it fills the WHOLE screen. If it
          lived inside .ai-sidebar, that panel's backdrop-filter would make it the
          containing block for this position:fixed overlay and clip it to the
          sidebar. The portal escapes that. */}
      {lightboxUrl &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="ai-lightbox"
            onClick={() => setLightboxUrl(null)}
            role="dialog"
            aria-label="Enlarged image"
          >
            <img className="ai-lightbox__img" src={lightboxUrl} alt="Enlarged attachment" />
            <button
              className="ai-lightbox__close"
              onClick={() => setLightboxUrl(null)}
              aria-label="Close"
              type="button"
            >
              <CloseIcon />
            </button>
          </div>,
          document.body
        )}
    </aside>
  );
}
