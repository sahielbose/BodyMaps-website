/**
 * Brush masking runs on every organ tick, tool switch and target pick, and
 * each read of the labelmap copies the whole volume. The lock loop only needs
 * the highest label, so the volume is read once and the answer kept.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cache } from "@cornerstonejs/core";
import * as cornerstoneTools from "@cornerstonejs/tools";
import { getPresentSegmentIndices, setBrushMaskingScope } from "../helpers/CornerstoneNifti2";

const N = 4 * 4 * 4;

function mockVolume(data: Uint8Array) {
	return {
		loadStatus: { loaded: true },
		voxelManager: { dimensions: [4, 4, 4], getCompleteScalarDataArray: vi.fn(() => data) },
	};
}

function lockedLabels() {
	const locked = new Map<number, boolean>();
	vi.spyOn(cornerstoneTools.segmentation.segmentLocking, "setSegmentIndexLocked").mockImplementation(
		(_id: string, index: number, isLocked = true) => { locked.set(index, isLocked); },
	);
	return locked;
}

afterEach(() => vi.restoreAllMocks());

describe("brush masking scope", () => {
	it("reads the labelmap once, however often the scope changes", () => {
		const data = new Uint8Array(N);
		data[5] = 40; // above the colour table: only a read of the volume finds it
		const volume = mockVolume(data);
		vi.spyOn(cache, "getVolume").mockReturnValue(volume as never);
		const locked = lockedLabels();

		setBrushMaskingScope([1, 2]);
		setBrushMaskingScope([2]);
		setBrushMaskingScope("all");
		setBrushMaskingScope([3]);

		expect(volume.voxelManager.getCompleteScalarDataArray).toHaveBeenCalledTimes(1);
		// The highest label is still covered by the lock.
		expect(locked.get(40)).toBe(true);
		expect(locked.get(3)).toBe(false);
	});

	it("reuses the class list's pass instead of reading again", () => {
		const data = new Uint8Array(N);
		data[9] = 12;
		const volume = mockVolume(data);
		vi.spyOn(cache, "getVolume").mockReturnValue(volume as never);
		const locked = lockedLabels();

		expect(getPresentSegmentIndices()).toEqual(new Set([0, 12]));
		setBrushMaskingScope([1]);

		expect(volume.voxelManager.getCompleteScalarDataArray).toHaveBeenCalledTimes(1);
		expect(locked.get(12)).toBe(true);
	});
});
