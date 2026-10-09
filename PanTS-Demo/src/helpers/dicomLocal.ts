// Local DICOM support: open a folder of .dcm files directly in the viewer, fully
// in-browser — nothing is uploaded, no backend involved. The Upload page stashes
// the picked File objects here (they can't ride through router state), the
// /dicom route consumes them. All Cornerstone imports are dynamic, inside
// loadLocalDicomSeries, so this module stays import-safe for jsdom tests and
// the DICOM loader bundle is only fetched when a folder is actually opened.

let _pendingFiles: File[] = [];

export function setLocalDicomFiles(files: File[]) {
	_pendingFiles = files;
}

// Non-clearing on purpose: React StrictMode double-runs effects in dev, and the
// second run must still see the files (it also lets "back → reopen" work).
export function getLocalDicomFiles(): File[] {
	return _pendingFiles;
}

// Filter obvious non-DICOM files up front (folders often carry DICOMDIR, jpgs,
// reports…). Files with no extension are common for DICOM, so keep those.
export function looksLikeDicom(file: File): boolean {
	const name = file.name.toLowerCase();
	if (name.startsWith(".")) return false;
	const dot = name.lastIndexOf(".");
	if (dot === -1) return true; // extensionless — typical for DICOM
	const ext = name.slice(dot + 1);
	return ext === "dcm" || ext === "dicom" || ext === "ima" || /^\d+$/.test(ext);
}

// A DICOM file carries "DICM" at byte 128, right after its preamble.
function hasDicomMarker(file: File): Promise<boolean> {
	if (file.size < 132) return Promise.resolve(false);
	return new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => {
			const b = new Uint8Array(reader.result as ArrayBuffer);
			resolve(b[0] === 0x44 && b[1] === 0x49 && b[2] === 0x43 && b[3] === 0x4d);
		};
		reader.onerror = () => resolve(false);
		reader.readAsArrayBuffer(file.slice(128, 132));
	});
}

// How many picked files are DICOM slices. One with a DICOM extension counts as is.
// An extensionless one counts only with the marker, since a README, a LICENSE or a
// .git object passes looksLikeDicom too.
export async function countDicomSlices(files: File[]): Promise<number> {
	const candidates = files.filter(looksLikeDicom);
	const bare = candidates.filter((f) => !f.name.includes("."));
	const marked = await Promise.all(bare.map(hasDicomMarker));
	return candidates.length - bare.length + marked.filter(Boolean).length;
}

// Thrown when the picked files hold no usable image series. Its message is already
// written for the reader, unlike whatever the loader throws while building a volume.
export class NoDicomSeriesError extends Error {
	constructor() {
		super("No DICOM image series found in the selected files. Pick a folder containing one CT series (.dcm slices).");
		this.name = "NoDicomSeriesError";
	}
}

const count = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
const slicesOf = (n: number) => `${n} ${n === 1 ? "slice" : "slices"}`;

// What the viewer tells the reader when files in the folder were left out. With several series
// it says which one is showing; with one series only stray files (a DICOMDIR, a README) were
// left out, so it does not claim a choice was made. Null when nothing was left out.
export function localDicomSeriesNotice(
	series: Pick<LocalDicomSeries, "imageIds" | "skippedFiles" | "otherSeriesFiles"> & { seriesCount?: number }
): string | null {
	const notLoaded = count(series.skippedFiles) + count(series.otherSeriesFiles);
	if (notLoaded <= 0) return null;
	const files = notLoaded === 1 ? "file in the folder was" : "files in the folder were";
	if (series.seriesCount === 1) return `${notLoaded} ${files} not loaded.`;
	return `Showing the largest series (${slicesOf(series.imageIds.length)}). ${notLoaded} other ${files} not loaded.`;
}

// The toolbar's standing cue for which series is open: its own description, or when the folder
// held several series and this one has none, a line that still says it is the largest.
export function localDicomSeriesLabel(
	series: Pick<LocalDicomSeries, "imageIds" | "seriesDescription" | "seriesCount">
): string {
	const description = series.seriesDescription.trim();
	if (description) return description;
	return count(series.seriesCount) > 1 ? `largest series, ${slicesOf(series.imageIds.length)}` : "";
}

export type LocalDicomSeries = {
	imageIds: string[];
	seriesDescription: string;
	skippedFiles: number;
	// How many series the folder held, and how many slices sit in the ones that were not kept.
	seriesCount: number;
	otherSeriesFiles: number;
	// Frees the parsed datasets and file handles behind these imageIds. Safe to call twice.
	release: () => void;
};

// init() registers the wadouri loaders, metadata provider, and decode-worker
// pool. Calling it more than once re-registers the worker ("already registered"
// warning) and can orphan in-flight worker messages — so guard it. Survives
// React StrictMode's double effect run and "back → reopen".
let _dicomInited = false;

const nameCollator = new Intl.Collator(undefined, { numeric: true });

type Vec3 = [number, number, number];
const asVec3 = (v: unknown): Vec3 | undefined =>
	Array.isArray(v) && v.length >= 3 && v.slice(0, 3).every((n) => Number.isFinite(Number(n)))
		? [Number(v[0]), Number(v[1]), Number(v[2])]
		: undefined;

/**
 * Orders one series' slices by position along the slice normal (row x column
 * direction), which is foot to head for a standard axial series, else by instance
 * number, else by natural file name, so IM2 comes before IM10. A series missing the
 * position of any slice falls back as a whole, so the order never mixes two keys.
 */
export function sortSlices(
	imageIds: string[],
	nameOf: Map<string, string>,
	getMeta: (type: string, imageId: string) => unknown,
): string[] {
	const plane = new Map<string, { position?: Vec3; row?: Vec3; col?: Vec3 }>();
	const instance = new Map<string, number>();
	for (const id of imageIds) {
		const p = (getMeta("imagePlaneModule", id) ?? {}) as {
			imagePositionPatient?: unknown;
			imageOrientationPatient?: unknown;
			rowCosines?: unknown;
			columnCosines?: unknown;
		};
		const iop = Array.isArray(p.imageOrientationPatient) ? p.imageOrientationPatient : undefined;
		plane.set(id, {
			position: asVec3(p.imagePositionPatient),
			row: asVec3(iop ? iop.slice(0, 3) : p.rowCosines),
			col: asVec3(iop ? iop.slice(3, 6) : p.columnCosines),
		});
		const n = Number((getMeta("generalImageModule", id) as { instanceNumber?: unknown } | undefined)?.instanceNumber);
		if (Number.isFinite(n)) instance.set(id, n);
	}
	const byName = (a: string, b: string) => nameCollator.compare(nameOf.get(a) ?? a, nameOf.get(b) ?? b);

	const first = imageIds.map((id) => plane.get(id)!).find((e) => e.row && e.col);
	if (first && imageIds.every((id) => plane.get(id)!.position)) {
		const [r, c] = [first.row!, first.col!];
		const normal: Vec3 = [r[1] * c[2] - r[2] * c[1], r[2] * c[0] - r[0] * c[2], r[0] * c[1] - r[1] * c[0]];
		const depth = new Map(
			imageIds.map((id) => {
				const q = plane.get(id)!.position!;
				return [id, q[0] * normal[0] + q[1] * normal[1] + q[2] * normal[2]] as const;
			}),
		);
		return [...imageIds].sort((a, b) => depth.get(a)! - depth.get(b)! || byName(a, b));
	}
	if (imageIds.every((id) => instance.has(id))) {
		return [...imageIds].sort((a, b) => instance.get(a)! - instance.get(b)! || byName(a, b));
	}
	return [...imageIds].sort(byName);
}

/**
 * Register the files with the DICOM loader, read enough metadata to group them
 * by series, and return the imageIds of the largest series (a picked folder
 * often mixes scouts/dose reports with the actual CT stack). The slices come back
 * in anatomical order: the volume loader would sort them anyway, but a stack
 * viewport (the upload preview) pages through them exactly as given.
 */
export async function loadLocalDicomSeries(files: File[], signal?: AbortSignal): Promise<LocalDicomSeries> {
	const [{ metaData }, dicomLoader] = await Promise.all([
		import("@cornerstonejs/core"),
		import("@cornerstonejs/dicom-image-loader"),
	]);
	if (!_dicomInited) {
		dicomLoader.init();
		_dicomInited = true;
	}
	const wadouri = dicomLoader.wadouri;

	// The header pass caches every file's whole byte array, and nothing else ever frees it
	// (the loaded images carry no decache), so each open would stay resident for the life of
	// the tab. Whatever is not kept goes back here; the kept series goes back through release().
	const freeImageIds = (imageIds: string[]) => {
		for (const id of imageIds) {
			wadouri.dataSetCacheManager.unload(wadouri.parseImageId(id).url);
			wadouri.fileManager.remove(Number(id.slice(id.indexOf(":") + 1)));
		}
	};
	const registered: string[] = [];
	const nameOf = new Map<string, string>();

	const candidates = files.filter(looksLikeDicom);
	const bySeries = new Map<string, { imageIds: string[]; description: string }>();
	let skippedFiles = files.length - candidates.length;

	for (const file of candidates) {
		// Leaving the viewer (or hitting its load deadline) stops the header pass for a large folder.
		if (signal?.aborted) {
			freeImageIds(registered);
			throw new DOMException("Viewer load was aborted", "AbortError");
		}
		const imageId = wadouri.fileManager.add(file);
		registered.push(imageId);
		nameOf.set(imageId, file.name);
		try {
			// Parse only the DICOM *header* — this populates the metadata provider so
			// the volume loader can compute geometry, without decoding pixels. The
			// volume loader decodes the slices itself when it builds the volume, so
			// decoding here would double the work AND flood the decode workers (which
			// is what made large series crawl / drop worker messages). This mirrors
			// wadouri.loadImage's own seam, minus the pixel decode.
			const { scheme, url } = wadouri.parseImageId(imageId);
			await wadouri.dataSetCacheManager.load(url, wadouri.getLoaderForScheme(scheme), imageId);
			const series = metaData.get("generalSeriesModule", imageId) as
				| { seriesInstanceUID?: string; seriesDescription?: string }
				| undefined;
			const uid = series?.seriesInstanceUID ?? "unknown-series";
			let entry = bySeries.get(uid);
			if (!entry) {
				entry = { imageIds: [], description: series?.seriesDescription ?? "" };
				bySeries.set(uid, entry);
			}
			entry.imageIds.push(imageId);
		} catch {
			skippedFiles++; // not parseable as DICOM — skip it
			registered.pop();
			freeImageIds([imageId]);
		}
	}

	let best: { imageIds: string[]; description: string } | null = null;
	for (const entry of bySeries.values()) {
		if (!best || entry.imageIds.length > best.imageIds.length) best = entry;
	}
	if (!best || best.imageIds.length < 2) {
		freeImageIds(registered);
		throw new NoDicomSeriesError();
	}
	const keptIds = sortSlices(best.imageIds, nameOf, metaData.get);
	const kept = new Set(keptIds);
	freeImageIds(registered.filter((id) => !kept.has(id)));
	let released = false;
	return {
		imageIds: keptIds,
		seriesDescription: best.description,
		skippedFiles,
		seriesCount: bySeries.size,
		otherSeriesFiles: [...bySeries.values()].reduce((n, e) => n + (e === best ? 0 : e.imageIds.length), 0),
		release: () => {
			if (released) return;
			released = true;
			freeImageIds(keptIds);
		},
	};
}
