/**
 * The catalog classes edited on the page, for the 3D pane's live meshes: read once edits
 * settle (never mid-stroke), limited to catalog ids, kept per case, and refreshable by
 * hand for live-room patches, which fire no local edit event.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
	edited: new Set<number>(),
	listeners: new Set<() => void>(),
}));

vi.mock("../CornerstoneNifti2", () => ({
	getEditedSegments: () => store.edited,
	subscribeToSegmentationEdits: (cb: () => void) => {
		store.listeners.add(cb);
		return () => store.listeners.delete(cb);
	},
}));

import { EDITED_CATALOG_SETTLE_MS, useEditedCatalogIds } from "./useEditedCatalogIds";

const edit = (id: number) => {
	store.edited.add(id);
	act(() => store.listeners.forEach((cb) => cb()));
};
const settle = () => act(() => { vi.advanceTimersByTime(EDITED_CATALOG_SETTLE_MS); });

describe("useEditedCatalogIds", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		store.edited.clear();
		store.listeners.clear();
	});
	afterEach(() => vi.useRealTimers());

	it("waits for edits to settle before reporting them, so a stroke never re-renders the page", () => {
		const { result } = renderHook(() => useEditedCatalogIds("7", 30));
		edit(26);
		act(() => { vi.advanceTimersByTime(EDITED_CATALOG_SETTLE_MS - 50); });
		edit(26); // the next step of the same drag restarts the wait
		act(() => { vi.advanceTimersByTime(EDITED_CATALOG_SETTLE_MS - 50); });
		expect(result.current.ids).toEqual([]);
		settle();
		expect(result.current.ids).toEqual([26]);
	});

	it("keeps only catalog ids, in order, and the same array while nothing changes", () => {
		const { result } = renderHook(() => useEditedCatalogIds("7", 30));
		edit(31); // a custom class, drawn live already
		edit(0); // the eraser
		edit(25);
		edit(8);
		settle();
		expect(result.current.ids).toEqual([8, 25]);
		const first = result.current.ids;
		edit(25);
		settle();
		expect(result.current.ids).toBe(first);
	});

	it("picks up edits that arrive without an edit event when refreshed", () => {
		const { result } = renderHook(() => useEditedCatalogIds("7", 30));
		store.edited.add(11); // a live-room mask patch marks the class but fires no local event
		act(() => result.current.refresh());
		settle();
		expect(result.current.ids).toEqual([11]);
	});

	it("reports nothing for another case until that case is edited", () => {
		const { result, rerender } = renderHook(({ id }) => useEditedCatalogIds(id, 30), { initialProps: { id: "7" } });
		edit(26);
		settle();
		expect(result.current.ids).toEqual([26]);
		rerender({ id: "23" });
		expect(result.current.ids).toEqual([]);
	});

	it("stops listening when unmounted", () => {
		const { unmount } = renderHook(() => useEditedCatalogIds("7", 30));
		expect(store.listeners.size).toBe(1);
		unmount();
		expect(store.listeners.size).toBe(0);
	});
});
