/**
 * A local NIfTI with scl_slope 1 and scl_inter -1024 (how dcm2niix writes CT) opens in
 * Hounsfield units. Cornerstone's loader skips the intercept when the slope is 1, so the
 * viewer applies it before handing the file over, keeping an integer type when the result
 * fits it so the volume does not double in size.
 */
import { afterEach, describe, expect, it } from "vitest";
import { bakeNiftiScaling, loadLocalNiftiAsRawBlobUrl, setLocalNiftiFile } from "../helpers/localNifti";

const VOX_OFFSET = 352;

// A minimal NIfTI-1 file holding one row of int16 voxels (or uint8 ones).
function int16Nifti(values: number[], slope: number, inter: number, littleEndian = true, uint8 = false): ArrayBuffer {
	const buf = new ArrayBuffer(VOX_OFFSET + values.length * (uint8 ? 1 : 2));
	const v = new DataView(buf);
	v.setInt32(0, 348, littleEndian);
	v.setInt16(40, 3, littleEndian);
	v.setInt16(42, values.length, littleEndian);
	v.setInt16(44, 1, littleEndian);
	v.setInt16(46, 1, littleEndian);
	v.setInt16(70, uint8 ? 2 : 4, littleEndian); // uint8 or int16
	v.setInt16(72, uint8 ? 8 : 16, littleEndian);
	v.setFloat32(108, VOX_OFFSET, littleEndian);
	v.setFloat32(112, slope, littleEndian);
	v.setFloat32(116, inter, littleEndian);
	values.forEach((n, i) => (uint8 ? v.setUint8(VOX_OFFSET + i, n) : v.setInt16(VOX_OFFSET + i * 2, n, littleEndian)));
	return buf;
}

function readInt16Voxels(buf: ArrayBuffer, count: number, littleEndian = true): number[] {
	const v = new DataView(buf);
	return Array.from({ length: count }, (_, i) => v.getInt16(VOX_OFFSET + i * 2, littleEndian));
}

function readFloat32Voxels(buf: ArrayBuffer, count: number, littleEndian = true): number[] {
	const v = new DataView(buf);
	return Array.from({ length: count }, (_, i) => v.getFloat32(VOX_OFFSET + i * 4, littleEndian));
}

const realCreateObjectURL = URL.createObjectURL;
afterEach(() => {
	URL.createObjectURL = realCreateObjectURL;
});

describe("bakeNiftiScaling", () => {
	it("applies an intercept the loader would skip, keeps int16 and marks the file as already scaled", () => {
		const raw = int16Nifti([0, 1024, 2048, 24], 1, -1024);
		const out = bakeNiftiScaling(raw);
		const v = new DataView(out);
		expect(v.getInt16(70, true)).toBe(4); // still int16
		expect(v.getInt16(72, true)).toBe(16);
		expect(v.getFloat32(112, true)).toBe(1);
		expect(v.getFloat32(116, true)).toBe(0);
		expect(out.byteLength).toBe(raw.byteLength);
		expect(readInt16Voxels(out, 4)).toEqual([-1024, 0, 1024, -1000]);
		// The source is left as it was.
		expect(readInt16Voxels(raw, 4)).toEqual([0, 1024, 2048, 24]);
	});

	it("falls back to float32 when the rescaled values do not fit int16", () => {
		const out = bakeNiftiScaling(int16Nifti([-32000, 0, 1024], 1, -1024));
		const v = new DataView(out);
		expect(v.getInt16(70, true)).toBe(16); // float32
		expect(v.getInt16(72, true)).toBe(32);
		expect(v.getFloat32(116, true)).toBe(0);
		expect(readFloat32Voxels(out, 3)).toEqual([-33024, -1024, 0]);
	});

	it("falls back to float32 for an unsigned type that cannot hold negative values", () => {
		const out = bakeNiftiScaling(int16Nifti([0, 200, 24], 1, -100, true, true));
		expect(new DataView(out).getInt16(70, true)).toBe(16);
		expect(readFloat32Voxels(out, 3)).toEqual([-100, 100, -76]);
	});

	it("falls back to float32 for an intercept that is not a whole number", () => {
		const out = bakeNiftiScaling(int16Nifti([0, 2, 4], 1, -0.5));
		expect(new DataView(out).getInt16(70, true)).toBe(16);
		expect(readFloat32Voxels(out, 3)).toEqual([-0.5, 1.5, 3.5]);
	});

	it("applies a slope the loader would skip when there is no intercept", () => {
		const out = bakeNiftiScaling(int16Nifti([2, -4, 6, 0], 0.5, 0));
		expect(new DataView(out).getInt16(70, true)).toBe(16);
		expect(readFloat32Voxels(out, 4)).toEqual([1, -2, 3, 0]);
	});

	it("handles a big-endian file", () => {
		const out = bakeNiftiScaling(int16Nifti([0, 1024, 40, 1064], 1, -1024, false));
		expect(new DataView(out).getInt16(70, false)).toBe(4);
		expect(readInt16Voxels(out, 4, false)).toEqual([-1024, 0, -984, 40]);
		const wide = bakeNiftiScaling(int16Nifti([-32000, 40], 1, -1024, false));
		expect(new DataView(wide).getInt16(70, false)).toBe(16);
		expect(readFloat32Voxels(wide, 2, false)).toEqual([-33024, -984]);
	});

	it.each([
		["no scaling", 0, 0],
		["NaN scaling, as the PanTS files have", Number.NaN, Number.NaN],
		["identity scaling", 1, 0],
		["both terms, which the loader applies itself", 2, -1024],
	])("leaves a file with %s alone", (_name, slope, inter) => {
		const raw = int16Nifti([1, 2, 3, 4], slope, inter);
		expect(bakeNiftiScaling(raw)).toBe(raw);
	});

	it("hands the scaled bytes to the viewer", async () => {
		let handed: Blob | undefined;
		URL.createObjectURL = (blob: Blob) => {
			handed = blob;
			return "blob:scaled";
		};
		// The viewer refuses anything shorter than 540 bytes, so pad to 100 voxels.
		const raw = int16Nifti([0, 1024, 2048, 24, ...new Array(96).fill(1024)], 1, -1024);
		setLocalNiftiFile({ arrayBuffer: async () => raw } as unknown as File);
		await expect(loadLocalNiftiAsRawBlobUrl()).resolves.toBe("blob:scaled");
		// jsdom's Blob has no arrayBuffer(), so read it the old way.
		const bytes = await new Promise<ArrayBuffer>((done) => {
			const reader = new FileReader();
			reader.onload = () => done(reader.result as ArrayBuffer);
			reader.readAsArrayBuffer(handed!);
		});
		expect(readInt16Voxels(bytes, 5)).toEqual([-1024, 0, 1024, -1000, 0]);
		expect(bytes.byteLength).toBe(VOX_OFFSET + 100 * 2);
	});
});
