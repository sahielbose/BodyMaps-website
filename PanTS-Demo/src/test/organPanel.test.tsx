/**
 * The viewer's Organs panel (OrganCheckbox). Group headers are real
 * disclosure buttons, organs and sub-group chips are real checkboxes, and a
 * system reads as mixed while only some of its organs are shown, including
 * organs that sit in a sub-group (kidney left inside Kidneys inside the
 * Urinary system).
 */
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import OrganCheckbox, { groupCheckState, systemOrganSlots } from "../components/OrganCheckbox";
import { OrganSystems, segmentation_categories } from "../helpers/constants";

const SLOTS = segmentation_categories.length + 1;
const slotOf = (organ: string) => segmentation_categories.indexOf(organ as never) + 1;

function Panel({ initial = false, onJump }: { initial?: boolean; onJump?: (label: number) => void }) {
	const [checkState, setCheckState] = useState<boolean[]>(() => Array(SLOTS).fill(initial));
	const [open, setOpen] = useState(true);
	return (
		<OrganCheckbox
			checkState={checkState}
			setCheckState={setCheckState}
			labelColorMap={{}}
			sessionId={undefined}
			showOrganDetails={open}
			setShowOrganDetails={setOpen}
			onJumpToOrgan={onJump}
		/>
	);
}

describe("Organs panel", () => {
	it("expands a system from a real disclosure button, and collapsed rows are out of reach", () => {
		render(<Panel />);
		const urinary = screen.getByRole("button", { name: "Urinary system" });
		expect(urinary).toHaveAttribute("aria-expanded", "false");
		// Collapsed: its organs are hidden, so not in the tab order or the tree.
		expect(screen.queryByRole("checkbox", { name: "Bladder" })).toBeNull();

		fireEvent.click(urinary);

		expect(urinary).toHaveAttribute("aria-expanded", "true");
		const list = document.getElementById(urinary.getAttribute("aria-controls")!);
		expect(list).not.toBeNull();
		expect(within(list!).getByRole("checkbox", { name: "Bladder" })).toBeInTheDocument();
	});

	it("shows a system as mixed while only a sub-group organ is on", () => {
		render(<Panel initial={false} />);
		fireEvent.click(screen.getByRole("button", { name: "Urinary system" }));
		fireEvent.click(screen.getByRole("button", { name: "Kidneys organs" }));

		const system = screen.getByRole("checkbox", { name: "Show urinary system" });
		const kidneys = screen.getByRole("checkbox", { name: "Kidneys" });
		expect(system).toHaveAttribute("aria-checked", "false");

		const kidneyLeft = screen.getByRole("checkbox", { name: "Kidney left" });
		expect(kidneyLeft.tagName).toBe("BUTTON");
		fireEvent.click(kidneyLeft);

		expect(kidneyLeft).toHaveAttribute("aria-checked", "true");
		expect(kidneys).toHaveAttribute("aria-checked", "mixed");
		expect(system).toHaveAttribute("aria-checked", "mixed");
	});

	it("turns every nested organ on from a mixed system checkbox, then off again", () => {
		render(<Panel initial={false} />);
		fireEvent.click(screen.getByRole("button", { name: "Urinary system" }));
		fireEvent.click(screen.getByRole("button", { name: "Kidneys organs" }));
		fireEvent.click(screen.getByRole("checkbox", { name: "Kidney left" }));
		const system = screen.getByRole("checkbox", { name: "Show urinary system" });

		fireEvent.click(system);

		expect(system).toHaveAttribute("aria-checked", "true");
		for (const name of ["Kidney left", "Kidney right", "Kidney lesion", "Bladder"]) {
			expect(screen.getByRole("checkbox", { name })).toHaveAttribute("aria-checked", "true");
		}

		fireEvent.click(system);

		expect(system).toHaveAttribute("aria-checked", "false");
		expect(screen.getByRole("checkbox", { name: "Kidney right" })).toHaveAttribute("aria-checked", "false");
	});

	it("keeps each organ's jump button reachable next to its checkbox", () => {
		const onJump = vi.fn();
		render(<Panel initial={true} onJump={onJump} />);
		fireEvent.click(screen.getByRole("button", { name: "Lymphatic system" }));

		const jump = screen.getByRole("button", { name: "Jump to spleen" });
		fireEvent.click(jump);

		expect(onJump).toHaveBeenCalledWith(slotOf("spleen"));
		// Row and jump button share the row wrapper that reveals the button on
		// hover or keyboard focus (see .vp-organs__row in VisualizationPage.css).
		const row = screen.getByRole("checkbox", { name: "Spleen" }).closest(".vp-organs__row");
		expect(row).toContainElement(jump);
	});

	it("labels systems and organs in sentence case, lower case mid-sentence", () => {
		render(<Panel />);
		fireEvent.click(screen.getByRole("button", { name: "Digestive system" }));
		expect(screen.getByRole("checkbox", { name: "Show digestive system" })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Common bile duct" })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "CBD stent" })).toBeInTheDocument();
		expect(screen.queryByText("Digestive System")).toBeNull();
	});

	it("closes from a labelled back button", () => {
		render(<Panel />);
		const region = screen.getByRole("region", { name: "Organs" });
		fireEvent.click(screen.getByRole("button", { name: "Close organs panel" }));
		expect(region).not.toHaveClass("vp-organs--open");
	});
});

describe("groupCheckState / systemOrganSlots", () => {
	it("counts sub-group organs as part of their system", () => {
		const slots = systemOrganSlots(OrganSystems, "Urinary System");
		expect(slots).toEqual(expect.arrayContaining([
			slotOf("kidney_left"), slotOf("kidney_right"), slotOf("kidney_lesion"), slotOf("bladder"),
		]));
	});

	it("is checked, unchecked or mixed", () => {
		const state = Array(SLOTS).fill(false);
		const slots = [slotOf("kidney_left"), slotOf("bladder")];
		expect(groupCheckState(slots, state)).toBe(false);
		state[slotOf("kidney_left")] = true;
		expect(groupCheckState(slots, state)).toBe("mixed");
		state[slotOf("bladder")] = true;
		expect(groupCheckState(slots, state)).toBe(true);
	});
});
