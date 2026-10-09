import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSources } from "./compareSources";

describe("comparison volume resolution", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses preview CT with full-resolution segmentation", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

		const sources = await resolveSources("35");

		expect(sources.ct).toContain("/api/get-main-nifti/35.nii.gz?res=low");
		expect(sources.seg).toContain("/api/get-segmentations/35.nii.gz?labels=viewer-v1");
		expect(sources.seg).not.toContain("res=low");
	});

	it("reads the full-resolution CT when asked", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

		const sources = await resolveSources("35", true);

		expect(sources.ct).toMatch(/\/api\/get-main-nifti\/35\.nii\.gz$/);
		expect(sources.seg).toContain("/api/get-segmentations/35.nii.gz?labels=viewer-v1");
	});

	it("loads the mask from the backend even when the CT comes from the mirror", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));

		const sources = await resolveSources("35");

		expect(sources.ct).toContain("huggingface.co");
		// The mirror's raw mask numbers the spleen, stomach and lesion differently from the viewer.
		expect(sources.seg).toContain("/api/get-segmentations/35.nii.gz?labels=viewer-v1");
		expect(sources.seg).not.toContain("mask_only");
	});
});
