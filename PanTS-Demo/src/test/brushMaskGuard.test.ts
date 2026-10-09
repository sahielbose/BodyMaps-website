/**
 * The brush's masking guard snapshots the labelmap at pointerdown and, at
 * pointerup, puts back whatever the stroke painted outside the masking area.
 * With no restriction there is nothing to put back, so no snapshot (a
 * full-volume copy) is taken; with one, the check is a flat compare against
 * a single read, not a getAtIJK call per voxel.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cache } from "@cornerstonejs/core";
import { beginBrushMaskGuard, endBrushMaskGuard } from "../helpers/CornerstoneNifti2";

const DIMS: [number, number, number] = [4, 4, 4];
const at = (i: number, j: number, k: number) => i + j * DIMS[0] + k * DIMS[0] * DIMS[1];

function mockVolume(data: Uint8Array) {
	const voxelManager = {
		dimensions: DIMS,
		// A fresh copy per call, like the image-backed volume's voxel manager.
		getCompleteScalarDataArray: vi.fn(() => data.slice()),
		getAtIJK: vi.fn((i: number, j: number, k: number) => data[at(i, j, k)]),
		setAtIJK: vi.fn((i: number, j: number, k: number, v: number) => { data[at(i, j, k)] = v; }),
	};
	return { voxelManager };
}

afterEach(() => vi.restoreAllMocks());

describe("brush masking guard", () => {
	it("takes no snapshot when the brush may paint everywhere", () => {
		const volume = mockVolume(new Uint8Array(64));
		vi.spyOn(cache, "getVolume").mockReturnValue(volume as never);

		beginBrushMaskGuard("everywhere");
		endBrushMaskGuard("everywhere", []);

		expect(volume.voxelManager.getCompleteScalarDataArray).not.toHaveBeenCalled();
		expect(volume.voxelManager.setAtIJK).not.toHaveBeenCalled();
	});

	it("puts back only what the stroke painted outside the area", () => {
		const data = new Uint8Array(64);
		data[at(1, 1, 1)] = 2; // inside the allowed class
		data[at(2, 2, 2)] = 3; // another class
		const volume = mockVolume(data);
		vi.spyOn(cache, "getVolume").mockReturnValue(volume as never);

		beginBrushMaskGuard("insideSegment");
		// The stroke paints class 7 over both, and over background.
		data[at(1, 1, 1)] = 7;
		data[at(2, 2, 2)] = 7;
		data[at(3, 0, 1)] = 7;
		endBrushMaskGuard("insideSegment", [2]);

		expect(data[at(1, 1, 1)]).toBe(7);
		expect(data[at(2, 2, 2)]).toBe(3);
		expect(data[at(3, 0, 1)]).toBe(0);
		expect(volume.voxelManager.getCompleteScalarDataArray).toHaveBeenCalledTimes(2);
		expect(volume.voxelManager.getAtIJK).not.toHaveBeenCalled();
		expect(volume.voxelManager.setAtIJK).toHaveBeenCalledTimes(2);
	});
});
