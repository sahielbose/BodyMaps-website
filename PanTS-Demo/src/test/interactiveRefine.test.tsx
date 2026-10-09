/**
 * The Refine tool and the prompt-session plumbing around it, through the
 * real client code:
 *
 *  - refineClassWithModel sends the class's voxels with no point, applies the
 *    model's redraw as a replacement (adds, and retractions of seed voxels the
 *    model dropped), never overwrites a neighbouring class, is one undoable
 *    edit with no server-side undo call, and releases its session;
 *  - releasePromptSession beacons as text/plain and falls back to a keepalive
 *    fetch when the browser won't queue the beacon;
 *  - the capabilities fetch drives which model tools the toolbar offers;
 *  - useInteractivePromptTool gives its lease back on unmount and on pagehide.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { gzipSync, gunzipSync } from "node:zlib";
import { Blob as NodeBlob } from "node:buffer";

// Same Node-backed pipeline as interactivePromptDegenerate.test.tsx: the
// helper gzips the seed and gunzips the reply through the stream APIs.
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

async function blobText(blob: Blob): Promise<string> {
	return await (blob as unknown as NodeBlob).text();
}

describe("refineClassWithModel", () => {
	const CLASS = 7;
	const NEIGHBOUR = 3;
	let scalars: Uint8Array;
	let requests: { url: string; body: any }[];
	let beacons: { url: string; blob: Blob }[];

	beforeEach(async () => {
		vi.restoreAllMocks();
		scalars = new Uint8Array(N);
		for (let i = 10; i < 18; i++) scalars[i] = CLASS; // the rough class
		scalars[20] = NEIGHBOUR;
		scalars[21] = NEIGHBOUR;
		const { cache } = await import("@cornerstonejs/core");
		vi.spyOn(cache, "getVolume").mockReturnValue(mockSegVolume(scalars) as any);
		requests = [];
		beacons = [];
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
			// The redraw keeps 10-15, drops 16-17, reaches into the neighbour
			// at 20, and claims unlabeled 30.
			return new Response(gzipSync(makeNifti([10, 11, 12, 13, 14, 15, 20, 30])), {
				status: 200,
				headers: { "Content-Type": "application/gzip", "X-Prompt-Session": "active" },
			});
		}));
		Object.defineProperty(navigator, "sendBeacon", {
			configurable: true,
			value: vi.fn((url: string, blob: Blob) => {
				beacons.push({ url, blob });
				return true;
			}),
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("sends the class with no point and replaces it with the redraw", async () => {
		const { refineClassWithModel } = await import("../helpers/CornerstoneNifti2");
		const r = await refineClassWithModel("http://api.test", 1, CLASS, "full");

		expect(requests).toHaveLength(1);
		const body = requests[0].body;
		expect(requests[0].url).toBe("http://api.test/api/interactive-segment/1");
		expect(body.refine).toBe(true);
		expect(body.point_lps).toBeUndefined();
		expect(body.res).toBe("full");
		expect(typeof body.session_token).toBe("string");
		const seed = gunzipSync(Buffer.from(body.initial_seg_gz_b64, "base64"));
		expect([...seed].reduce((a, b) => a + b, 0)).toBe(8);

		for (let i = 10; i < 16; i++) expect(scalars[i]).toBe(CLASS);
		expect(scalars[16]).toBe(0);
		expect(scalars[17]).toBe(0);
		expect(scalars[20]).toBe(NEIGHBOUR); // a neighbouring class keeps its voxel
		expect(scalars[30]).toBe(CLASS);
		expect(r).toMatchObject({ added: 1, removed: 2, changed: 3, sessionActive: true });

		// Its session is released as soon as it answers.
		expect(beacons).toHaveLength(1);
		expect(beacons[0].url).toBe("http://api.test/api/interactive-segment/1/release");
		expect(JSON.parse(await blobText(beacons[0].blob))).toEqual({ session_token: body.session_token });
	});

	it("is one undoable edit, with nothing to rewind on the server", async () => {
		const { refineClassWithModel, undoSmartFill } = await import("../helpers/CornerstoneNifti2");
		const before = scalars.slice();
		await refineClassWithModel("http://api.test", 1, CLASS, "full");

		expect(undoSmartFill()).toBe(true);
		expect([...scalars]).toEqual([...before]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(requests.some((q) => q.url.endsWith("/undo"))).toBe(false);
	});

	it("explains an empty class without calling the server", async () => {
		scalars.fill(0);
		const { refineClassWithModel } = await import("../helpers/CornerstoneNifti2");
		await expect(refineClassWithModel("http://api.test", 1, CLASS, "full")).rejects.toThrow(/no voxels to refine/);
		expect(requests).toHaveLength(0);
	});

	it("explains a removal with nothing to remove from without naming a mouse button", async () => {
		const { submitInteractiveSegmentPrompt } = await import("../helpers/CornerstoneNifti2");
		const error = await submitInteractiveSegmentPrompt(
			"http://api.test", 1, 99, { pointLps: [0, 0, 0], include: false } as any, "full",
		).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Add something to the object first. Removing then works on that object.");
		expect((error as Error).message).not.toMatch(/click|button|alt/i);
		expect(requests).toHaveLength(0);
	});

	it("surfaces the server's refusal as the error message", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(
			JSON.stringify({ error: "The model found nothing to keep in this class, so it was left as it was." }),
			{ status: 422, headers: { "Content-Type": "application/json" } },
		)));
		const before = scalars.slice();
		const { refineClassWithModel } = await import("../helpers/CornerstoneNifti2");
		await expect(refineClassWithModel("http://api.test", 1, CLASS, "full")).rejects.toThrow(/left as it was/);
		expect([...scalars]).toEqual([...before]);
		expect(beacons).toHaveLength(1); // released even though it failed
	});
});

describe("releasePromptSession", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("beacons as text/plain so a cross-origin release needs no preflight", async () => {
		const sent: Blob[] = [];
		Object.defineProperty(navigator, "sendBeacon", {
			configurable: true,
			value: vi.fn((_url: string, blob: Blob) => {
				sent.push(blob);
				return true;
			}),
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const { releasePromptSession } = await import("../helpers/CornerstoneNifti2");
		releasePromptSession("http://api.test", 4, "tok");

		expect(sent).toHaveLength(1);
		expect(sent[0].type).toMatch(/^text\/plain/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("falls back to a keepalive fetch when the browser won't queue the beacon", async () => {
		Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: vi.fn(() => false) });
		const fetchMock = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		const { releasePromptSession } = await import("../helpers/CornerstoneNifti2");
		releasePromptSession("http://api.test", 4, "tok");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("http://api.test/api/interactive-segment/4/release");
		expect(init.keepalive).toBe(true);
		expect(JSON.parse(String(init.body))).toEqual({ session_token: "tok" });
	});
});

describe("model capabilities", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("offers every model tool until the server says otherwise", async () => {
		const mod = await import("../helpers/viewer/interactiveAttribution");
		mod._resetInteractiveLicenseForTests();
		for (const id of ["pointSegment", "boxSegment", "scribbleSegment", "lassoSegment", "refineSegment", "paint"]) {
			expect(mod.modelToolOffered(id, null)).toBe(true);
		}
	});

	it("hides exactly the tools the loaded checkpoint can't serve", async () => {
		const mod = await import("../helpers/viewer/interactiveAttribution");
		mod._resetInteractiveLicenseForTests();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			available: true,
			license: "CC BY-NC-SA 4.0",
			interactions: { point: true, box: true, scribble: false, lasso: null },
			refine: false,
			undo: true,
		}))));
		mod.primeInteractiveLicense("http://api.test");
		await waitFor(() => expect(mod.interactiveCapabilities()).not.toBeNull());

		const caps = mod.interactiveCapabilities();
		expect(mod.modelToolOffered("pointSegment", caps)).toBe(true);
		expect(mod.modelToolOffered("boxSegment", caps)).toBe(true);
		expect(mod.modelToolOffered("scribbleSegment", caps)).toBe(false);
		expect(mod.modelToolOffered("lassoSegment", caps)).toBe(true); // not reported, so kept
		expect(mod.modelToolOffered("refineSegment", caps)).toBe(false);
		expect(mod.modelToolOffered("paint", caps)).toBe(true);
	});

	it("keeps every tool when the model server is down", async () => {
		const mod = await import("../helpers/viewer/interactiveAttribution");
		mod._resetInteractiveLicenseForTests();
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
			available: false, license: null, interactions: null, refine: null, undo: null,
		}))));
		mod.primeInteractiveLicense("http://api.test");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(mod.interactiveCapabilities()).toBeNull();
	});
});

describe("useInteractivePromptTool gives its lease back", () => {
	const released: string[] = [];

	beforeEach(() => {
		vi.resetModules();
		released.length = 0;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.doUnmock("../helpers/CornerstoneNifti2");
	});

	async function renderWithOneSession() {
		vi.doMock("../helpers/CornerstoneNifti2", async (importOriginal) => {
			const mod = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
			return {
				...mod,
				canvasPointToWorld: () => [1, 2, 3],
				releasePromptSession: vi.fn((_api: string, _case: unknown, token: string) => released.push(token)),
				submitInteractiveSegmentPrompt: vi.fn(async () => ({
					changed: 5, added: 5, removed: 0, sessionActive: true, degenerate: false,
					proposal: new Uint8Array(N),
				})),
			};
		});
		const { useInteractivePromptTool } = await import("../helpers/viewer/useInteractivePromptTool");
		const hook = renderHook(() =>
			useInteractivePromptTool({
				enabled: true, mode: "point", apiBase: "http://api.test", caseId: 1, activeSegmentIndex: 7, res: "low",
			} as any),
		);
		const click = {
			clientX: 10, clientY: 10, altKey: false,
			currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		} as unknown as MouseEvent;
		await act(async () => {
			hook.result.current.handleClick("axial")(click);
		});
		await waitFor(() => expect(hook.result.current.status).not.toBe("applying"));
		return hook;
	}

	it("on unmount", async () => {
		const hook = await renderWithOneSession();
		expect(released).toHaveLength(0);
		hook.unmount();
		expect(released).toHaveLength(1);
	});

	it("when the tab is closed or navigated away", async () => {
		const hook = await renderWithOneSession();
		window.dispatchEvent(new Event("pagehide"));
		expect(released).toHaveLength(1);
		// Already released: unmounting afterwards must not release it twice.
		hook.unmount();
		expect(released).toHaveLength(1);
	});
});
