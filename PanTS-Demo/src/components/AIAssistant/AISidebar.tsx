import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuth } from "../../contexts/authContext";
import { track } from "../../helpers/analytics";
import { API_BASE } from "../../helpers/constants";
import { scrollBehavior } from "../../helpers/motion";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { escapeWasUsed, markEscapeUsed } from "../../helpers/viewer/escapeUsed";
import type {
  AIAction,
  AISidebarProps,
  ChatAttachment,
  ChatMessage,
} from "./types";
import { useAIModels } from "./useAIModels";
import "./AISidebar.css";

// The plan's daily message allowance is spent (HTTP 402). Distinguished from a
// transport error so the streaming path doesn't retry on the non-streaming one,
// which would be refused for the same reason.
class PlanLimitError extends Error {}

// Signed out (HTTP 401). The assistant needs an account, same as inference.
// Also its own type, for the same no-pointless-retry reason.
class AuthRequiredError extends Error {}

// Turn a send failure into plain wording for the person reading it.
//
// They have no server to check, so the URL, the HTTP status and the dev hints
// stay out of the bubble: the catch that calls this logs both failures with
// console.error, which is where whoever runs the backend looks.
export function describeSendFailure(error: unknown, hadImages: boolean, uploadedImages = 0, totalImages = 0): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");

  // fetch() rejects with a TypeError when it never reached a server at all.
  if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(raw)) {
    console.error(`[BodyMaps AI] could not reach ${API_BASE}; check the server is running and VITE_API_BASE points at it`);
    return "I couldn't reach the server. Check your connection and try again.";
  }

  const status = /HTTP (\d{3})/.exec(raw)?.[1];
  // A photo or report the person uploaded is not a CT view: only captures are.
  const imageNoun = uploadedImages > 0 && uploadedImages === totalImages ? "images" : "views";

  if (status === "413") {
    // A photo from the Attach button is the likely culprit when there is one:
    // telling them to attach fewer panes would send them the wrong way. With
    // several images each one can be small and the total is what is too big.
    if (uploadedImages > 0 && totalImages > 1) return "Those images are too large together. Attach fewer or smaller ones.";
    if (uploadedImages > 0) return "That image is too large. Attach a smaller one.";
    return "The captured views were too large for the server to accept. Try attaching fewer panes.";
  }

  if (status && status.startsWith("5")) {
    console.error(`[BodyMaps AI] server error HTTP ${status}; the Flask terminal has the traceback`);
    return hadImages
      ? `Something went wrong on our side reading the attached ${imageNoun}. Try again in a moment.`
      : "Something went wrong on our side. Try again in a moment.";
  }

  if (hadImages) {
    console.error(`[BodyMaps AI] reading the attached ${imageNoun} failed; image reading may not be set up on this server`);
    return `I couldn't read the attached ${imageNoun}. Try again in a moment, or ask without them.`;
  }

  return "The assistant didn't return an answer. Viewer controls still work from the top panel.";
}

// The model was offline and nothing measured stands in for its answer, so the
// reply is an apology that offers a retry rather than something the assistant
// said. Measured facts the server could still answer from are kept as a reply.
function isUnansweredOffline(source: unknown, grounded: unknown): boolean {
  return (source === "rule_fallback" || source === "vision_model_unavailable") && !grounded;
}

// A phone focusing the textarea opens the on-screen keyboard over the chat.
function isTouchKeyboardLikely(): boolean {
  return !!window.matchMedia?.("(pointer: coarse), (max-width: 480px)")?.matches;
}

// The server reads at most this many images per message (OLLAMA_MAX_IMAGES).
const MAX_ATTACHED_IMAGES = 4;
const IMAGE_LIMIT_NOTICE = `Only ${MAX_ATTACHED_IMAGES} images can be read at once. Remove one to add another.`;

// The 3D layout hides the slice panes, and the snapshots never include the 3D
// pane, so a capture there is empty however long the scan has been loaded.
const CAPTURE_NEEDS_SLICES = "Capture works on the slice views. Switch to MPR or a single slice view.";

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

// A photo or screenshot of a report can be several MB, and the server refuses a
// request body over 2 MB, so an attached image is shrunk the way the CT
// captures are: longest side to 1024 px, re-encoded as JPEG. A small image is
// kept as it is, but only a small one: several photos that are each under the
// limit still add up, so the threshold is low enough that a few of them fit.
// An image the browser cannot decode (a TIFF, or a HEIC where it is not
// supported) rejects, so the caller attaches it as a named file with the
// "can't read" warning instead of a broken thumbnail the server would refuse.
// If it cannot draw the canvas it keeps the original.
const UPLOAD_IMAGE_MAX_EDGE = 1024;
const UPLOAD_IMAGE_KEEP_BYTES = 150 * 1024;

function downscaleUploadedImage(file: File, dataUrl: string): Promise<string> {
  const small = file.size <= UPLOAD_IMAGE_KEEP_BYTES;
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (small) {
      // A small image is kept as it is, but still has to decode.
      if (typeof img.decode !== "function") return resolve(dataUrl);
      img.src = dataUrl;
      img.decode().then(() => resolve(dataUrl), reject);
      return;
    }
    img.onload = () => {
      const scale = Math.min(1, UPLOAD_IMAGE_MAX_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(dataUrl);
      // JPEG has no alpha: paint white first so a transparent PNG does not
      // turn black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => reject(new Error("The image could not be decoded."));
    img.src = dataUrl;
  });
}

// Cap on extracted document text sent to the model — keeps the prompt inside
// the local model's context window (roughly 1.5k tokens of document).
const PDF_TEXT_LIMIT = 6000;

// Extract the text layer of an attached PDF in the browser, so the model can
// actually read the document instead of only seeing its filename. Returns null
// for scanned/image-only PDFs (no text layer) and on any parse failure. It also
// says whether the document was cut at the page or character cap, so the
// composer can tell the person the rest will not be read.
async function extractPdfText(
  file: File
): Promise<{ text: string; truncated: boolean; pagesRead: number } | null> {
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
      let truncated = doc.numPages > maxPages;
      let pagesRead = 0;
      let text = "";
      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        if (text.length >= PDF_TEXT_LIMIT) {
          truncated = true;
          break;
        }
        const page = await doc.getPage(pageNum);
        const content = await page.getTextContent();
        const pageText = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (pageText) text += pageText + "\n";
        if (text.length <= PDF_TEXT_LIMIT) pagesRead = pageNum;
      }
      const trimmed = text.trim();
      if (trimmed.length > PDF_TEXT_LIMIT) truncated = true;
      return trimmed ? { text: trimmed.slice(0, PDF_TEXT_LIMIT), truncated, pagesRead } : null;
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

// What the model is sent for one user turn: the typed text, the names of any
// attached files, and the extracted text of attached documents. Sent for the
// turn itself and again in the history, so a follow-up question can still be
// answered from the document.
function composeTurn(text: string, attachments: ChatAttachment[]): string {
  const fileNames = attachments.filter((item) => item.kind === "file").map((item) => item.name);
  const documentExcerpts = attachments
    .filter((item) => item.kind === "file" && item.textContent)
    .map((item) => `Content of attached document "${item.name}":\n${item.textContent}`);
  let composed = text;
  if (fileNames.length) {
    composed = `${composed}\n\n[Attached files: ${fileNames.join(", ")}]`.trim();
  }
  if (documentExcerpts.length) {
    composed = `${composed}\n\n${documentExcerpts.join("\n\n")}`.trim();
  }
  return composed;
}

// A past turn as the model sees it in the history. Screenshots are not sent
// again with a follow-up, so the turn says they were there rather than leaving
// the model to answer as if nothing had been attached.
function composeHistoryTurn(message: ChatMessage): string {
  if (message.role !== "user" || !message.attachments?.length) return message.content;
  const composed = composeTurn(message.content, message.attachments);
  const views = message.attachments.filter((item) => item.kind === "image").length;
  return views
    ? `${composed}\n\n[${views} image${views === 1 ? " was" : "s were"} attached to this earlier message and ${views === 1 ? "is" : "are"} not attached again]`.trim()
    : composed;
}

// The last 12 turns of a thread for the history. The latest turn carrying a
// document stays in even once it is older than that (in place of the oldest
// kept turn), so a long thread can still be questioned about the document.
function recentHistory(turns: ChatMessage[], size = 12): ChatMessage[] {
  const recent = turns.slice(-size);
  const hasDocument = (message: ChatMessage) =>
    message.role === "user" && !!message.attachments?.some((item) => item.kind === "file" && item.textContent);
  if (recent.some(hasDocument)) return recent;
  const older = turns.slice(0, -size).filter(hasDocument);
  return older.length ? [older[older.length - 1], ...turns.slice(-(size - 1))] : recent;
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

// The reply as plain text, for the clipboard and the speech engine, which
// should not carry the ** markers renderMessageText turns into bold.
function plainText(content: string) {
  return content.replace(/\*\*([^*]+)\*\*/g, "$1");
}

type StreamEvent =
  | { type: "status"; text?: string }
  | { type: "thinking"; delta?: string }
  | { type: "reply"; delta?: string }
  | { type: "actions"; actions?: AIAction[] }
  | { type: "final"; reply?: string; actions?: AIAction[]; source?: string; model?: string | null; grounded?: boolean; truncated?: boolean }
  | { type: "done" }
  | { type: "error"; message?: string }
  // The agent decided it needs to SEE the CT views: the browser captures the
  // slice panes and re-sends this turn with the images attached (self-capture).
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
  // Read by the async attach paths, which finish after the render that started them.
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  // Files still being read (a long PDF takes seconds). Send waits for them,
  // or the file would land in the composer after the turn it was meant for.
  const [pendingFiles, setPendingFiles] = useState<{ id: string; name: string }[]>([]);
  // Bumped when the composer is emptied by a send or a case change: a read
  // that finishes after that belongs to the old composer and is dropped.
  const composerGenerationRef = useRef(0);
  // Why the camera attached nothing; cleared on the next attach or send.
  const [captureNotice, setCaptureNotice] = useState("");
  const {
    models, selectedModel, visionModel, visionAvailable, modelState, modelIssue,
    refreshingModels, refreshModels, selectModel: chooseModel,
  } = useAIModels(open);
  // The assistant is open to everyone — no sign-in required. promptAuth is
  // kept only to handle a 401 from an older backend that still gates it.
  const { promptAuth } = useAuth();

  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copyFailedId, setCopyFailedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // The Send button, which React reuses as Stop while a reply is generating.
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  // The Attach button stays mounted and enabled, so touch devices can park focus
  // on it when a control unmounts without opening the keyboard.
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  // True while focus sits on the Send/Stop button, or was dropped from it when
  // React swapped the button. Any focus or click elsewhere clears it.
  const focusOnSendRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The newest getMaskLegend: handleSend's own copy is from send time, and the
  // assistant's viewer actions change what is on screen before it captures.
  const getLegendRef = useRef(getMaskLegend);
  getLegendRef.current = getMaskLegend;
  const viewerStateRef = useRef(viewerState);
  viewerStateRef.current = viewerState;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Set once the stream has delivered model text: the server has counted the
  // turn by then, so a dropped connection is not retried on /ai-command.
  const replyStartedRef = useRef(false);

  // The enlarged image is modal: focus moves to its Close button and returns
  // to the thumbnail afterwards. Escape is handled by the sidebar's own key
  // listener below (lightbox first, then the model menu, then the panel).
  useDialogFocus(Boolean(lightboxUrl), lightboxRef);
  // Whether the chat is scrolled to (near) the bottom. Only auto-scroll when it
  // is, so scrolling up to read during generation isn't yanked back down.
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    // Whatever opened the panel (the toolbar's AI button) gets focus back when
    // it closes. The panel hides with focus inside it, which would otherwise
    // drop focus to the page.
    const active = document.activeElement;
    const opener =
      active instanceof HTMLElement && active !== document.body && !asideRef.current?.contains(active)
        ? active
        : null;
    setModelMenuOpen(false);
    // A touch device would raise the keyboard over the chat, so it is left
    // down: whoever reopens the panel may only be re-reading an answer. Focus
    // still moves into the panel, to Close, so Tab does not carry on through
    // the page behind it.
    const focusTimer = window.setTimeout(() => {
      if (isTouchKeyboardLikely()) closeButtonRef.current?.focus({ preventScroll: true });
      else textareaRef.current?.focus();
    }, 180);
    // Where focus last went while the panel was open. Focus that is dropped
    // to the page when a node is removed fires no focusin, so this still says
    // where it was: the panel, or something else, like the HD loading dialog
    // that closes in the same commit and returns focus to its own opener.
    let lastFocusInPanel = false;
    const trackFocus = (e: FocusEvent) => {
      lastFocusInPanel = !!asideRef.current?.contains(e.target as Node);
    };
    document.addEventListener("focusin", trackFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("focusin", trackFocus);
      // Only while focus is still in the panel, or was in it when it dropped
      // to the page: if the person has moved on to another control, or to
      // another dialog, leave it there.
      const now = document.activeElement;
      const inPanel = !!now && !!asideRef.current?.contains(now);
      const droppedFromPanel = (!now || now === document.body) && lastFocusInPanel;
      if (opener?.isConnected && (inPanel || droppedFromPanel)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    abortRef.current?.abort();
    // The old case's reply must not keep being read out, and the composer goes
    // back to one line: its inline height was set by the draft that just cleared.
    window.speechSynthesis?.cancel();
    setSpeakingId(null);
    composerGenerationRef.current += 1;
    setPendingFiles([]);
    setCapturing(false);
    setMessages([]);
    setInput("");
    setAttachments([]);
    setCaptureNotice("");
    setModelMenuOpen(false);
    setLightboxUrl(null);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [caseId, sessionId]);

  // Once the person has switched out of 3D, the advice to do so is done with.
  useEffect(() => {
    if (viewerState.view !== "3d") {
      setCaptureNotice((notice) => (notice === CAPTURE_NEEDS_SLICES ? "" : notice));
    }
  }, [viewerState.view]);

  // Auto-scroll to the newest content ONLY when the user is already near the
  // bottom. If they've scrolled up to read, leave them where they are.
  useEffect(() => {
    if (pinnedToBottomRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "end" });
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

  // The menu's items unmount when it closes. If one of them had focus, it
  // goes back to the model button instead of falling to the page.
  const closeModelMenu = useCallback(() => {
    const menuHadFocus = !!document.activeElement?.closest("#ai-model-menu");
    setModelMenuOpen(false);
    if (menuHadFocus) modelButtonRef.current?.focus();
  }, []);

  // The items render before the model button, so Tab from the button would
  // skip them: when the menu opens, focus goes to the picked model (or the
  // first one) and Tab walks the list from there.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const items = Array.from(
      document.querySelectorAll<HTMLButtonElement>("#ai-model-menu .ai-model-menu__item"),
    );
    (items.find((item) => item.getAttribute("aria-pressed") === "true") ?? items[0])?.focus();
  }, [modelMenuOpen]);

  // Tabbing out of the picker closes the menu rather than leaving it open over
  // the composer.
  const handleModelPickerBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (modelMenuOpen && next instanceof Node && !event.currentTarget.contains(next)) {
      setModelMenuOpen(false);
    }
  };

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
      // Escape that cancels an IME candidate list is not a close, the same as
      // Enter that confirms one is not a send (see handleKeyDown).
      if (event.isComposing || event.keyCode === 229) return;
      // A flyout, popover or class editor over the panel takes its own
      // Escape first, and so does a modal dialog elsewhere on the page (the
      // reading-session summary): the next Escape is the sidebar's.
      if (escapeWasUsed(event)) return;
      const modal = (event.target as Element | null)?.closest?.('[role="dialog"][aria-modal="true"]');
      if (modal && modal !== lightboxRef.current && !modal.closest(".ai-sidebar")) return;
      // One Escape, one thing: closing here doesn't also disarm a viewer tool.
      markEscapeUsed(event);
      // Innermost layer first: the full-screen lightbox sits above the
      // sidebar, so Escape must dismiss it before closing anything else.
      if (lightboxUrl) setLightboxUrl(null);
      else if (modelMenuOpen) closeModelMenu();
      else closeSidebar();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [closeModelMenu, closeSidebar, lightboxUrl, modelMenuOpen, open]);

  const selectModel = (value: string) => {
    chooseModel(value);
    closeModelMenu();
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
        case "get_smallest_structure":
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
    const generation = composerGenerationRef.current;
    const reading = list.map((file) => ({ id: makeId("read"), name: file.name }));
    setPendingFiles((previous) => [...previous, ...reading]);
    const next: ChatAttachment[] = [];
    try {
      for (const file of list) {
        if (file.type.startsWith("image/")) {
          try {
            const dataUrl = await downscaleUploadedImage(file, await readFileAsDataURL(file));
            next.push({ id: makeId("att"), name: file.name, kind: "image", dataUrl, source: "upload" });
          } catch {
            next.push({ id: makeId("att"), name: file.name, kind: "file", source: "upload" });
          }
        } else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          // Pull the PDF's text so the model can read the document and react to
          // its content (and ask follow-ups), not just see a filename.
          const extracted = await extractPdfText(file);
          next.push({
            id: makeId("att"),
            name: file.name,
            kind: "file",
            source: "upload",
            textContent: extracted?.text,
            truncated: extracted?.truncated || undefined,
            pagesRead: extracted?.truncated ? extracted.pagesRead : undefined,
          });
        } else {
          next.push({ id: makeId("att"), name: file.name, kind: "file", source: "upload" });
        }
      }
    } finally {
      if (generation === composerGenerationRef.current) {
        const done = new Set(reading.map((item) => item.id));
        setPendingFiles((previous) => previous.filter((item) => !done.has(item.id)));
      }
    }
    if (generation !== composerGenerationRef.current) return;
    // The server reads four images; one more would be shown here and never sent.
    let room = MAX_ATTACHED_IMAGES - attachmentsRef.current.filter((att) => att.kind === "image").length;
    const accepted = next.filter((att) => att.kind !== "image" || room-- > 0);
    if (accepted.length < next.length) setCaptureNotice(IMAGE_LIMIT_NOTICE);
    if (accepted.length) {
      attachmentsRef.current = [...attachmentsRef.current, ...accepted];
      setAttachments((previous) => [...previous, ...accepted]);
    }
  }, []);

  // A file dropped anywhere on the panel is attached; without this the browser
  // opens it in the tab and the viewer and the conversation are lost.
  const handleDragOver = (event: React.DragEvent) => {
    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
  };
  const handleDrop = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
  };

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
      // That frees room, so a "too many images" warning no longer holds.
      setCaptureNotice((notice) => (notice === IMAGE_LIMIT_NOTICE ? "" : notice));
      return;
    }
    setCaptureNotice("");
    setCapturing(true);
    const generation = composerGenerationRef.current;
    try {
      const shots = await captureViewport();
      // Send or a case change emptied the composer while the views were being taken.
      if (generation !== composerGenerationRef.current) return;
      if (!shots.length) {
        setCaptureNotice(
          viewerStateRef.current.view === "3d"
            ? CAPTURE_NEEDS_SLICES
            : "No views to capture yet. Wait for the scan to finish loading.",
        );
        return;
      }
      // The legend describes what these pictures show, so it is read now and
      // not at send time, when the person may have hidden or isolated an organ.
      const legend = getLegendRef.current ? getLegendRef.current() : [];
      const next: ChatAttachment[] = shots.map((shot) => ({
        id: makeId("shot"),
        name: `${shot.name} view`,
        kind: "image",
        dataUrl: shot.dataUrl,
        label: shot.name,
        source: "screenshot",
        legend,
      }));
      if (attachmentsRef.current.filter((att) => att.kind === "image").length + next.length > MAX_ATTACHED_IMAGES) {
        setCaptureNotice(IMAGE_LIMIT_NOTICE);
        return;
      }
      attachmentsRef.current = [...attachmentsRef.current, ...next];
      setAttachments((previous) => [...previous, ...next]);
    } catch (error) {
      console.error("[BodyMaps AI capture error]", error);
      if (generation === composerGenerationRef.current) {
        setCaptureNotice("The views could not be captured. Try again in a moment.");
      }
    } finally {
      if (generation === composerGenerationRef.current) setCapturing(false);
    }
  }, [captureViewport, capturing, attachments]);

  // Focus the textarea, except where that would open a touch keyboard: there it
  // goes to `touchTarget`, a control that stays mounted.
  const keepFocusInComposer = useCallback((touchTarget: HTMLElement | null) => {
    if (isTouchKeyboardLikely()) touchTarget?.focus({ preventScroll: true });
    else textareaRef.current?.focus();
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((previous) => previous.filter((item) => item.id !== id));
    setCaptureNotice((notice) => (notice === IMAGE_LIMIT_NOTICE ? "" : notice));
    // The focused Remove button unmounts with its chip; keep focus in the
    // composer, on a touch device on a button so no keyboard covers the chips.
    keepFocusInComposer(attachButtonRef.current);
  };

  // ---- Copy / read aloud (per assistant message) ---------------------------

  const handleCopy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFailedId(null);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1400);
    } catch (error) {
      console.error("[BodyMaps AI copy error]", error);
      // A webview or a blocked permission: say so instead of a dead click.
      setCopiedId(null);
      setCopyFailedId(id);
      window.setTimeout(() => setCopyFailedId((current) => (current === id ? null : current)), 2400);
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
      // A reply still on its way must not run actions or take pictures on
      // whatever page is open next. The send path treats an abort as a stop.
      abortRef.current?.abort();
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
            if (event.delta) replyStartedRef.current = true;
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
              // The model was offline: the text says so and offers a retry,
              // so the reply gets the Try again button like any failed send.
              // Measured facts the server could still answer from are kept
              // as a normal reply.
              // A stream that died part-way sends the text it had; it stays on
              // screen, but it is marked failed so Try again appears.
              const unanswered =
                isUnansweredOffline(event.source, event.grounded) || event.truncated === true;
              // The server counts a turn once its first text is sent, so a
              // later drop must not be sent again on the other endpoint.
              if (event.source === "ollama") replyStartedRef.current = true;
              updateMessage(assistantId, (m) => ({
                ...m,
                content: event.reply as string,
                status: undefined,
                ...(unanswered ? { failed: true } : {}),
              }));
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
              failed: true,
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
        ...(isUnansweredOffline(data.source, data.grounded) ? { failed: true } : {}),
      }));
    },
    [applyReturnedActions, updateMessage]
  );

  // Send turns into Stop and back into a disabled Send on the same button, so a
  // keyboard press leaves focus on a control that does nothing. Hand it back to
  // the composer, unless focus has gone somewhere else on purpose (a click on
  // the viewer leaves it on the page body, where the viewer's keys must keep
  // working) or a touch keyboard would pop up.
  const restoreComposerFocus = useCallback(() => {
    if (!openRef.current) return;
    const active = document.activeElement;
    const stillOnSend = active === sendButtonRef.current;
    const droppedFromSend = active === document.body && focusOnSendRef.current;
    if (!stillOnSend && !droppedFromSend) return;
    if (isTouchKeyboardLikely()) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  // Follows whether focus is still the Send/Stop button's, so a body focus at
  // the end of a reply can be told apart from focus that was dropped there by
  // the button being replaced.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      focusOnSendRef.current = e.target === sendButtonRef.current;
    };
    // A press on Send counts as focus on it: Safari does not focus a clicked
    // button, so focus is already on the page body when the reply finishes.
    const onPointerDown = (e: PointerEvent) => {
      const button = sendButtonRef.current;
      focusOnSendRef.current = !!button && (e.target === button || button.contains(e.target as Node));
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  const handleSend = useCallback(
    async (overrideText?: string, retry?: { attachments?: ChatAttachment[]; replaceIds: string[] }) => {
      const text = (overrideText ?? input).trim();
      const outgoingAttachments = retry ? retry.attachments ?? [] : attachments;
      if ((!text && outgoingAttachments.length === 0) || loading) return;
      // Enter reaches here while a file is still being read; the send would
      // leave it behind and it would show up under this turn afterwards.
      if (!retry && (pendingFiles.length > 0 || capturing)) return;
      track("assistant_send_message");
      setCaptureNotice("");

      // A retry replaces the failed turn, so the failed pair is neither
      // history for the model nor left on screen above the new attempt.
      const replaced = new Set(retry?.replaceIds ?? []);
      const conversation = recentHistory(
        messages
          .filter((message) => !replaced.has(message.id))
          .filter((message) => message.role === "user" || message.role === "assistant")
          // A failed reply is an error message, not something the assistant said.
          .filter((message) => !(message.role === "assistant" && message.failed)),
      ).map((message) => ({ role: message.role, content: composeHistoryTurn(message) }));

      // Try again leaves whatever is being typed in the composer alone.
      if (!retry) {
        composerGenerationRef.current += 1;
        setInput("");
        setAttachments([]);
        if (textareaRef.current) textareaRef.current.style.height = "auto";
      }

      // A new turn: pin to the bottom so the reply is visible as it starts.
      pinnedToBottomRef.current = true;

      const userId = makeId("user");
      const assistantId = makeId("assistant");

      setMessages((previous) => [
        ...previous.filter((message) => !replaced.has(message.id)),
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

      // Viewer screenshots go first and uploaded photos after them, so the
      // server can tell which are which from a count.
      const imageAttachments = outgoingAttachments.filter((item) => item.kind === "image" && item.dataUrl);
      const screenshotAttachments = imageAttachments.filter((item) => item.source !== "upload");
      const uploadAttachments = imageAttachments.filter((item) => item.source === "upload");
      const images = [...screenshotAttachments, ...uploadAttachments].map((item) => item.dataUrl as string);
      const uploadedImages = uploadAttachments.length;

      // Extracted document text rides inside the message so the model can
      // read what was attached and respond to its actual content.
      const composedMessage = composeTurn(text, outgoingAttachments);

      // When screenshots are attached, include the color→organ legend so the
      // vision model can identify each colored region. It is the one taken with
      // the screenshots; an uploaded photo has no mask colors, so it gets none.
      const maskLegend = screenshotAttachments.length
        ? screenshotAttachments.find((item) => item.legend)?.legend ?? (getMaskLegend ? getMaskLegend() : [])
        : [];

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
        uploaded_images: uploadedImages,
        mask_legend: maskLegend,
        // Lets the backend's agent offer its capture_views tool; auto_captured
        // marks the follow-up request so capture is requested at most once.
        can_capture: !!captureViewport,
        auto_captured: false,
      };

      replyStartedRef.current = false;
      // The payload last sent to the stream: after a self-capture it is the
      // follow-up with the views, which a fallback must send again, not the
      // first request without them.
      let activePayload = payload;
      const sentImageCount = () => (activePayload.images as string[]).length;
      const sentUploadedCount = () => activePayload.uploaded_images as number;
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
          if (!shots.length) {
            // Nothing was captured (the panes are hidden, the engine is not
            // ready, or it threw). Sending the follow-up would answer from
            // measurements alone while claiming to have looked, so say so. A
            // Stop pressed meanwhile is left to the finally block ("Stopped.").
            if (!controller.signal.aborted) {
              updateMessage(assistantId, (m) => ({
                ...m,
                content: `I couldn't capture the CT views, so I can't look at them. ${
                  viewerStateRef.current.view === "3d"
                    ? CAPTURE_NEEDS_SLICES
                    : "Wait for the scan to finish loading and try again."
                }`,
                status: undefined,
                failed: true,
              }));
            }
            return;
          }
          const capturedLegend = getLegendRef.current ? getLegendRef.current() : maskLegend;
          // Transparency: show the shots the assistant took on the user's
          // message, exactly as if they had clicked the camera themselves.
          const shotAttachments: ChatAttachment[] = shots.map((shot) => ({
            id: makeId("shot"),
            name: `${shot.name} view`,
            kind: "image",
            dataUrl: shot.dataUrl,
            label: shot.name,
            source: "screenshot",
            legend: capturedLegend,
          }));
          updateMessage(userId, (m) => ({
            ...m,
            attachments: [...(m.attachments ?? []), ...shotAttachments],
          }));
          updateMessage(assistantId, (m) => ({ ...m, status: "Reading the views" }));
          const followPayload: Record<string, unknown> = {
            ...payload,
            images: shots.map((shot) => shot.dataUrl),
            viewer_state: viewerStateRef.current,
            uploaded_images: 0,
            mask_legend: capturedLegend,
            auto_captured: true,
          };
          activePayload = followPayload;
          await streamResponse(assistantId, followPayload, controller.signal);
        }
      } catch (streamError) {
        if (isAbort(streamError)) {
          // User pressed Stop — keep whatever was streamed, no error.
        } else if (streamError instanceof AuthRequiredError) {
          updateMessage(assistantId, (m) => ({
            ...m, content: streamError.message, status: undefined, failed: true,
          }));
          promptAuth();
        } else if (streamError instanceof PlanLimitError) {
          // A spent allowance is an answer, not a transport failure: retrying
          // on the non-streaming endpoint would just be refused again.
          updateMessage(assistantId, (m) => ({
            ...m, content: streamError.message, status: undefined,
          }));
        } else if (replyStartedRef.current) {
          // The answer had started when the connection dropped, and the server
          // already counted it. Asking /ai-command again would count the same
          // question twice, so keep what arrived and offer Try again.
          console.warn("[BodyMaps AI stream] dropped after the reply started:", streamError);
          updateMessage(assistantId, (m) => ({ ...m, status: undefined, failed: true }));
        } else {
          console.warn("[BodyMaps AI stream] falling back:", streamError);
          try {
            await sendNonStreaming(assistantId, activePayload, controller.signal);
          } catch (error) {
            if (error instanceof AuthRequiredError) {
              updateMessage(assistantId, (m) => ({
                ...m, content: error.message, status: undefined, failed: true,
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
                content: m.content || describeSendFailure(streamError, sentImageCount() > 0, sentUploadedCount(), sentImageCount()),
                status: undefined,
                failed: true,
              }));
            }
          }
        }
      } finally {
        // A turn that ends with no text (Stop pressed early, or a stream that
        // closed without a reply) still gets a line and Try again, which puts
        // the question and its views back: the composer was cleared on send.
        const stopped = controller.signal.aborted;
        updateMessage(assistantId, (m) =>
          m.content.trim()
            ? { ...m, streaming: false, status: undefined }
            : {
                ...m,
                content: stopped ? "Stopped." : describeSendFailure(undefined, sentImageCount() > 0, sentUploadedCount(), sentImageCount()),
                streaming: false,
                status: undefined,
                failed: true,
              }
        );
        setLoading(false);
        abortRef.current = null;
        restoreComposerFocus();
      }
    },
    [
      input,
      attachments,
      pendingFiles,
      capturing,
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
      restoreComposerFocus,
    ]
  );

  // Sends the turn before a failed reply again, in place of the failed pair.
  const handleRetry = useCallback(
    (assistantId: string) => {
      const index = messages.findIndex((message) => message.id === assistantId);
      const asked = index > 0 ? messages[index - 1] : undefined;
      if (!asked || asked.role !== "user") return;
      // The focused Try again button unmounts with the failed pair; on a touch
      // device park focus on Send/Stop so no keyboard covers the reply.
      const sendButton = sendButtonRef.current;
      keepFocusInComposer(sendButton && !sendButton.disabled ? sendButton : attachButtonRef.current);
      void handleSend(asked.content, { attachments: asked.attachments, replaceIds: [asked.id, assistantId] });
    },
    [messages, handleSend, keepFocusInComposer]
  );

  const handleStop = useCallback(() => {
    if (document.activeElement === sendButtonRef.current) focusOnSendRef.current = true;
    abortRef.current?.abort();
    restoreComposerFocus();
  }, [restoreComposerFocus]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME candidate is not a send.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  // The instant images are attached, the picker reflects the vision model —
  // that IS the model that will answer this message (backend switches too).
  const hasImageAttachments = attachments.some((att) => att.kind === "image");
  const onlyUploadedImages = attachments.every((att) => att.kind !== "image" || att.source === "upload");
  const imageModelAnswers = hasImageAttachments && !!visionModel && visionAvailable;
  const effectiveModel = imageModelAnswers ? visionModel : selectedModel;

  const modelLabel =
    modelState === "loading"
      ? "Loading models"
      : modelState === "fallback"
        ? "Local fallback"
        : effectiveModel || models[0]?.name || "Model";

  // Files the assistant gets only the name of (no text layer, or no reader),
  // worked out from what is attached so it goes when the chip does.
  const unreadableNames = attachments
    .filter((att) => att.kind === "file" && !att.textContent)
    .map((att) => att.name);

  // Long PDFs are cut before they are sent, so say so before the question goes.
  const cutDocuments = attachments.filter((att) => att.kind === "file" && att.truncated);

  const canSend =
    !loading &&
    pendingFiles.length === 0 &&
    !capturing &&
    (input.trim().length > 0 || attachments.length > 0);
  const canSpeak = typeof window !== "undefined" && "speechSynthesis" in window;

  return (
    <aside
      ref={asideRef}
      id="bodymaps-ai-sidebar"
      className={open ? "ai-sidebar is-open" : "ai-sidebar"}
      aria-label="BodyMaps AI assistant"
      aria-hidden={!open}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
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
          ref={closeButtonRef}
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
                      <button
                        key={att.id}
                        type="button"
                        className="ai-thumb-button"
                        onClick={() => setLightboxUrl(att.dataUrl ?? null)}
                        aria-label={`Enlarge ${att.name}`}
                        title={`${att.name}: click to enlarge`}
                      >
                        <img className="ai-attach-thumb" src={att.dataUrl} alt="" />
                      </button>
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
                    onClick={() => void handleCopy(message.id, plainText(message.content))}
                    aria-label={
                      copiedId === message.id
                        ? "Copied"
                        : copyFailedId === message.id
                          ? "Couldn't copy"
                          : "Copy response"
                    }
                    title={
                      copiedId === message.id ? "Copied" : copyFailedId === message.id ? "Couldn't copy" : "Copy"
                    }
                    type="button"
                  >
                    {copiedId === message.id ? (
                      <CheckIcon />
                    ) : copyFailedId === message.id ? (
                      <CloseIcon />
                    ) : (
                      <CopyIcon />
                    )}
                  </button>
                  <span className="sr-only" role="status">
                    {copiedId === message.id
                      ? "Copied to clipboard"
                      : copyFailedId === message.id
                        ? "Couldn't copy. Select the text and copy it instead."
                        : ""}
                  </span>
                  {canSpeak && (
                    <button
                      className="ai-msg-action"
                      data-active={speakingId === message.id}
                      onClick={() => handleSpeak(message.id, plainText(message.content))}
                      aria-label={speakingId === message.id ? "Stop reading" : "Read aloud"}
                      title={speakingId === message.id ? "Stop" : "Read aloud"}
                      type="button"
                    >
                      {speakingId === message.id ? <StopIcon /> : <SpeakerIcon />}
                    </button>
                  )}
                  {/* Only the latest reply: an older retry would land below the turns after it. */}
                  {message.failed && message.id === messages[messages.length - 1]?.id && (
                    <button
                      className="ai-msg-retry"
                      onClick={() => handleRetry(message.id)}
                      disabled={loading}
                      type="button"
                    >
                      Try again
                    </button>
                  )}
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
            Image reading isn't set up on this server, so these{" "}
            {onlyUploadedImages ? "images" : "views"} can't be read. Ask whoever
            runs the server to turn it on, or send your question without them.
          </div>
        )}
        {captureNotice && (
          <div className="ai-composer__warning" role="status">
            {captureNotice}
          </div>
        )}
        {cutDocuments.map((att) => (
          <div key={att.id} className="ai-composer__warning" role="status">
            {att.pagesRead
              ? `Only the first ${att.pagesRead === 1 ? "page" : `${att.pagesRead} pages`} of ${att.name} will be read.`
              : `Only the start of ${att.name} will be read.`}
          </div>
        ))}
        {unreadableNames.length > 0 && (
          <div className="ai-composer__warning" role="status">
            The assistant can't read the text of {unreadableNames.join(", ")}, so it only sees the file{" "}
            {unreadableNames.length === 1 ? "name" : "names"}.
          </div>
        )}
        {(attachments.length > 0 || pendingFiles.length > 0 || capturing) && (
          <div className="ai-composer__chips" role="group" aria-label="Attachments">
            {attachments.map((att) =>
              att.kind === "image" && att.dataUrl ? (
                // Compact thumbnail so the four captured views fit on one row.
                <span key={att.id} className="ai-thumb-chip" title={`${att.name}: click to enlarge`}>
                  <button
                    type="button"
                    className="ai-thumb-button"
                    onClick={() => setLightboxUrl(att.dataUrl ?? null)}
                    aria-label={`Enlarge ${att.name}`}
                  >
                    <img className="ai-thumb-chip__img" src={att.dataUrl} alt="" />
                  </button>
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
            {/* Still being read: no remove button, and Send waits for it. */}
            {pendingFiles.map((file) => (
              <span key={file.id} className="ai-chip" title={file.name} role="status">
                <span className="ai-chip__type" data-type={fileTypeOf(file.name)}>
                  <AttachmentTypeIcon name={file.name} />
                </span>
                <span className="ai-chip__label">Reading {file.name}…</span>
              </span>
            ))}
            {capturing && (
              <span className="ai-chip" role="status">
                <span className="ai-chip__type" data-type="image">
                  <ImageFileIcon />
                </span>
                <span className="ai-chip__label">Capturing the views…</span>
              </span>
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
                ref={attachButtonRef}
                className="ai-tool-btn"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach a file"
                title="Attach image, PDF, or scan"
                type="button"
              >
                <PlusIcon />
              </button>
              {captureViewport && (
                // A toggle: the name stays put and aria-pressed carries the state.
                <button
                  className="ai-tool-btn"
                  data-active={attachments.some((att) => att.source === "screenshot")}
                  onClick={() => void handleCapture()}
                  // aria-disabled, not disabled, so the focused button keeps focus
                  // while the views are taken; handleCapture ignores the click.
                  aria-disabled={capturing || undefined}
                  aria-label="Attach screenshots of the CT views"
                  aria-pressed={attachments.some((att) => att.source === "screenshot")}
                  title={
                    attachments.some((att) => att.source === "screenshot")
                      ? "Remove the captured views"
                      : "Capture the CT views"
                  }
                  type="button"
                >
                  <CameraIcon />
                </button>
              )}
            </div>

            <div className="ai-composer__right">
              <div ref={modelPickerRef} className="ai-model-picker" onBlur={handleModelPickerBlur}>
                {modelMenuOpen && (
                  // A disclosure with pressed-state buttons, not role="menu":
                  // it holds a heading and notes, and Tab moves through it.
                  <div id="ai-model-menu" className="ai-model-menu ai-model-menu--right" role="group" aria-label="Choose a model">
                    <div className="ai-model-menu__heading">Server models</div>
                    {imageModelAnswers && (
                      <div className="ai-model-menu__note">
                        Images attached, so the image-reading model will answer this message.
                      </div>
                    )}
                    {models.length > 0 ? (
                      models.map((model) => (
                        <button
                          key={model.name}
                          className="ai-model-menu__item"
                          data-selected={selectedModel === model.name}
                          onClick={() => selectModel(model.name)}
                          aria-pressed={selectedModel === model.name}
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
                      <div className="ai-model-menu__empty" role="status">
                        {modelIssue === "empty"
                          ? "No AI models are installed on the server."
                          : modelIssue === "unavailable"
                            ? "The AI model service is temporarily unavailable. Retrying automatically."
                            : "Checking for models."}
                      </div>
                    )}
                    {/* aria-disabled, not disabled, so a keyboard press keeps focus here
                        while the check runs; refreshModels ignores a second press. */}
                    <button
                      className="ai-model-menu__item"
                      onClick={() => void refreshModels()}
                      aria-disabled={refreshingModels || undefined}
                      type="button"
                    >
                      {refreshingModels ? "Checking models…" : "Refresh models"}
                    </button>
                  </div>
                )}
                <button
                  ref={modelButtonRef}
                  className="ai-model-picker__button"
                  data-state={modelState}
                  data-vision={imageModelAnswers}
                  onClick={() => setModelMenuOpen((current) => !current)}
                  disabled={modelState === "loading"}
                  aria-expanded={modelMenuOpen}
                  aria-controls={modelMenuOpen ? "ai-model-menu" : undefined}
                  title={
                    imageModelAnswers
                      ? "Images attached, so the image-reading model answers this message"
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
                  ref={sendButtonRef}
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
                  ref={sendButtonRef}
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
            ref={lightboxRef}
            className="ai-lightbox"
            onClick={() => setLightboxUrl(null)}
            role="dialog"
            aria-modal="true"
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
