/**
 * Undoing an nnInteractive prompt rewinds the model server's session too,
 * but the server keeps a single undo snapshot and has no redo. So an undo
 * after a redo, or a second undo in a row, can only come back 409; the
 * client now ends the session locally instead of sending that request
 * (the next prompt re-seeds from the labelmap either way). Runs the real
 * submitInteractiveSegmentPrompt and the shared undo stack.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { Blob as NodeBlob } from "node:buffer";

// Same Node-backed pipeline as interactivePromptDegenerate.test.tsx.
(window as any).DecompressionStream = (globalThis as any).DecompressionStream;
(window as any).CompressionStream = (globalThis as any).CompressionStream;
(window as any).Response = (globalThis as any).Response;
(window as any).Blob = NodeBlob;

const DIMS: [number, number, number] = [8, 8, 8];
const N = DIMS[0] * DIMS[1] * DIMS[2];

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

function mockSegVolume(scalars: Uint8Array) {
	return {
		imageData: { getDimensions: () => [...DIMS] },
		voxelManager: {
			getCompleteScalarDataArray: () => scalars,
			setCompleteScalarDataArray: (next: Uint8Array) => scalars.set(next),
		},
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("prompt undo and the server's single-level undo", () => {
	const CLASS = 5;
	let scalars: Uint8Array;
	let undoCalls: number;
	let nextMask: number[];

	beforeEach(async () => {
		vi.restoreAllMocks();
		scalars = new Uint8Array(N);
		undoCalls = 0;
		nextMask = [];
		const { cache } = await import("@cornerstonejs/core");
		vi.spyOn(cache, "getVolume").mockReturnValue(mockSegVolume(scalars) as any);
		vi.stubGlobal("fetch", vi.fn(async (url: string) => {
			if (url.endsWith("/undo")) {
				undoCalls += 1;
				return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
			}
			return new Response(gzipSync(makeNifti(nextMask)), {
				status: 200,
				headers: { "Content-Type": "application/gzip", "X-Prompt-Session": "active" },
			});
		}));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	async function prompt(session: any, voxels: number[]) {
		const { submitInteractiveSegmentPrompt } = await import("../helpers/CornerstoneNifti2");
		nextMask = voxels;
		const result = await submitInteractiveSegmentPrompt(
			"http://api.test", 1, CLASS, { pointLps: [0, 0, 0], include: true }, "low", session,
		);
		// What useInteractivePromptTool does with a live session's answer.
		session.prevProposal = result.proposal;
		return result;
	}

	const newSession = () => ({
		token: `tok-${Math.random()}`,
		prevProposal: null as Uint8Array | null,
		priorValues: new Map<number, number>(),
		markers: [] as unknown[],
	});

	it("rewinds the server once, and not again after a redo", async () => {
		const { undoSmartFill, redoSmartFill } = await import("../helpers/CornerstoneNifti2");
		const session: any = newSession();
		await prompt(session, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

		expect(undoSmartFill()).toBe(true);
		await settle();
		expect(undoCalls).toBe(1);
		expect(scalars.filter((v) => v === CLASS)).toHaveLength(0);

		expect(redoSmartFill()).toBe(true);
		expect(session.dead).toBe(true);
		expect(scalars.filter((v) => v === CLASS)).toHaveLength(10);

		// The redo re-applied voxels the server no longer holds: this undo
		// is local only (it used to POST /undo and get a 409).
		expect(undoSmartFill()).toBe(true);
		await settle();
		expect(undoCalls).toBe(1);
		expect(scalars.filter((v) => v === CLASS)).toHaveLength(0);
	});

	it("sends only the first of two undos in a row", async () => {
		const { undoSmartFill } = await import("../helpers/CornerstoneNifti2");
		const session: any = newSession();
		await prompt(session, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		await prompt(session, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
		expect(scalars.filter((v) => v === CLASS)).toHaveLength(12);

		expect(undoSmartFill()).toBe(true);
		await settle();
		expect(undoCalls).toBe(1);
		expect(session.dead).toBeFalsy();

		expect(undoSmartFill()).toBe(true);
		await settle();
		// The server's one snapshot is used up: the session ends locally and
		// the next prompt re-seeds from the restored labelmap.
		expect(undoCalls).toBe(1);
		expect(session.dead).toBe(true);
		expect(scalars.filter((v) => v === CLASS)).toHaveLength(0);
	});
});
