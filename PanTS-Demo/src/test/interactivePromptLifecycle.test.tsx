/**
 * Prompt session lifecycle in useInteractivePromptTool: every session the
 * hook drops gives its model-server lease back, and a pointer gesture only
 * becomes a prompt when it really was a click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PromptSessionState } from "../helpers/CornerstoneNifti2";

const N = 8 * 8 * 8;
const released: string[] = [];
const sessions: PromptSessionState[] = [];
type SubmitImpl = (session: PromptSessionState, signal?: AbortSignal) => Promise<unknown>;
let submitImpl: SubmitImpl;

const ok = () => ({
	changed: 5, added: 5, removed: 0, sessionActive: true, degenerate: false, modelFallback: false,
	proposal: new Uint8Array(N),
});

function mouse(x: number, y: number, extra: Record<string, unknown> = {}) {
	return {
		clientX: x, clientY: y, altKey: false, button: 0,
		currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
		...extra,
	} as unknown as MouseEvent;
}

async function renderArmed(props: Record<string, unknown> = {}) {
	vi.doMock("../helpers/CornerstoneNifti2", async (importOriginal) => {
		const mod = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
		return {
			...mod,
			canvasPointToWorld: () => [1, 2, 3],
			getSegmentationSpacing: () => null,
			releasePromptSession: vi.fn((_api: string, _case: unknown, token: string) => released.push(token)),
			submitInteractiveSegmentPrompt: vi.fn(
				(_api: string, _case: unknown, _idx: number, _prompt: unknown, _res: string, session: PromptSessionState, signal?: AbortSignal) => {
					sessions.push(session);
					return submitImpl(session, signal);
				},
			),
		};
	});
	const { useInteractivePromptTool } = await import("../helpers/viewer/useInteractivePromptTool");
	return renderHook(() =>
		useInteractivePromptTool({
			enabled: true, mode: "point", apiBase: "http://api.test", caseId: 1, activeSegmentIndex: 7, res: "low",
			...props,
		} as never),
	);
}

type Hook = Awaited<ReturnType<typeof renderArmed>>;

async function click(hook: Hook, x = 10, y = 10) {
	await act(async () => {
		hook.result.current.handleClick("axial")(mouse(x, y) as never);
	});
	await waitFor(() => expect(hook.result.current.status).not.toBe("applying"));
}

beforeEach(() => {
	vi.resetModules();
	released.length = 0;
	sessions.length = 0;
	submitImpl = async () => ok();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.doUnmock("../helpers/CornerstoneNifti2");
});

describe("a dead prompt session", () => {
	it("gives its lease back when the next prompt replaces it", async () => {
		const hook = await renderArmed();
		await click(hook);
		const first = sessions[0];
		// What a redo, or a second undo in a row, does to the session.
		first.dead = true;

		await click(hook);

		expect(released).toEqual([first.token]);
		expect(sessions[1].token).not.toBe(first.token);
		expect(sessions[1].dead).toBeFalsy();
	});
});

describe("segment from click", () => {
	it("ignores the click that ends a left-drag pan", async () => {
		const hook = await renderArmed();
		await act(async () => {
			hook.result.current.handleMouseDown("axial")(mouse(10, 10) as never);
			hook.result.current.handleClick("axial")(mouse(60, 42) as never);
		});
		expect(sessions).toHaveLength(0);
		expect(hook.result.current.status).toBe("idle");
	});

	it("still prompts on a click with a little hand jitter", async () => {
		const hook = await renderArmed();
		await act(async () => {
			hook.result.current.handleMouseDown("axial")(mouse(10, 10) as never);
		});
		await click(hook, 12, 11);
		expect(sessions).toHaveLength(1);
	});
});

describe("a session the server has dropped", () => {
	it("is released and the same prompt runs again on a fresh, seeded session", async () => {
		const { PromptSessionLostError } = await vi.importActual<typeof import("../helpers/CornerstoneNifti2")>(
			"../helpers/CornerstoneNifti2",
		);
		const hook = await renderArmed();
		await click(hook);
		const first = sessions[0];
		first.prevProposal = new Uint8Array(N);

		// The next prompt on that token is refused; the retry on a new one works.
		let calls = 0;
		const startedEmpty: boolean[] = [];
		submitImpl = async (session) => {
			calls += 1;
			startedEmpty.push(session.prevProposal === null);
			if (calls === 1) throw new PromptSessionLostError("gone");
			return ok();
		};
		await click(hook);

		expect(sessions).toHaveLength(3);
		expect(sessions[1]).toBe(first);
		expect(first.dead).toBe(true);
		expect(released).toEqual([first.token]);
		expect(sessions[2].token).not.toBe(first.token);
		// The retry went out with no previous answer, which is what makes the
		// engine seed it from the class as it stands.
		expect(startedEmpty).toEqual([false, true]);
		expect(hook.result.current.status).not.toBe("error");
	});
});

describe("a prompt with no dataset case", () => {
	it("says why nothing happened instead of only logging it", async () => {
		const hook = await renderArmed({ caseId: null });
		const { MODEL_NEEDS_DATASET_CASE } = await import("../helpers/viewer/useInteractivePromptTool");
		await act(async () => {
			hook.result.current.handleClick("axial")(mouse(10, 10) as never);
		});
		expect(sessions).toHaveLength(0);
		expect(hook.result.current.status).toBe("error");
		expect(hook.result.current.statusMessage).toBe(MODEL_NEEDS_DATASET_CASE);
	});
});

describe("an answer from the region-grow fallback", () => {
	it("tells the user the model was not used", async () => {
		submitImpl = async () => ({ ...ok(), sessionActive: false, modelFallback: true, proposal: null });
		const hook = await renderArmed();
		await click(hook);
		expect(hook.result.current.status).toBe("success");
		expect(hook.result.current.statusMessage).toMatch(/model didn't answer/);
		expect(hook.result.current.statusMessage).not.toContain("—");
	});
});

describe("a prompt the model server sits on", () => {
	const hang: SubmitImpl = (_session, signal) =>
		new Promise((_resolve, reject) => {
			signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		});

	it("can be cancelled from the applying card, ending its session", async () => {
		submitImpl = hang;
		const hook = await renderArmed();
		await act(async () => {
			hook.result.current.handleClick("axial")(mouse(10, 10) as never);
		});
		expect(hook.result.current.status).toBe("applying");

		await act(async () => {
			hook.result.current.cancelPrompt();
		});

		expect(hook.result.current.status).toBe("idle");
		expect(hook.result.current.statusMessage).toBeNull();
		// The server may still finish it, so the session can't be trusted.
		expect(sessions[0].dead).toBe(true);
		expect(released).toEqual([sessions[0].token]);

		submitImpl = async () => ok();
		await click(hook);
		expect(sessions[1].token).not.toBe(sessions[0].token);
		expect(released).toEqual([sessions[0].token]); // not released twice
	});

	it("is stopped when the viewer closes, so its answer never reaches the next case", async () => {
		const signals: AbortSignal[] = [];
		submitImpl = (session, signal) => {
			if (signal) signals.push(signal);
			return hang(session, signal);
		};
		const hook = await renderArmed();
		await act(async () => {
			hook.result.current.handleClick("axial")(mouse(10, 10) as never);
		});
		expect(signals[0].aborted).toBe(false);

		hook.unmount();

		expect(signals[0].aborted).toBe(true);
		await waitFor(() => expect(released).toEqual([sessions[0].token]));
	});

	it("is stopped when the class changes under it", async () => {
		const signals: AbortSignal[] = [];
		submitImpl = (session, signal) => {
			if (signal) signals.push(signal);
			return hang(session, signal);
		};
		let segment = 7;
		vi.doMock("../helpers/CornerstoneNifti2", async (importOriginal) => {
			const mod = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
			return {
				...mod,
				canvasPointToWorld: () => [1, 2, 3],
				getSegmentationSpacing: () => null,
				releasePromptSession: vi.fn((_api: string, _case: unknown, token: string) => released.push(token)),
				submitInteractiveSegmentPrompt: vi.fn(
					(_api: string, _case: unknown, _idx: number, _prompt: unknown, _res: string, session: PromptSessionState, signal?: AbortSignal) => {
						sessions.push(session);
						return submitImpl(session, signal);
					},
				),
			};
		});
		const { useInteractivePromptTool } = await import("../helpers/viewer/useInteractivePromptTool");
		const hook = renderHook(() =>
			useInteractivePromptTool({
				enabled: true, mode: "point", apiBase: "http://api.test", caseId: 1, activeSegmentIndex: segment, res: "low",
			} as never),
		);
		await act(async () => {
			hook.result.current.handleClick("axial")(mouse(10, 10) as never);
		});
		segment = 8;
		await act(async () => hook.rerender());

		expect(signals[0].aborted).toBe(true);
		await waitFor(() => expect(hook.result.current.status).toBe("idle"));
	});

	it("gives up after the deadline and says so", async () => {
		submitImpl = hang;
		const hook = await renderArmed();
		const { PROMPT_TIMEOUT_MS } = await import("../helpers/viewer/useInteractivePromptTool");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		await act(async () => {
			hook.result.current.handleClick("axial")(mouse(10, 10) as never);
		});
		expect(hook.result.current.status).toBe("applying");

		await act(async () => {
			vi.advanceTimersByTime(PROMPT_TIMEOUT_MS);
		});

		expect(hook.result.current.status).toBe("error");
		expect(hook.result.current.statusMessage).toMatch(/longer than 6 minutes/);
		expect(sessions[0].dead).toBe(true);
		expect(released).toEqual([sessions[0].token]);
	});
});

