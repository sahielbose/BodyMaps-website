/**
 * Degenerate-prompt handling, end to end across the changed seam.
 *
 * Live measurement (case 1, lung_left, 1.56M voxels): a point prompt returns
 * HTTP 200 with X-Mask-Voxels: 8 through the real Flask + model-server stack.
 * These tests replay exactly that response through the REAL client code:
 *
 *  - submitInteractiveSegmentPrompt parses the genuine gzipped NIfTI reply,
 *    applies it to the segmentation volume, and must flag the result as
 *    degenerate (first additive prompt, almost no voxels landed);
 *  - useInteractivePromptTool must turn that flag into the box/lasso steering
 *    message instead of reporting a bare "+8 vox" success.
 *
 * The pure threshold rules live in promptResult.test.ts; this file covers the
 * wiring on both sides of the flag.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { gzipSync } from "node:zlib";
import { Blob as NodeBlob } from "node:buffer";

// ---------------------------------------------------------------------------
// Environment: the helper decompresses via Blob.stream() + DecompressionStream
// + Response. jsdom's Blob has no stream(); Node provides coherent versions
// of all three, so run that whole pipeline on Node's implementations.
(window as any).DecompressionStream = (globalThis as any).DecompressionStream;
(window as any).Response = (globalThis as any).Response;
(window as any).Blob = NodeBlob;

// A tiny but VALID single-file NIfTI-1: 348-byte header + 4 bytes padding,
// uint8 data. dims and voxel values are the caller's.
function makeNifti(dims: [number, number, number], setVoxels: number[]): Uint8Array {
	const nvox = dims[0] * dims[1] * dims[2];
	const buf = new ArrayBuffer(352 + nvox);
	const view = new DataView(buf);
	view.setInt32(0, 348, true); // sizeof_hdr
	view.setInt16(40, 3, true); // dim[0]
	view.setInt16(42, dims[0], true);
	view.setInt16(44, dims[1], true);
	view.setInt16(46, dims[2], true);
	view.setInt16(48, 1, true);
	view.setInt16(70, 2, true); // datatype uint8
	view.setInt16(72, 8, true); // bitpix
	view.setFloat32(108, 352, true); // vox_offset
	const bytes = new Uint8Array(buf);
	bytes[344] = 0x6e; // n
	bytes[345] = 0x2b; // +
	bytes[346] = 0x31; // 1
	bytes[347] = 0x00;
	for (const idx of setVoxels) bytes[352 + idx] = 1;
	return bytes;
}

const DIMS: [number, number, number] = [8, 8, 8];
const N = DIMS[0] * DIMS[1] * DIMS[2];

function mockSegVolume(scalars: Uint8Array) {
	return {
		imageData: { getDimensions: () => [...DIMS] },
		voxelManager: {
			getCompleteScalarDataArray: () => scalars,
			setCompleteScalarDataArray: (next: Uint8Array) => scalars.set(next),
		},
	};
}

function degenerateFetchResponse(): Response {
	// The measured lung reply: 8 voxels out of the whole volume.
	const nii = makeNifti(DIMS, [0, 1, 2, 3, 4, 5, 6, 7]);
	return new Response(gzipSync(nii), {
		status: 200,
		headers: {
			"Content-Type": "application/gzip",
			"X-Mask-Voxels": "8",
			"X-Prompt-Session": "active",
		},
	});
}

describe("submitInteractiveSegmentPrompt flags the measured lung response", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("returns degenerate: true for a first prompt that lands 8 voxels", async () => {
		const { cache } = await import("@cornerstonejs/core");
		const scalars = new Uint8Array(N); // empty class: no seed, first prompt
		vi.spyOn(cache, "getVolume").mockReturnValue(mockSegVolume(scalars) as any);
		vi.stubGlobal("fetch", vi.fn(async () => degenerateFetchResponse()));

		const { submitInteractiveSegmentPrompt } = await import("../helpers/CornerstoneNifti2");
		const session = {
			token: "test-token",
			prevProposal: null as Uint8Array | null,
			priorValues: new Map<number, number>(),
			markers: [] as unknown[],
		};
		const result = await submitInteractiveSegmentPrompt(
			"http://api.test", 1, 7,
			{ pointLps: [83.4, -144.3, -291.8], include: true },
			"low",
			session as any,
		);

		expect(result.added).toBe(8);
		expect(result.changed).toBe(8);
		expect(result.sessionActive).toBe(true);
		expect(result.degenerate).toBe(true);
		// and the voxels really landed in the labelmap as the active segment
		expect(scalars[0]).toBe(7);
		expect(scalars.filter((v) => v === 7).length).toBe(8);
	});

	it("does not flag a refinement of an existing session object", async () => {
		const { cache } = await import("@cornerstonejs/core");
		const scalars = new Uint8Array(N);
		vi.spyOn(cache, "getVolume").mockReturnValue(mockSegVolume(scalars) as any);
		vi.stubGlobal("fetch", vi.fn(async () => degenerateFetchResponse()));

		const { submitInteractiveSegmentPrompt } = await import("../helpers/CornerstoneNifti2");
		const session = {
			token: "test-token",
			// A previous response exists, so this is not a first prompt.
			prevProposal: new Uint8Array(N),
			priorValues: new Map<number, number>(),
			markers: [] as unknown[],
		};
		const result = await submitInteractiveSegmentPrompt(
			"http://api.test", 1, 7,
			{ pointLps: [0, 0, 0], include: true },
			"low",
			session as any,
		);

		expect(result.added).toBe(8);
		expect(result.degenerate).toBe(false);
	});
});

describe("useInteractivePromptTool surfaces the degenerate message", () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function renderArmedHook() {
		// Real hook, with the module boundary it imports mocked at the seam:
		// canvasPointToWorld needs a live Cornerstone engine, and the helper's
		// own behavior is covered by the block above.
		vi.doMock("../helpers/CornerstoneNifti2", async (importOriginal) => {
			const mod = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
			return {
				...mod,
				canvasPointToWorld: () => [1, 2, 3],
				submitInteractiveSegmentPrompt: vi.fn(async () => ({
					changed: 8,
					added: 8,
					removed: 0,
					sessionActive: true,
					degenerate: true,
					proposal: new Uint8Array(N),
				})),
			};
		});
		const { useInteractivePromptTool } = await import("../helpers/viewer/useInteractivePromptTool");
		return renderHook(() =>
			useInteractivePromptTool({
				enabled: true,
				mode: "point",
				apiBase: "http://api.test",
				caseId: 1,
				activeSegmentIndex: 7,
				res: "low",
			} as any),
		);
	}

	it("shows the steering message instead of a bare success", async () => {
		const hook = await renderArmedHook();
		const fakeEvent = {
			clientX: 10, clientY: 10, altKey: false,
			currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		} as unknown as MouseEvent;

		await act(async () => {
			hook.result.current.handleClick("axial")(fakeEvent);
		});

		await waitFor(() => {
			expect(hook.result.current.status).toBe("success");
		});
		const msg = hook.result.current.statusMessage ?? "";
		expect(msg).toContain("almost nothing");
		expect(msg).toContain("8 voxels");
		expect(msg).toMatch(/box or lasso/i);
	});
});
