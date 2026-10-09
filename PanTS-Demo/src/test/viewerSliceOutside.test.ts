/**
 * A pane's slice index clamps at the last slice, so a plane that has left the scan
 * draws air under a counter that still reads 333/333. These read the plane off the pane's
 * camera and the CT volume's bounds, the way the page does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cache, Enums } from "@cornerstonejs/core";

const engine = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@cornerstonejs/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cornerstonejs/core")>()),
	getRenderingEngine: () => engine.current,
}));

import {
	_setCurrentCtVolumeIdForTests,
	subscribeToSliceChanges,
} from "../helpers/CornerstoneNifti2";

// A 100 mm cube of 2 mm voxels: the voxel centres run from 0 to 100.
const volume = {
	spacing: [2, 2, 2],
	imageData: { getBounds: () => [0, 100, 0, 100, 0, 100] },
};

type FakePane = ReturnType<typeof fakePane>;
function fakePane(normal: number[], focalPoint: number[]) {
	const element = document.createElement("div");
	const camera = { focalPoint, viewPlaneNormal: normal };
	return {
		element,
		camera,
		getCamera: () => camera,
		getSliceIndex: vi.fn(() => Math.min(49, Math.max(0, Math.round(camera.focalPoint[normal.findIndex((n) => n !== 0)] / 2)))),
		getNumberOfSlices: () => 50,
		// What Cornerstone does on a scroll or a crosshair move.
		moveTo(point: number[]) {
			camera.focalPoint = point;
			element.dispatchEvent(new Event(Enums.Events.CAMERA_MODIFIED));
		},
	};
}

let panes: Record<"axial" | "sagittal" | "coronal", FakePane>;
function openPanes(coronalFocal: number[]) {
	panes = {
		axial: fakePane([0, 0, 1], [50, 50, 50]),
		sagittal: fakePane([1, 0, 0], [50, 50, 50]),
		coronal: fakePane([0, 1, 0], coronalFocal),
	};
	const byId: Record<string, FakePane> = {
		CT_NIFTI_AXIAL: panes.axial,
		CT_NIFTI_SAGITTAL: panes.sagittal,
		CT_NIFTI_CORONAL: panes.coronal,
	};
	engine.current = { getViewport: (id: string) => byId[id] };
}

beforeEach(() => {
	vi.spyOn(cache, "getVolume").mockReturnValue(volume as never);
	_setCurrentCtVolumeIdForTests("ct");
});
afterEach(() => {
	_setCurrentCtVolumeIdForTests(null);
	engine.current = undefined;
	vi.restoreAllMocks();
});

describe("subscribeToSliceChanges", () => {
	it("reports a plane that has left the scan even though the slice index stays clamped", () => {
		openPanes([50, 100, 50]);
		const seen: Array<[string, unknown]> = [];
		const stop = subscribeToSliceChanges((pane, info) => seen.push([pane, info]));

		const coronalReads = () => seen.filter(([pane]) => pane === "coronal").map(([, info]) => info);
		// On the last slice: still a slice of the scan, so no notice.
		expect(coronalReads()).toEqual([{ current: 49, total: 50 }]);

		panes.coronal.moveTo([50, 140, 50]);
		expect(coronalReads().at(-1)).toEqual({ current: 49, total: 50, outside: true });

		// Further away, same clamped index: nothing new to say.
		const count = coronalReads().length;
		panes.coronal.moveTo([50, 160, 50]);
		expect(coronalReads()).toHaveLength(count);

		panes.coronal.moveTo([50, 60, 50]);
		expect(coronalReads().at(-1)).toEqual({ current: 30, total: 50 });
		stop();
	});
});
