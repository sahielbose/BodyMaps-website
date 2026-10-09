// Where the viewers load a dataset case's segmentation from. Always the backend: the PanTS
// masks number some organs differently from the viewer's catalog (spleen, stomach, the IVC
// and the pancreatic lesion among them), and the backend converts them to catalog ids. It
// also fetches the HuggingFace mirror itself when the case is not stored locally, so the
// browser never loads a raw mask.
import { API_BASE } from "./constants";

// The organ numbering the backend serves. Masks are cached for a week as immutable, so it is
// part of the URL: a copy a browser or CDN kept from before the conversion is never reused.
export const MASK_LABEL_SCHEME = "viewer-v1";

export function datasetSegmentationUrl(id: string, { low = false }: { low?: boolean } = {}): string {
	const url = `${API_BASE}/api/get-segmentations/${id}.nii.gz?labels=${MASK_LABEL_SCHEME}`;
	return low ? `${url}&res=low` : url;
}
