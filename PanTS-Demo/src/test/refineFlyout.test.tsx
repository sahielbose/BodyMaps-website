/**
 * The Refine flyout's result: "Refined" only when the model moved the
 * outline, otherwise it says the class was already a good fit.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import RefineFlyout from "../components/segmentation/RefineFlyout";

describe("RefineFlyout", () => {
	const result = (added: number, removed: number) => ({
		changed: added + removed, added, removed, sessionActive: false, degenerate: false,
	});

	it("says Refined when the model moved the outline", async () => {
		const refine = vi.fn().mockResolvedValue(result(12, 3));
		const onLog = vi.fn();
		render(<RefineFlyout classLabel="spleen" refine={refine} onLog={onLog} />);
		fireEvent.click(screen.getByRole("button", { name: "Refine spleen" }));
		expect(await screen.findByRole("button", { name: "Refined" })).toBeInTheDocument();
		expect(onLog).toHaveBeenCalledWith("Refined spleen (15 voxels)");
	});

	it("doesn't claim a change when the model kept the outline", async () => {
		const refine = vi.fn().mockResolvedValue(result(0, 0));
		render(<RefineFlyout classLabel="spleen" refine={refine} />);
		fireEvent.click(screen.getByRole("button", { name: "Refine spleen" }));
		expect(await screen.findByRole("button", { name: "Already a good fit" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Refined" })).toBeNull();
	});
});
