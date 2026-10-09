/**
 * Targeting a class used to store a full-volume byte mask of it, once per
 * class, until the viewer closed. Catalog organs never read that baseline (the
 * 3D pane shows them from their baked meshes), and for a custom class it only
 * drew a stale mesh, since the live mesh now rebuilds from the labelmap after
 * every edit. So no baseline is taken for any class.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache } from "@cornerstonejs/core";
import {
	clearEditedSegments,
	consumePreEditSegmentSnapshot,
	markSegmentEdited,
	setActiveEditSegment,
} from "../helpers/CornerstoneNifti2";
import { segmentation_categories } from "../helpers/constants";

const N = 4 * 4 * 4;
const CUSTOM_A = segmentation_categories.length + 1;
const CUSTOM_B = segmentation_categories.length + 2;

let read: ReturnType<typeof vi.fn>;

beforeEach(() => {
	clearEditedSegments();
	const data = new Uint8Array(N);
	read = vi.fn(() => data);
	vi.spyOn(cache, "getVolume").mockReturnValue({
		loadStatus: { loaded: true },
		voxelManager: { dimensions: [4, 4, 4], getCompleteScalarDataArray: read },
	} as never);
	setActiveEditSegment(0); // start from no target
	read.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("pre-edit snapshots", () => {
	it("are not taken for catalog organs", () => {
		setActiveEditSegment(1);
		setActiveEditSegment(2);

		expect(read).not.toHaveBeenCalled(); // no full-volume copy per pick either
		expect(consumePreEditSegmentSnapshot(1)).toBeNull();
		expect(consumePreEditSegmentSnapshot(2)).toBeNull();
	});

	it("are not taken for a custom class, edited or not", () => {
		setActiveEditSegment(CUSTOM_A);
		markSegmentEdited(CUSTOM_A);
		setActiveEditSegment(CUSTOM_B);

		expect(read).not.toHaveBeenCalled();
		expect(consumePreEditSegmentSnapshot(CUSTOM_A)).toBeNull();
		expect(consumePreEditSegmentSnapshot(CUSTOM_B)).toBeNull();
	});
});
