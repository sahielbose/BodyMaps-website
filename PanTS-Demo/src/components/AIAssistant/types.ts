// Trigger typecheck using the latest AI assistant files.
export type AIAction =
  | { type: "isolate_organs"; organs: string[] }
  | { type: "show_organs"; organs: string[] }
  | { type: "hide_organs"; organs: string[] }
  | { type: "focus_organ"; organ: string }
  | { type: "get_organ_metric"; organ: string; metric: "volume_cm3" | "mean_hu" | "all" }
  | { type: "set_opacity"; value: number }
  | { type: "set_window"; width: number; center: number }
  | { type: "set_window_preset"; preset: "soft_tissue" | "bone" | "lung" | "liver" }
  | { type: "set_zoom"; value: number }
  | { type: "zoom_to_fit" }
  | { type: "set_view"; view: "mpr" | "axial" | "sagittal" | "coronal" | "3d" }
  | { type: "activate_measurement_tool"; tool: "distance" | "probe" | "roi" }
  | { type: "clear_measurements" }
  | { type: "list_structures" }
  | { type: "get_structure_count" }
  | { type: "get_largest_structure" }
  | { type: "get_smallest_structure" };

export type ChatRole = "user" | "assistant" | "system";

export type AttachmentKind = "image" | "file";

export interface ChatAttachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  /** Present for images: a data: URL used both for preview and for the model. */
  dataUrl?: string;
  /** Optional short label, e.g. the viewport a screenshot came from. */
  label?: string;
  /** Where the attachment came from — screenshots are added/removed as a set. */
  source?: "screenshot" | "upload";
  /** Extracted text of an attached document (e.g. a PDF), sent to the model. */
  textContent?: string;
  /** Set when only the start of the document was read (long PDFs are cut). */
  truncated?: boolean | null;
  /** Pages whose text was fully included, shown in the note about a cut. */
  pagesRead?: number;
  /** Mask color legend as it was when a screenshot was taken, so a later change in the viewer does not rewrite it. */
  legend?: { organ: string; color: string }[];
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  meta?: string;
  /** Assistant private reasoning, streamed live and shown in a muted block. */
  thinking?: string;
  /** Current progress stage shown while the answer is still forming. */
  status?: string;
  /** True while tokens are still arriving for this message. */
  streaming?: boolean;
  /** Images / files the user attached to this turn. */
  attachments?: ChatAttachment[];
  /** True when no answer came back, so the reply offers Try again. */
  failed?: boolean;
}

export interface ViewerStateSnapshot {
  view: string;
  opacity: number;
  windowWidth: number;
  windowCenter: number;
  zoomLevel: number;
}

export interface OrganMetricSnapshot {
  organ_name: string;
  volume_cm3: number | null;
  mean_hu?: number | null;
  voxel_count?: number | null;
  // The mask reaches the first or last slice, so the volume is cut off.
  truncated?: boolean | null;
}

export interface OrganReferenceSnapshot {
  organ_name: string;
  percentile: number;
  basis?: string | null;
  n?: number | null;
}

export interface DemographicsSnapshot {
  sex?: string | null;
  age?: number | null;
  bmi?: number | null;
  height_cm?: number | null;
  weight_kg?: number | null;
}

export interface AIModelInfo {
  name: string;
  size?: number;
  modified_at?: string;
}

export interface ViewerActions {
  isolateOrgans: (organKeys: string[]) => void;
  showOrgans: (organKeys: string[]) => void;
  hideOrgans: (organKeys: string[]) => void;
  focusOrgan: (organKey: string) => void;
  setOpacity: (value: number) => void;
  setWindow: (width: number, center: number) => void;
  setWindowPreset: (preset: "soft_tissue" | "bone" | "lung" | "liver") => void;
  setZoom: (value: number) => void;
  zoomToFit: () => void;
  setViewMode: (view: "mpr" | "axial" | "sagittal" | "coronal" | "3d") => void;
  activateMeasurementTool: (tool: "distance" | "probe" | "roi") => void;
  clearMeasurements: () => void;
  getOrganMetric: (organ: string, metric: "volume_cm3" | "mean_hu" | "all") => Promise<string>;
  listStructures: () => Promise<string>;
  getStructureCount: () => Promise<string>;
  getLargestStructure: () => Promise<string>;
  getSmallestStructure: () => Promise<string>;
}

export interface ViewportCapture {
  name: string;
  dataUrl: string;
}

export interface AISidebarProps {
  open: boolean;
  onClose: () => void;
  caseId: string;
  sessionId?: string;
  availableOrgans: string[];
  viewerState: ViewerStateSnapshot;
  organMetrics?: OrganMetricSnapshot[];
  organReferences?: OrganReferenceSnapshot[];
  demographics?: DemographicsSnapshot | null;
  actions: ViewerActions;
  /** Captures the current CT viewports (axial/sagittal/coronal/3D) as PNGs. */
  captureViewport?: () => Promise<ViewportCapture[]>;
  /** Color→organ legend for the visible masks, sent with screenshots. */
  getMaskLegend?: () => { organ: string; color: string }[];
  /** Live drag-resize: called with the pointer's clientX while dragging. */
  onResize?: (clientX: number) => void;
  /** Called when the resize drag ends, to persist the final width. */
  onResizeEnd?: () => void;
}
