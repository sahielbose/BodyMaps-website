/**
 * The custom class 3D mesh rebuilds when an edit event names its class, so the
 * events have to name the class the edit changed, also on an undo made after
 * the active class moved on. And since a rebuild runs on the main thread after
 * every settled edit, extraction crops to the class's box; the cropped surface
 * must be the one a full-volume run gives. Runs the real CornerstoneNifti2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { Blob as NodeBlob } from "node:buffer";
import { cache, eventTarget } from "@cornerstonejs/core";
import { Enums as csToolsEnums } from "@cornerstonejs/tools";
import vtkImageData from "@kitware/vtk.js/Common/DataModel/ImageData";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import vtkImageMarchingCubes from "@kitware/vtk.js/Filters/General/ImageMarchingCubes";
import {
	deleteSegmentEverywhere,
	extractSegmentSurface,
	redoMaskEdit,
	resetMaskEditHistory,
	setActiveEditSegment,
	submitInteractiveSegmentPrompt,
	undoMaskEdit,
} from "../helpers/CornerstoneNifti2";

// Same Node-backed pipeline as visualModelPromptUndoMemory.test.tsx.
(window as any).DecompressionStream = (globalThis as any).DecompressionStream;
(window as any).CompressionStream = (globalThis as any).CompressionStream;
(window as any).Response = (globalThis as any).Response;
(window as any).Blob = NodeBlob;

const DIMS: [number, number, number] = [8, 8, 8];
const N = DIMS[0] * DIMS[1] * DIMS[2];
const A = 201;
const B = 202;

function makeNifti(setVoxels: number[]): Uint8Array {
	const buf = new ArrayBuffer(352 + N);
	const view = new DataView(buf);
	view.setInt32(0, 348, true);
	view.setInt16(40, 3, true);
	view.setInt16(42, DIMS[0], true);
	view.setInt16(44, DIMS[1], true);
	view.setInt16(46, DIMS[2], true);
	view.setInt16(48, 1, true);
	view.setInt16(70, 2, true);
	view.setInt16(72, 8, true);
	view.setFloat32(108, 352, true);
	const bytes = new Uint8Array(buf);
	bytes.set([0x6e, 0x2b, 0x31, 0x00], 344);
	for (const idx of setVoxels) bytes[352 + idx] = 1;
	return bytes;
}

function mockVolume(scalars: Uint8Array, dims: [number, number, number] = DIMS) {
	const [nx, ny] = dims;
	const at = (i: number, j: number, k: number) => i + j * nx + k * nx * ny;
	return {
		origin: [-40.5, 12.25, -300],
		spacing: [0.8, 0.7, 1.5],
		direction: [1, 0, 0, 0, -1, 0, 0, 0, 1],
		imageData: { getDimensions: () => [...dims] },
		voxelManager: {
			dimensions: dims,
			getCompleteScalarDataArray: () => scalars,
			setCompleteScalarDataArray: (next: Uint8Array) => scalars.set(next),
			getAtIJK: (i: number, j: number, k: number) => scalars[at(i, j, k)],
			setAtIJK: (i: number, j: number, k: number, v: number) => {
				scalars[at(i, j, k)] = v;
			},
		},
	};
}

let events: Array<number | undefined>;
const onEdit = (event: Event) => events.push((event as CustomEvent).detail?.segmentIndex);

beforeEach(() => {
	events = [];
	eventTarget.addEventListener(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, onEdit);
});
afterEach(() => {
	eventTarget.removeEventListener(csToolsEnums.Events.SEGMENTATION_DATA_MODIFIED, onEdit);
	resetMaskEditHistory();
	setActiveEditSegment(0);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("edit events name the class the edit changed", () => {
	let scalars: Uint8Array;

	beforeEach(() => {
		scalars = new Uint8Array(N);
		vi.spyOn(cache, "getVolume").mockReturnValue(mockVolume(scalars) as any);
	});

	function stubModel(voxels: number[]) {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(gzipSync(makeNifti(voxels)), {
			status: 200,
			headers: { "Content-Type": "application/gzip" },
		})));
	}

	it("reports the prompt's class on its undo and redo after the active class changed", async () => {
		stubModel([1, 2, 3]);
		setActiveEditSegment(A);
		await submitInteractiveSegmentPrompt("http://api.test", 1, A, { pointLps: [0, 0, 0], include: true }, "low");
		expect(events).toEqual([A]);

		setActiveEditSegment(B);
		undoMaskEdit();
		expect(scalars.filter((v) => v === A)).toHaveLength(0);
		redoMaskEdit();
		expect(scalars.filter((v) => v === A)).toHaveLength(3);
		expect(events).toEqual([A, A, A]);
	});

	it("names no class when a prompt takes voxels from another class", async () => {
		scalars[2] = B;
		stubModel([1, 2, 3]);
		setActiveEditSegment(A);
		await submitInteractiveSegmentPrompt("http://api.test", 1, A, { pointLps: [0, 0, 0], include: true }, "low");
		undoMaskEdit();
		expect(scalars[2]).toBe(B);
		expect(events).toEqual([undefined, undefined]);
	});

	it("reports a deleted class on the undo, though it is no longer active", () => {
		scalars[5] = A;
		scalars[6] = A;
		setActiveEditSegment(A);
		deleteSegmentEverywhere(A);
		setActiveEditSegment(B);
		undoMaskEdit();
		expect(scalars.filter((v) => v === A)).toHaveLength(2);
		expect(events).toEqual([A, A]);
	});
});

describe("extractSegmentSurface", () => {
	// The full-volume run the cropped one replaced: pad the whole volume by one
	// voxel, march it, and map each point back through the volume's geometry.
	function fullVolumeSurface(scalars: Uint8Array, dims: [number, number, number], value: number, volume: ReturnType<typeof mockVolume>, center: [number, number, number]) {
		const [nx, ny, nz] = dims;
		const pdims: [number, number, number] = [nx + 2, ny + 2, nz + 2];
		const padded = new Uint8Array(pdims[0] * pdims[1] * pdims[2]);
		for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
			if (scalars[i + j * nx + k * nx * ny] === value) padded[i + 1 + (j + 1) * pdims[0] + (k + 1) * pdims[0] * pdims[1]] = 1;
		}
		const image = vtkImageData.newInstance();
		image.setDimensions(pdims);
		image.setSpacing([1, 1, 1]);
		image.setOrigin([0, 0, 0]);
		image.getPointData().setScalars(vtkDataArray.newInstance({ name: "scalars", values: padded, numberOfComponents: 1 }));
		const mc = vtkImageMarchingCubes.newInstance({ contourValue: 0.5, computeNormals: false, mergePoints: false });
		mc.setInputData(image);
		const out = mc.getOutputData();
		const points = out.getPoints().getData() as Float32Array;
		const polys = out.getPolys().getData() as Uint32Array;
		const { origin: o, spacing: s, direction: d } = volume;
		const positions = new Float32Array(points.length);
		for (let v = 0; v < points.length; v += 3) {
			const i = points[v] - 1, j = points[v + 1] - 1, k = points[v + 2] - 1;
			const x = d[0] * i * s[0] + d[3] * j * s[1] + d[6] * k * s[2] + o[0];
			const y = d[1] * i * s[0] + d[4] * j * s[1] + d[7] * k * s[2] + o[1];
			const z = d[2] * i * s[0] + d[5] * j * s[1] + d[8] * k * s[2] + o[2];
			positions[v] = -x - center[0];
			positions[v + 1] = z - center[1];
			positions[v + 2] = y - center[2];
		}
		const indices: number[] = [];
		for (let p = 0; p < polys.length;) {
			const n = polys[p++];
			for (let c = 0; c < n; c++) indices.push(polys[p++]);
		}
		return { positions, indices: new Uint32Array(indices) };
	}

	it("gives the same surface from the class's box as from the whole volume", () => {
		const dims: [number, number, number] = [24, 20, 18];
		const [nx, ny] = dims;
		const scalars = new Uint8Array(dims[0] * dims[1] * dims[2]);
		const set = (i: number, j: number, k: number, v: number) => {
			scalars[i + j * nx + k * nx * ny] = v;
		};
		// An irregular blob of class A away from every edge, a second lobe touching the
		// volume's corner, and class B right beside it, which must stay out.
		for (let k = 6; k <= 11; k++) for (let j = 5; j <= 12; j++) for (let i = 9; i <= 17; i++) {
			if ((i - 13) ** 2 + (j - 8) ** 2 * 1.5 + (k - 8) ** 2 <= 14) set(i, j, k, A);
		}
		set(0, 0, 0, A);
		set(1, 0, 0, A);
		for (let i = 14; i <= 20; i++) set(i, 13, 9, B);
		const volume = mockVolume(scalars, dims);
		vi.spyOn(cache, "getVolume").mockReturnValue(volume as any);
		const center: [number, number, number] = [3, -2, 7.5];

		for (const lobeAtCorner of [false, true]) {
			if (!lobeAtCorner) {
				set(0, 0, 0, 0);
				set(1, 0, 0, 0);
			} else {
				set(0, 0, 0, A);
				set(1, 0, 0, A);
			}
			const cropped = extractSegmentSurface(A, center);
			const full = fullVolumeSurface(scalars, dims, A, volume, center);
			expect(cropped).not.toBeNull();
			expect(full.positions.length).toBeGreaterThan(0);
			expect(Array.from(cropped!.positions)).toEqual(Array.from(full.positions));
			expect(Array.from(cropped!.indices)).toEqual(Array.from(full.indices));
		}
	});

	it("gives nothing for an empty class", () => {
		const scalars = new Uint8Array(N);
		scalars[10] = B;
		vi.spyOn(cache, "getVolume").mockReturnValue(mockVolume(scalars) as any);
		expect(extractSegmentSurface(A, [0, 0, 0])).toBeNull();
	});
});
