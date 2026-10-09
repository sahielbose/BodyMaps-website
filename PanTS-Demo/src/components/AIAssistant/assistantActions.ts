import {
  clearMeasurements as csClearMeasurements,
  LENGTH_TOOL,
  PROBE_TOOL,
  ROI_TOOL,
  moveCornerstoneCrosshairToMm,
  getOrganCentroids,
  setFillOpacity,
  MAX_ZOOM,
  MIN_ZOOM,
  setZoom as csSetZoom,
  zoomToFit as csZoomToFit,
} from "../../helpers/CornerstoneNifti2";
import type { MeasurementToolName } from "../../helpers/CornerstoneNifti2";
import { segmentation_categories } from "../../helpers/constants";
import { CT_WINDOWS } from "../../helpers/ctWindows";
import { filenameToName, midSentence } from "../../helpers/utils.name";
import type { CheckBoxData } from "../../types";
import type { ViewerActions } from "./types";

// truncated: the mask reaches the first or last slice, so the volume is only the
// part inside the scan (the Organ statistics table shows n/a for it).
type OrganStat = { organ_name: string; volume_cm3: number; mean_hu: number; truncated?: boolean | null };

function normalizeName(value: string) {
  return value.toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

// Organ names read mid-sentence in replies ("the segmented kidney left volume").
function displayName(value: string) {
  return midSentence(filenameToName(value));
}

function organKeyToId(key: string, checkBoxData: CheckBoxData[]): number | null {
  const normalizedKey = normalizeName(key);
  const found = checkBoxData.find((item) => normalizeName(item.label) === normalizedKey);
  if (found) return found.id;
  const index = segmentation_categories.findIndex((category) => normalizeName(category) === normalizedKey);
  if (index === -1) return null;
  return index + 1;
}

function statMatchesOrgan(statName: string, organKey: string) {
  return normalizeName(statName) === normalizeName(organKey);
}

function validVolume(value: number | undefined | null) {
  return typeof value === "number" && Number.isFinite(value) && value !== 999999 && value > 0;
}

// A volume that can stand as a whole-organ measurement, for ranking structures.
function wholeVolume(item: OrganStat) {
  return validVolume(item.volume_cm3) && !item.truncated;
}

function joinNames(names: string[]) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// What to add to a largest or smallest answer that skipped clipped organs. A clipped
// organ is only partly measured, so the ranking can be wrong when it is the real
// winner: for the largest, say so when a partial volume already beats the winner;
// for the smallest, when a partial volume is still below it.
function rankingCaveat(stats: OrganStat[], winnerVolume: number, largest: boolean) {
  const clipped = stats.filter((item) => validVolume(item.volume_cm3) && item.truncated);
  const decisive = clipped.filter((item) => (largest ? item.volume_cm3 > winnerVolume : item.volume_cm3 < winnerVolume));
  if (largest && decisive.length) {
    const one = decisive.length === 1;
    const names = joinNames(decisive.map((item) => displayName(item.organ_name)));
    return ` The ${names} ${one ? "reaches" : "reach"} the edge of the scan and already ${one ? "measures" : "measure"} more than this, so ${one ? "it is" : "they are"} larger, but ${one ? "its" : "their"} full volume cannot be measured.`;
  }
  if (decisive.length || (largest && clipped.length)) return " This ranking leaves out organs that are cut off at the edge of the scan.";
  return "";
}

async function fetchOrganStats(apiBase: string, caseId: string): Promise<OrganStat[]> {
  const formData = new FormData();
  formData.append("sessionKey", String(caseId));
  const response = await fetch(`${apiBase}/api/mask-data`, { method: "POST", body: formData });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
  return (data.organ_metrics ?? []) as OrganStat[];
}

export function buildViewerActions(opts: {
  checkBoxData: CheckBoxData[];
  setCheckState: React.Dispatch<React.SetStateAction<boolean[]>>;
  setOpacityValue: React.Dispatch<React.SetStateAction<number>>;
  handleWindowChange: (width: number | null, center: number | null) => void;
  setViewModeFn: (view: "mpr" | "axial" | "sagittal" | "coronal" | "3d") => void;
  setActiveMeasureToolFn: React.Dispatch<React.SetStateAction<MeasurementToolName | null>>;
  caseId: string;
  apiBase: string;
  /** The organ stats the viewer already loaded for this case, or null if it
   *  hasn't. The assistant is only usable once its sidebar has opened, which
   *  is what loads them, so a metric question normally needs no request of
   *  its own; the server computes these from the whole CT and masks. */
  getOrganStats?: () => OrganStat[] | null;
  /** The viewer's zoom state, which the toolbar's Zoom slider and readout
   *  show and which drives the panes. Zoom commands go through it so they
   *  stay in step with the slider. */
  setZoomLevel?: (value: number) => void;
}): ViewerActions {
  const {
    checkBoxData,
    setCheckState,
    setOpacityValue,
    handleWindowChange,
    setViewModeFn,
    setActiveMeasureToolFn,
    caseId,
    apiBase,
    getOrganStats,
    setZoomLevel,
  } = opts;

  const organStats = async (): Promise<OrganStat[]> => {
    const loaded = getOrganStats?.();
    return loaded && loaded.length ? loaded : fetchOrganStats(apiBase, caseId);
  };

  const windowPresets: Record<string, { width: number; center: number }> = {
    soft_tissue: CT_WINDOWS.softTissue,
    bone: CT_WINDOWS.bone,
    lung: CT_WINDOWS.lung,
    liver: CT_WINDOWS.liver,
  };

  const toolMap: Record<string, MeasurementToolName> = {
    distance: LENGTH_TOOL,
    probe: PROBE_TOOL,
    roi: ROI_TOOL,
  };

  return {
    isolateOrgans(organKeys) {
      setCheckState((previous) => {
        const next = new Array(previous.length).fill(false);
        next[0] = true;
        for (const key of organKeys) {
          const id = organKeyToId(key, checkBoxData);
          if (id !== null && id < next.length) next[id] = true;
        }
        return next;
      });
    },

    showOrgans(organKeys) {
      setCheckState((previous) => {
        const next = [...previous];
        for (const key of organKeys) {
          const id = organKeyToId(key, checkBoxData);
          if (id !== null && id < next.length) next[id] = true;
        }
        return next;
      });
    },

    hideOrgans(organKeys) {
      setCheckState((previous) => {
        const next = [...previous];
        for (const key of organKeys) {
          const id = organKeyToId(key, checkBoxData);
          if (id !== null && id < next.length) next[id] = false;
        }
        return next;
      });
    },

    focusOrgan(organKey) {
      const id = organKeyToId(organKey, checkBoxData);
      if (id !== null) {
        setCheckState((previous) => {
          const next = [...previous];
          next[id] = true;
          return next;
        });
      }
      const centroids = getOrganCentroids();
      if (centroids && id !== null && centroids[id]) moveCornerstoneCrosshairToMm(centroids[id]);
    },

    setOpacity(value) {
      const clamped = Math.max(0, Math.min(100, value));
      setOpacityValue(clamped);
      setFillOpacity(clamped / 100);
    },

    setWindow(width, center) {
      handleWindowChange(width, center);
    },

    setWindowPreset(preset) {
      const selectedPreset = windowPresets[preset];
      if (selectedPreset) handleWindowChange(selectedPreset.width, selectedPreset.center);
    },

    // The same range as the toolbar's slider, so a request for 15x cannot push
    // the panes past what the readout can show.
    setZoom(value) {
      if (!Number.isFinite(value)) return;
      const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
      csSetZoom(clamped);
      setZoomLevel?.(clamped);
    },

    zoomToFit() {
      csZoomToFit();
      setZoomLevel?.(1);
    },

    setViewMode(view) {
      setViewModeFn(view);
    },

    activateMeasurementTool(tool) {
      setActiveMeasureToolFn(toolMap[tool] ?? null);
    },

    // No Keep / Clear question here on purpose: the person typed the request to the
    // assistant, so that typed request is the confirmation the buttons ask for.
    clearMeasurements() {
      csClearMeasurements();
    },

    async getOrganMetric(organ, metric) {
      try {
        const stats = await organStats();
        const entry = stats.find((item) => statMatchesOrgan(item.organ_name, organ));
        if (!entry) return `No statistics were found for ${displayName(organ)} in this case.`;
        const clipped = validVolume(entry.volume_cm3) && Boolean(entry.truncated);
        const volume = validVolume(entry.volume_cm3) ? `${clipped ? "at least " : ""}${entry.volume_cm3.toFixed(2)} cm³` : "N/A";
        const clippedNote = clipped ? " The mask reaches the edge of the scan, so the volume is cut off." : "";
        const meanHu = typeof entry.mean_hu === "number" && Number.isFinite(entry.mean_hu) && entry.mean_hu !== 999999 ? `${entry.mean_hu.toFixed(1)} HU` : "N/A";
        if (metric === "volume_cm3") return `The segmented ${displayName(organ)} volume is **${volume}**.${clippedNote}`;
        if (metric === "mean_hu") return `The segmented ${displayName(organ)} mean HU is **${meanHu}**.`;
        return `For ${displayName(organ)}: volume is **${volume}** and mean HU is **${meanHu}**.${clippedNote}`;
      } catch (error) {
        console.error("[BodyMaps AI metric error]", error);
        return "I could not load organ statistics for this case. The server may not have segmentation metrics available.";
      }
    },

    async listStructures() {
      const names = checkBoxData.map((item) => item.label).filter(Boolean);
      if (!names.length) return "No segmented structures are currently listed for this case.";
      return `This case includes **${names.length} segmented ${names.length === 1 ? "structure" : "structures"}**: ${names.join(", ")}.`;
    },

    async getStructureCount() {
      return `This case has **${checkBoxData.length} segmented ${checkBoxData.length === 1 ? "structure" : "structures"}** listed in the viewer.`;
    },

    async getLargestStructure() {
      try {
        const stats = await organStats();
        const validStats = stats.filter(wholeVolume);
        if (!validStats.length) return "I could not determine the largest structure because valid volume metrics are unavailable.";
        const largest = [...validStats].sort((a, b) => b.volume_cm3 - a.volume_cm3)[0];
        return `The largest segmented structure is **${displayName(largest.organ_name)}**, with a volume of **${largest.volume_cm3.toFixed(2)} cm³**.${rankingCaveat(stats, largest.volume_cm3, true)}`;
      } catch (error) {
        console.error("[BodyMaps AI largest error]", error);
        return "I could not calculate the largest segmented structure from this case.";
      }
    },

    async getSmallestStructure() {
      try {
        const stats = await organStats();
        const validStats = stats.filter(wholeVolume);
        if (!validStats.length) return "I could not determine the smallest structure because valid volume metrics are unavailable.";
        const smallest = [...validStats].sort((a, b) => a.volume_cm3 - b.volume_cm3)[0];
        return `The smallest segmented structure is **${displayName(smallest.organ_name)}**, with a volume of **${smallest.volume_cm3.toFixed(2)} cm³**.${rankingCaveat(stats, smallest.volume_cm3, false)}`;
      } catch (error) {
        console.error("[BodyMaps AI smallest error]", error);
        return "I could not calculate the smallest segmented structure from this case.";
      }
    },
  };
}
