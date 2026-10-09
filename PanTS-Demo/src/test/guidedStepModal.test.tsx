/**
 * GuidedStepModal (the blocking step card used by guided edits, the delete
 * confirmation and the model prompt result) is a real dialog once it has a
 * button to press: labelled, focus on its primary action, and Escape does
 * what the caller says (dismiss or cancel), never a committing primary.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GuidedStepModal } from "../components/segmentation/SliceAnchorPickerUI";

describe("GuidedStepModal", () => {
	it("is a labelled dialog with focus on its primary action", () => {
		render(<GuidedStepModal title="Applied" instruction="The tool stays armed." onPrimary={vi.fn()} />);
		const dialog = screen.getByRole("dialog", { name: "Applied" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog).toHaveAccessibleDescription("The tool stays armed.");
		expect(screen.getByRole("button", { name: "Got it" })).toHaveFocus();
	});

	it("runs the caller's Escape action, and nothing else", () => {
		const onPrimary = vi.fn();
		const onEscape = vi.fn();
		render(
			<GuidedStepModal title="Delete this class?" instruction="Gone for good." primaryLabel="Delete"
				onPrimary={onPrimary} secondaryLabel="Cancel" onSecondary={vi.fn()} onEscape={onEscape} />,
		);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onEscape).toHaveBeenCalledTimes(1);
		expect(onPrimary).not.toHaveBeenCalled();
	});

	it("leaves Escape alone when the primary commits an edit", () => {
		const onPrimary = vi.fn();
		render(<GuidedStepModal title="Ready to fill" instruction="Fill the region." primaryLabel="Fill region" onPrimary={onPrimary} />);
		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onPrimary).not.toHaveBeenCalled();
	});

	it("is a status notice, not a dialog, while busy", () => {
		render(<GuidedStepModal title="Applying" instruction="Segmenting from your prompt." primaryLabel="Working" onPrimary={vi.fn()} busy />);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByRole("status", { name: "Applying" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Working" })).not.toHaveFocus();
	});

	it("keeps Cancel and Escape live on a busy card that can be stopped", () => {
		const onCancel = vi.fn();
		render(
			<GuidedStepModal title="Applying" instruction="Segmenting from your prompt." primaryLabel="Working"
				onPrimary={vi.fn()} secondaryLabel="Cancel" onSecondary={onCancel} onEscape={onCancel} busy />,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByRole("button", { name: "Working" })).toBeDisabled();
		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect(cancel).toHaveFocus();

		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onCancel).toHaveBeenCalledTimes(1);
		fireEvent.click(cancel);
		expect(onCancel).toHaveBeenCalledTimes(2);
	});
});
