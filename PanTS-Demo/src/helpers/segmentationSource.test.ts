import { describe, expect, it } from "vitest";
import { datasetSegmentationUrl } from "./segmentationSource";

describe("dataset segmentation URL", () => {
	it("asks the backend for the viewer's organ numbering at full resolution", () => {
		const url = datasetSegmentationUrl("1");
		expect(url).toMatch(/\/api\/get-segmentations\/1\.nii\.gz\?labels=viewer-v1$/);
	});

	it("adds the low-resolution request after the label scheme", () => {
		expect(datasetSegmentationUrl("1", { low: true })).toMatch(/\/api\/get-segmentations\/1\.nii\.gz\?labels=viewer-v1&res=low$/);
	});
});
