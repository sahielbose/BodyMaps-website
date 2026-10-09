/**
 * A local NIfTI that is empty, tiny or not a NIfTI at all is refused up front, so the
 * viewer shows its "couldn't be read" message instead of loading for good.
 */
import { describe, expect, it } from "vitest";
import { loadLocalNiftiAsRawBlobUrl, setLocalNiftiFile } from "../helpers/localNifti";

// jsdom's File has no arrayBuffer(), so the picked file is a stand-in that has one.
function fileOf(bytes: ArrayBuffer): File {
	return { arrayBuffer: async () => bytes } as unknown as File;
}

function header(size: number, littleEndian: boolean, length = 600): File {
	const bytes = new ArrayBuffer(length);
	new DataView(bytes).setInt32(0, size, littleEndian);
	return fileOf(bytes);
}

describe("loadLocalNiftiAsRawBlobUrl", () => {
	it("refuses an empty file", async () => {
		setLocalNiftiFile(fileOf(new ArrayBuffer(0)));
		await expect(loadLocalNiftiAsRawBlobUrl()).rejects.toThrow("Not a NIfTI file");
	});

	it("refuses a file shorter than a NIfTI header", async () => {
		setLocalNiftiFile(header(348, true, 300));
		await expect(loadLocalNiftiAsRawBlobUrl()).rejects.toThrow("Not a NIfTI file");
	});

	it("refuses a file that is not a NIfTI", async () => {
		setLocalNiftiFile(fileOf(new Uint8Array(2000).fill(0x41).buffer));
		await expect(loadLocalNiftiAsRawBlobUrl()).rejects.toThrow("Not a NIfTI file");
	});

	it.each([
		[348, true],
		[348, false],
		[540, true],
		[540, false],
	])("accepts a NIfTI header of size %i (little endian: %s)", async (size, little) => {
		URL.createObjectURL = () => "blob:ok";
		setLocalNiftiFile(header(size, little));
		await expect(loadLocalNiftiAsRawBlobUrl()).resolves.toBe("blob:ok");
	});
});
