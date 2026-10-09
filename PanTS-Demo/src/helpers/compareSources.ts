// Shared CT/segmentation source resolution for the comparison viewer. The comparison
// page may warm the small viewer JavaScript chunk, but it deliberately never downloads
// CT data in the background: large speculative requests can delay the reader's chosen
// case and overload a shared server.
import { API_BASE } from "./constants";
import { datasetSegmentationUrl } from "./segmentationSource";
import { getPanTSId } from "./utils";

// Local CT preview first, HuggingFace mirror fallback for the CT. The mask always comes from
// the backend, which converts the dataset's organ numbering (and reads the mirror itself when
// it has no local copy). Labelmaps stay full resolution because nearest-neighbour
// downsampling visibly stair-steps organ boundaries and can erase small structures.
// `full` asks for the full-resolution local CT instead of the fast preview, as ?hd=1 does
// in the case viewer.
export async function resolveSources(id: string, full = false): Promise<{ ct: string; seg: string }> {
	const localCt = `${API_BASE}/api/get-main-nifti/${id}.nii.gz`;
	const res = full ? "" : "?res=low";
	// CancerVerse cases have no masks: the segmentation route answers JSON with HTTP 200, which
	// the NIfTI loader never settles on, so asking for it would hold the overlay for the full
	// header timeout. Their CT lives only on the lab's server, so there is no mirror either,
	// and getPanTSId would build a meaningless mirror name from the id.
	if (/^CV/i.test(id)) return { ct: `${localCt}${res}`, seg: "" };
	const p = getPanTSId(id);
	const hfCt = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/image_only/${p}/ct.nii.gz?download=true`;
	const ok = await fetch(localCt, { method: "HEAD" })
		.then((r) => r.ok)
		.catch(() => false);
	return { ct: ok ? `${localCt}${res}` : hfCt, seg: datasetSegmentationUrl(id) };
}

// Respect the user's data budget: skip prefetch under Save-Data or on very slow (2G)
// connections — the same restraint the browser applies to native prefetch. These volumes
// are large and only *maybe* used, so honouring this matters.
function prefetchAllowed(): boolean {
	if (typeof navigator === "undefined") return false;
	const c = (navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
	if (c?.saveData) return false;
	if (typeof c?.effectiveType === "string" && c.effectiveType.includes("2g")) return false;
	return true;
}

// Warm the lazily-loaded viewer chunk so navigating to it doesn't wait on a JS download.
export function prefetchCompareViewerChunk(): void {
	// Skip under vitest — importing the viewer chunk pulls the WebGL stack jsdom can't load.
	if (typeof process !== "undefined" && process.env?.VITEST) return;
	if (!prefetchAllowed()) return;
	import("../routes/CompareViewerPage").catch(() => {});
}
