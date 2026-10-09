import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNiftiImageIds } from "../helpers/compareViewer";

// The Cornerstone NIfTI loader never settles when its fetch fails (it logs and swallows
// the 404), which left /compare-viewer spinning forever on a case that doesn't exist.
// loadNiftiImageIds must turn that into a rejection.
const hang = () => new Promise<string[]>(() => {});

afterEach(() => vi.unstubAllGlobals());

describe("loadNiftiImageIds", () => {
	it("rejects fast when the volume is missing, even though the loader hangs", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
		await expect(loadNiftiImageIds("https://example.test/ct.nii.gz", hang, 60_000)).rejects.toThrow(/404/);
	});

	it("returns the loader's ids when the volume exists", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		const ids = await loadNiftiImageIds("https://example.test/ct.nii.gz", async () => ["nifti:a?frame=0"]);
		expect(ids).toEqual(["nifti:a?frame=0"]);
	});

	it("leaves an inconclusive probe to the loader, and times out if nothing ever answers", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("CORS")));
		await expect(loadNiftiImageIds("https://example.test/ct.nii.gz", async () => ["ok"])).resolves.toEqual(["ok"]);
		await expect(loadNiftiImageIds("https://example.test/ct.nii.gz", hang, 20)).rejects.toThrow(/Timed out/);
	});
});
