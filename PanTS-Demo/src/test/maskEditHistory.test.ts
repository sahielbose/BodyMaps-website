/**
 * The shared undo stacks belong to one case. Their entries are closures over
 * that case's labelmap, so they are emptied when the case is disposed (the
 * SPA keeps this module alive across cases), and the fill stack is capped so
 * a long session doesn't keep every edit's voxel list alive.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { utilities as csCoreUtils } from "@cornerstonejs/core";
import {
	canRedoSmartFill,
	canUndoSmartFill,
	pushEditHistory,
	resetMaskEditHistory,
	undoMaskEdit,
	undoSmartFill,
} from "../helpers/CornerstoneNifti2";

afterEach(() => {
	resetMaskEditHistory();
});

describe("mask edit history", () => {
	it("forgets the previous case's edits on both stacks", () => {
		const staleFill = vi.fn();
		pushEditHistory({ undo: staleFill, redo: vi.fn() });
		pushEditHistory({ undo: staleFill, redo: vi.fn() });
		const staleBrush = { restoreMemo: vi.fn() };
		csCoreUtils.HistoryMemo.DefaultHistoryMemo.push(staleBrush as never);
		expect(canUndoSmartFill()).toBe(true);
		expect(csCoreUtils.HistoryMemo.DefaultHistoryMemo.canUndo).toBe(true);

		resetMaskEditHistory();

		expect(canUndoSmartFill()).toBe(false);
		expect(canRedoSmartFill()).toBe(false);
		expect(csCoreUtils.HistoryMemo.DefaultHistoryMemo.canUndo).toBe(false);
		// Ctrl+Z on the new case reaches neither old closure.
		undoMaskEdit();
		expect(staleFill).not.toHaveBeenCalled();
		expect(staleBrush.restoreMemo).not.toHaveBeenCalled();
	});

	it("keeps only the newest 50 fill edits", () => {
		const undone: number[] = [];
		for (let i = 0; i < 60; i++) pushEditHistory({ undo: () => undone.push(i), redo: vi.fn() });

		while (undoSmartFill()) { /* drain */ }

		expect(undone).toHaveLength(50);
		expect(undone[0]).toBe(59);
		expect(undone[undone.length - 1]).toBe(10);
	});
});
