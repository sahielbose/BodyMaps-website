/**
 * Jump-to-class reads organ centroids from a cache. Every labelmap edit has to
 * drop it, or a class painted after the first jump (or an organ moved by an
 * edit) jumps nowhere or to where it used to be.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache, eventTarget } from "@cornerstonejs/core";
import { Enums as csToolsEnums } from "@cornerstonejs/tools";
import { getOrganCentroids } from "../helpers/CornerstoneNifti2";

const DIMS: [number, number, number] = [4, 4, 4];
const at = (i: number, j: number, k: number) => i + j * DIMS[0] + k * DIMS[0] * DIMS[1];

function mockVolume(data: Uint8Array, loadStatus = { loaded: true }) {
	return {
		loadStatus,
		imageData: { indexToWorld: (p: number[]) => [...p] },
		voxelManager: { dimensions: DIMS, getCompleteScalarDataArray: vi.fn(() => data) },
	};
}

const labelmapEdited = () =>
	eventTarget.dispatchEvent(new CustomEvent(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, { detail: {} }));

describe("organ centroids", () => {
	beforeEach(labelmapEdited); // start each test with an empty cache
	afterEach(() => vi.restoreAllMocks());

	it("finds a class painted after the first jump", () => {
		const data = new Uint8Array(DIMS[0] * DIMS[1] * DIMS[2]);
		data[at(0, 0, 0)] = 3;
		vi.spyOn(cache, "getVolume").mockReturnValue(mockVolume(data) as never);

		expect(getOrganCentroids()?.[5]).toBeUndefined();

		data[at(2, 1, 3)] = 5;
		labelmapEdited();

		expect(getOrganCentroids()?.[5]).toEqual([2, 1, 3]);
	});

	it("follows an organ an edit moved", () => {
		const data = new Uint8Array(DIMS[0] * DIMS[1] * DIMS[2]);
		data[at(0, 0, 0)] = 3;
		vi.spyOn(cache, "getVolume").mockReturnValue(mockVolume(data) as never);
		expect(getOrganCentroids()?.[3]).toEqual([0, 0, 0]);

		data[at(0, 0, 0)] = 0;
		data[at(3, 3, 3)] = 3;
		labelmapEdited();

		expect(getOrganCentroids()?.[3]).toEqual([3, 3, 3]);
	});

	it("does not keep centroids read while slices are still arriving", () => {
		const data = new Uint8Array(DIMS[0] * DIMS[1] * DIMS[2]);
		const status = { loaded: false };
		const volume = mockVolume(data, status);
		vi.spyOn(cache, "getVolume").mockReturnValue(volume as never);

		getOrganCentroids();
		status.loaded = true;
		data[at(1, 1, 1)] = 4;

		expect(getOrganCentroids()?.[4]).toEqual([1, 1, 1]);
		expect(volume.voxelManager.getCompleteScalarDataArray).toHaveBeenCalledTimes(2);
		// Once complete, the answer is kept until the next edit.
		getOrganCentroids();
		expect(volume.voxelManager.getCompleteScalarDataArray).toHaveBeenCalledTimes(2);
	});
});
