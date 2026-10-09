// Local NIfTI support: view a single .nii/.nii.gz file picked on the Upload page in a
// full-page viewer, entirely in-browser — nothing is uploaded. The Upload page stashes
// the File here (File objects can't ride through router state); the /local-nifti route
// consumes it. Mirrors dicomLocal.ts for the DICOM case.

let _pendingFile: File | null = null;

export function setLocalNiftiFile(file: File) {
	_pendingFile = file;
}

// Non-clearing on purpose: React StrictMode double-runs effects in dev, and the second
// run (and "back → reopen") must still see the file.
export function getLocalNiftiFile(): File | null {
	return _pendingFile;
}

// Cornerstone's NIfTI metadata loader decides gzip from the URL *extension*
// (`pathname.endsWith('.gz')`), but a blob: URL has none — so a .nii.gz would never be
// decompressed and would fail to parse. Decompress here by magic bytes and hand back a
// blob URL of the raw .nii bytes, which the loader then reads as uncompressed. Returns
// null when no file is stashed (deep link / reload).
export async function loadLocalNiftiAsRawBlobUrl(): Promise<string | null> {
	if (!_pendingFile) return null;
	const buf = await _pendingFile.arrayBuffer();
	const bytes = new Uint8Array(buf);
	const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
	let raw = buf;
	if (isGzip) {
		const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
		raw = await new Response(stream).arrayBuffer();
	}
	assertLooksLikeNifti(raw);
	return URL.createObjectURL(new Blob([bakeNiftiScaling(raw)]));
}

// The volume loader waits for the first 540 bytes before it reads a header, so a
// tiny or empty file would leave the viewer loading for good, and a file of some
// other kind fails deep inside the loader with a message no one can act on. A
// NIfTI header opens with its own size as an int32: 348 (NIfTI-1) or 540 (NIfTI-2),
// in either byte order.
const NIFTI_MIN_BYTES = 540;
function assertLooksLikeNifti(raw: ArrayBuffer) {
	if (raw.byteLength < NIFTI_MIN_BYTES) throw new Error("Not a NIfTI file: too small");
	const view = new DataView(raw);
	const size = [view.getInt32(0, true), view.getInt32(0, false)];
	if (!size.some((n) => n === 348 || n === 540)) throw new Error("Not a NIfTI file: bad header");
}

// Cornerstone's NIfTI loader (nifti-volume-loader 4.22, modalityScaleNifti) applies
// scl_slope/scl_inter only when BOTH differ from identity (`slope !== 1 && inter !== 0`).
// dcm2niix writes CT as int16 with slope 1 and intercept -1024, so such a file would
// open 1024 HU too bright: every window and 3D preset off, lung invisible, fat opaque.
// When the loader would skip the scaling, apply it here instead: rewrite the voxels as
// slope*raw+inter and set the header to slope 1, intercept 0. An integer file with slope 1,
// a whole intercept and a rescaled range that still fits its type (int16 CT at -1024) keeps
// its type, so the volume and its GPU texture stay the size they were; anything else becomes
// float32. Files the loader already handles (no scaling, or both terms set) and NIfTI-2 pass
// through unchanged.
type VoxelArray = { length: number; [index: number]: number };
type NiftiType = {
	bytes: number;
	array: new (buffer: ArrayBuffer, byteOffset: number, length: number) => VoxelArray;
	read: (v: DataView, at: number, le: boolean) => number;
	write: (v: DataView, at: number, value: number, le: boolean) => void;
	// The values an integer type holds; absent for the float types.
	range?: [number, number];
};
const NIFTI_TYPES: Record<number, NiftiType> = {
	2: { bytes: 1, array: Uint8Array, read: (v, at) => v.getUint8(at), write: (v, at, n) => v.setUint8(at, n), range: [0, 0xff] },
	4: { bytes: 2, array: Int16Array, read: (v, at, le) => v.getInt16(at, le), write: (v, at, n, le) => v.setInt16(at, n, le), range: [-0x8000, 0x7fff] },
	8: { bytes: 4, array: Int32Array, read: (v, at, le) => v.getInt32(at, le), write: (v, at, n, le) => v.setInt32(at, n, le), range: [-0x80000000, 0x7fffffff] },
	16: { bytes: 4, array: Float32Array, read: (v, at, le) => v.getFloat32(at, le), write: (v, at, n, le) => v.setFloat32(at, n, le) },
	64: { bytes: 8, array: Float64Array, read: (v, at, le) => v.getFloat64(at, le), write: (v, at, n, le) => v.setFloat64(at, n, le) },
	256: { bytes: 1, array: Int8Array, read: (v, at) => v.getInt8(at), write: (v, at, n) => v.setInt8(at, n), range: [-0x80, 0x7f] },
	512: { bytes: 2, array: Uint16Array, read: (v, at, le) => v.getUint16(at, le), write: (v, at, n, le) => v.setUint16(at, n, le), range: [0, 0xffff] },
	768: { bytes: 4, array: Uint32Array, read: (v, at, le) => v.getUint32(at, le), write: (v, at, n, le) => v.setUint32(at, n, le), range: [0, 0xffffffff] },
};
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const NIFTI_FLOAT32 = 16;
const FLOAT32_TYPE = NIFTI_TYPES[NIFTI_FLOAT32];

export function bakeNiftiScaling(raw: ArrayBuffer): ArrayBuffer {
	const view = new DataView(raw);
	const le = view.getInt32(0, true) === 348;
	if (!le && view.getInt32(0, false) !== 348) return raw; // NIfTI-2: left to the loader
	// The loader's own reading of the header: a zero or NaN term means identity.
	const sclSlope = view.getFloat32(112, le);
	const sclInter = view.getFloat32(116, le);
	const slope = !sclSlope || Number.isNaN(sclSlope) ? 1 : sclSlope;
	const inter = !sclInter || Number.isNaN(sclInter) ? 0 : sclInter;
	if ((slope !== 1) === (inter !== 0)) return raw; // identity, or the loader applies both
	const type = NIFTI_TYPES[view.getInt16(70, le)];
	if (!type) return raw;
	const voxOffset = Math.round(view.getFloat32(108, le));
	const rank = view.getInt16(40, le);
	let count = 1;
	for (let d = 1; d <= Math.min(Math.max(rank, 1), 7); d++) count *= Math.max(view.getInt16(40 + d * 2, le), 1);
	if (voxOffset < 348 || voxOffset + count * type.bytes > raw.byteLength) return raw;

	// Typed arrays read and write in host byte order, which is far faster than a DataView
	// call per voxel on a few hundred million voxels. They need the offset aligned.
	const fast = le === HOST_LITTLE_ENDIAN && voxOffset % 8 === 0;
	const src = fast ? new type.array(raw, voxOffset, count) : null;
	const at = (i: number) => (src ? src[i] : type.read(view, voxOffset + i * type.bytes, le));

	let outType = FLOAT32_TYPE;
	if (type.range && slope === 1 && Number.isInteger(inter)) {
		let min = Infinity;
		let max = -Infinity;
		for (let i = 0; i < count; i++) {
			const n = at(i);
			if (n < min) min = n;
			if (n > max) max = n;
		}
		if (min + inter >= type.range[0] && max + inter <= type.range[1]) outType = type;
	}

	const out = new ArrayBuffer(voxOffset + count * outType.bytes);
	new Uint8Array(out).set(new Uint8Array(raw, 0, voxOffset));
	const header = new DataView(out);
	if (outType === FLOAT32_TYPE) {
		header.setInt16(70, NIFTI_FLOAT32, le);
		header.setInt16(72, 32, le);
	}
	header.setFloat32(112, 1, le);
	header.setFloat32(116, 0, le);
	if (fast) {
		const dst = new outType.array(out, voxOffset, count);
		for (let i = 0; i < count; i++) dst[i] = at(i) * slope + inter;
	} else {
		for (let i = 0; i < count; i++) outType.write(header, voxOffset + i * outType.bytes, at(i) * slope + inter, le);
	}
	return out;
}
