/**
 * After the backend's idle reaper (or a restart) drops a prompt session, a
 * fresh server session would answer the next click with a one-prompt object,
 * and the client, still diffing against the old object, retracted the rest
 * of it. The client now tells the server it expects the session to exist,
 * recognises the refusal, and never applies a mask for a lost session. A
 * prompt the user cancels is likewise never applied, however late the
 * cancel lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { Blob as NodeBlob } from "node:buffer";

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

const CLASS = 5;
let scalars: Uint8Array;
let bodies: Record<string, unknown>[];
let reply: () => Response;

beforeEach(async () => {
	vi.restoreAllMocks();
	scalars = new Uint8Array(N);
	bodies = [];
	reply = () => new Response(gzipSync(makeNifti([1, 2, 3])), {
		status: 200,
		headers: { "Content-Type": "application/gzip", "X-Prompt-Session": "active" },
	});
	const { cache } = await import("@cornerstonejs/core");
	vi.spyOn(cache, "getVolume").mockReturnValue({
		imageData: { getDimensions: () => [...DIMS] },
		voxelManager: {
			getCompleteScalarDataArray: () => scalars,
			setCompleteScalarDataArray: (next: Uint8Array) => scalars.set(next),
		},
	} as never);
	vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
		bodies.push(JSON.parse(String(init.body)));
		return reply();
	}));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const newSession = () => ({
	token: "tok",
	prevProposal: null as Uint8Array | null,
	priorValues: new Map<number, number>(),
	markers: [] as unknown[],
});

describe("a prompt on a session the server may have dropped", () => {
	it("says it expects the session once it holds an object", async () => {
		const { submitInteractiveSegmentPrompt } = await import("../helpers/CornerstoneNifti2");
		const session: any = newSession();
		const first = await submitInteractiveSegmentPrompt("http://api.test", 1, CLASS, { pointLps: [0, 0, 0] }, "low", session);
		session.prevProposal = first.proposal;
		await submitInteractiveSegmentPrompt("http://api.test", 1, CLASS, { pointLps: [0, 0, 0] }, "low", session);

		expect(bodies[0].expect_session).toBeUndefined();
		expect(bodies[1].expect_session).toBe(true);
	});

	it("throws PromptSessionLostError on the server's refusal and leaves the labelmap alone", async () => {
		const { submitInteractiveSegmentPrompt, PromptSessionLostError } = await import("../helpers/CornerstoneNifti2");
		const session: any = newSession();
		session.prevProposal = new Uint8Array(N);
		scalars[1] = CLASS;
		const before = scalars.slice();
		reply = () => new Response(JSON.stringify({ error: "gone", code: "session_lost" }), {
			status: 409, headers: { "Content-Type": "application/json" },
		});

		await expect(
			submitInteractiveSegmentPrompt("http://api.test", 1, CLASS, { pointLps: [0, 0, 0], include: false }, "low", session),
		).rejects.toBeInstanceOf(PromptSessionLostError);
		expect(scalars).toEqual(before);
	});

	it("keeps other 409s as ordinary errors", async () => {
		const { submitInteractiveSegmentPrompt, PromptSessionLostError } = await import("../helpers/CornerstoneNifti2");
		reply = () => new Response(JSON.stringify({ error: "nope" }), {
			status: 409, headers: { "Content-Type": "application/json" },
		});
		const err = await submitInteractiveSegmentPrompt("http://api.test", 1, CLASS, { pointLps: [0, 0, 0] }, "low", newSession() as any)
			.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(PromptSessionLostError);
		expect(err.message).toBe("nope");
	});
});

describe("a cancelled prompt", () => {
	it("hands the signal to the request", async () => {
		const { submitInteractiveSegmentPrompt } = await import("../helpers/CornerstoneNifti2");
		const controller = new AbortController();
		await submitInteractiveSegmentPrompt("http://api.test", 1, CLASS, { pointLps: [0, 0, 0] }, "low", newSession() as any, controller.signal);
		const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
		expect(init.signal).toBe(controller.signal);
	});

	it("is not applied when the cancel lands after the answer arrived", async () => {
		const { submitInteractiveSegmentPrompt, canUndoSmartFill, resetMaskEditHistory } = await import("../helpers/CornerstoneNifti2");
		resetMaskEditHistory();
		const controller = new AbortController();
		reply = () => {
			const r = new Response(gzipSync(makeNifti([1, 2, 3])), {
				status: 200,
				headers: { "Content-Type": "application/gzip", "X-Prompt-Session": "active" },
			});
			const read = r.arrayBuffer.bind(r);
			// The cancel arrives while the body is being read.
			r.arrayBuffer = async () => { const b = await read(); controller.abort(); return b; };
			return r;
		};

		const err = await submitInteractiveSegmentPrompt(
			"http://api.test", 1, CLASS, { pointLps: [0, 0, 0] }, "low", newSession() as any, controller.signal,
		).catch((e) => e);

		expect(err.name).toBe("AbortError");
		expect(scalars.every((v) => v === 0)).toBe(true);
		expect(canUndoSmartFill()).toBe(false);
	});
});
