import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAIModels } from "../components/AIAssistant/useAIModels";

const installed = {
  available: true,
  models: [{ name: "llama3.1:latest" }, { name: "qwen3:4b" }, { name: "qwen3-vl:4b" }],
  default_model: "llama3.1:latest",
  vision_model: "qwen3-vl:4b",
  vision_available: true,
};
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
const settle = async () => { await act(async () => {}); };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("discovers the actual installed models after a service restart without reopening the sidebar", async () => {
  const fetchModels = vi.fn()
    .mockResolvedValueOnce(response({ available: false, models: [] }))
    .mockResolvedValue(response(installed));
  vi.stubGlobal("fetch", fetchModels);
  const { result } = renderHook(() => useAIModels(true));
  await settle();
  expect(result.current.modelState).toBe("fallback");
  expect(result.current.modelIssue).toBe("unavailable");
  expect(result.current.models).toEqual([]);

  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  expect(result.current.modelState).toBe("ollama");
  expect(result.current.models).toEqual(installed.models);
  expect(result.current.visionAvailable).toBe(true);
  expect(result.current.selectedModel).toBe("llama3.1:latest");
  expect(result.current.modelIssue).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchModels).toHaveBeenCalledTimes(2);
});

it("distinguishes a reachable empty service and supports an immediate retry", async () => {
  const fetchModels = vi.fn()
    .mockResolvedValueOnce(response({ available: true, models: [], vision_available: false }))
    .mockResolvedValue(response(installed));
  vi.stubGlobal("fetch", fetchModels);
  const { result } = renderHook(() => useAIModels(true));
  await settle();
  expect(result.current.modelIssue).toBe("empty");
  expect(result.current.visionAvailable).toBe(false);
  await act(async () => { await result.current.refreshModels(); });
  expect(result.current.models).toHaveLength(3);
  expect(fetchModels).toHaveBeenCalledTimes(2);
});

it("preserves a user's installed model choice across refreshes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(installed)));
  const { result } = renderHook(() => useAIModels(true));
  await settle();
  act(() => result.current.selectModel("qwen3:4b"));
  await act(async () => { await result.current.refreshModels(); });
  expect(result.current.selectedModel).toBe("qwen3:4b");
});

it("never selects a configured default that is not installed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
    ...installed, default_model: "missing:latest", models: [{ name: "qwen3:4b" }],
  })));
  const { result } = renderHook(() => useAIModels(true));
  await settle();
  expect(result.current.selectedModel).toBe("qwen3:4b");
});

it("pauses automatic retries in a hidden tab and refreshes when it becomes visible", async () => {
  const fetchModels = vi.fn().mockResolvedValue(response({ available: false, models: [] }));
  vi.stubGlobal("fetch", fetchModels);
  renderHook(() => useAIModels(true));
  await settle();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchModels).toHaveBeenCalledTimes(1);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(fetchModels).toHaveBeenCalledTimes(2);
});

it("aborts discovery on close and ignores a stale response after reopening", async () => {
  let finishOld!: (value: Response) => void;
  const fetchModels = vi.fn()
    .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
    .mockResolvedValue(response(installed));
  vi.stubGlobal("fetch", fetchModels);
  const { result, rerender } = renderHook(({ open }) => useAIModels(open), { initialProps: { open: true } });
  const signal = fetchModels.mock.calls[0][1].signal as AbortSignal;
  rerender({ open: false });
  expect(signal.aborted).toBe(true);
  rerender({ open: true });
  await settle();
  await act(async () => finishOld(response({ available: false, models: [] })));
  expect(result.current.models).toEqual(installed.models);
  rerender({ open: false });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(fetchModels).toHaveBeenCalledTimes(2);
});

it("does not overlap requests and recovers after a timed-out probe", async () => {
  const fetchModels = vi.fn()
    .mockImplementationOnce((_url: string, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }))
    .mockResolvedValue(response(installed));
  vi.stubGlobal("fetch", fetchModels);
  const { result } = renderHook(() => useAIModels(true));
  await act(async () => { await result.current.refreshModels(); });
  expect(fetchModels).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(result.current.modelIssue).toBe("unavailable");
  expect(result.current.refreshingModels).toBe(false);
  await act(async () => { await result.current.refreshModels(); });
  expect(result.current.models).toEqual(installed.models);
});

it("keeps the model picked in this session across a focus refresh when storage is blocked", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(installed)));
  const { result } = renderHook(() => useAIModels(true));
  await settle();
  expect(result.current.selectedModel).toBe("llama3.1:latest");
  act(() => result.current.selectModel("qwen3:4b"));
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  await settle();
  expect(result.current.selectedModel).toBe("qwen3:4b");
});

it("brings the pick back after a refresh that failed once", async () => {
  const fetchModels = vi.fn()
    .mockResolvedValueOnce(response(installed))
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue(response(installed));
  vi.stubGlobal("fetch", fetchModels);
  localStorage.clear();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  const { result } = renderHook(() => useAIModels(true));
  await settle();
  act(() => result.current.selectModel("qwen3:4b"));
  await act(async () => { await result.current.refreshModels(); });
  expect(result.current.modelState).toBe("fallback");
  await act(async () => { await result.current.refreshModels(); });
  expect(result.current.selectedModel).toBe("qwen3:4b");
});
