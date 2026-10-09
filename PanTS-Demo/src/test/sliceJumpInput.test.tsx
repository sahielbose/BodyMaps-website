/**
 * The slice caption under each pane: the wheel over it steps slices the
 * same way the wheel over the image does, and the number field it turns
 * into says what it is for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../helpers/CornerstoneNifti2", () => ({ setPaneSliceIndex: vi.fn(), stepPaneSlice: vi.fn() }));

import { setPaneSliceIndex, stepPaneSlice } from "../helpers/CornerstoneNifti2";
import SliceJumpInput from "../components/SliceJumpInput";

beforeEach(() => {
	vi.mocked(setPaneSliceIndex).mockClear();
	vi.mocked(stepPaneSlice).mockClear();
});

describe("slice caption", () => {
	it("goes to the next slice on wheel down and the previous on wheel up, like the image", () => {
		render(<SliceJumpInput pane="axial" info={{ current: 41, total: 120 }} />);
		const caption = screen.getByRole("button", { name: "Axial slice 42 of 120. Jump to a slice" });

		fireEvent.wheel(caption, { deltaY: 100 });
		expect(stepPaneSlice).toHaveBeenLastCalledWith("axial", 1);

		fireEvent.wheel(caption, { deltaY: -100 });
		expect(stepPaneSlice).toHaveBeenLastCalledWith("axial", -1);
	});

	it("turns into a number field named for what it does, and jumps on Enter", () => {
		render(<SliceJumpInput pane="coronal" info={{ current: 4, total: 80 }} />);
		fireEvent.click(screen.getByRole("button", { name: "Coronal slice 5 of 80. Jump to a slice" }));

		const field = screen.getByRole("spinbutton", { name: "Jump to coronal slice, 1 to 80" });
		expect(field).toHaveFocus();
		fireEvent.change(field, { target: { value: "12" } });
		fireEvent.keyDown(field, { key: "Enter" });
		expect(setPaneSliceIndex).toHaveBeenLastCalledWith("coronal", 11);
	});
});
