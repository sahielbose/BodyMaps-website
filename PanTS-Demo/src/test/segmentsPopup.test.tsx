/**
 * The Segments popup's custom class list: a deleted row fades out rather
 * than vanishing, the colour popover and class editor grow in as well as
 * out, Escape closes one layer at a time, another row's pencil swaps in
 * that class's editor, a custom class can be targeted from the keyboard,
 * each row's icon buttons say which class they act on, and the rename field
 * has a name.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SegmentsPopup from "../components/segmentation/SegmentsPopup";
import { escapeWasUsed } from "../helpers/viewer/escapeUsed";

const css = readFileSync(resolve(process.cwd(), "src/components/segmentation/SegmentsPopup.css"), "utf8");
// The declarations of the first rule whose selector is exactly `selector`.
const rule = (selector: string) => {
	const start = css.indexOf(`\n${selector} {`);
	expect(start, selector).toBeGreaterThan(-1);
	return css.slice(start, css.indexOf("}", start));
};

describe("Segments popup motion", () => {
	it("lets a deleted row fade out: the entrance animation doesn't hold its end state", () => {
		// A forwards (or both) fill keeps opacity 1 above .is-deleting's
		// opacity 0, so the row stayed solid and then vanished.
		const row = rule(".segpop__row");
		expect(row).toMatch(/animation:\s*segpop-row-in\b[^;]*\bbackwards;/);
		expect(row).not.toMatch(/animation:[^;]*\b(both|forwards)\b/);
		expect(rule(".segpop__row.is-deleting")).toMatch(/opacity:\s*0;/);
	});

	it("grows the colour popover and the class editor in, not just out", () => {
		// Both mount already .is-open, where a transition has nothing to run
		// from, so the entrance has to be a keyframe animation.
		for (const selector of [".segpop__color-popover.is-open", ".segpop__form-flyout.is-open"]) {
			const name = rule(selector).match(/animation:\s*([\w-]+)/)?.[1];
			expect(name, selector).toBeTruthy();
			const frames = css.slice(css.indexOf(`@keyframes ${name} {`));
			expect(frames, selector).toMatch(/^@keyframes [\w-]+ \{\s*from \{\s*opacity: 0;/);
		}
		// The site-wide reduced-motion rule shortens these like every other animation.
		const index = readFileSync(resolve(process.cwd(), "src/index.css"), "utf8");
		expect(index).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 0\.01ms !important/);
	});
});

function renderPopup(overrides: Partial<React.ComponentProps<typeof SegmentsPopup>> = {}) {
	const props: React.ComponentProps<typeof SegmentsPopup> = {
		open: true,
		segments: [{ id: 30, label: "Lesion A" }, { id: 31, label: "Lesion B" }],
		colors: { 30: "#ff0000", 31: "#00ff00" },
		visibility: {},
		activeSegmentId: null,
		onSelect: vi.fn(),
		onRename: vi.fn(() => true),
		onColorChange: vi.fn(),
		onToggleVisibility: vi.fn(),
		onDelete: vi.fn(),
		onCreate: vi.fn(() => null),
		organCatalog: [{ id: 1, label: "Liver" }],
		activeCatalogOrganId: null,
		onSelectCatalogOrgan: vi.fn(),
		showOnlyTargetMask: false,
		onShowOnlyTargetMaskChange: vi.fn(),
		hasActiveTarget: false,
		...overrides,
	};
	const view = render(<SegmentsPopup {...props} />);
	fireEvent.click(screen.getByRole("button", { name: "Custom" }));
	return { ...view, props };
}

const pressEscape = (target: Element) => {
	const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	fireEvent(target, e);
	return e;
};

const openEditorWithColour = () => {
	renderPopup();
	fireEvent.click(screen.getAllByTitle("Rename / recolor")[0]);
	const flyout = document.querySelector(".segpop__form-flyout")!;
	expect(flyout).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Class color" }));
	const popover = document.querySelector("[data-color-popover-portal]")!;
	expect(popover).toBeInTheDocument();
	return { flyout, popover };
};

describe("Segments popup Escape", () => {
	afterEach(() => vi.useRealTimers());

	it("closes only the colour popover, then the class editor on the next Escape", () => {
		// The popover's 200 ms close runs on the test's clock, so it can't lose
		// a race against a waitFor timeout on a busy machine.
		vi.useFakeTimers();
		const { flyout, popover } = openEditorWithColour();

		const first = pressEscape(screen.getByRole("button", { name: "Class color" }));
		expect(escapeWasUsed(first)).toBe(true);
		expect(popover).toHaveClass("is-closing");
		expect(flyout).not.toHaveClass("is-closing");
		act(() => { vi.advanceTimersByTime(250); });
		expect(document.querySelector("[data-color-popover-portal]")).toBeNull();
		expect(flyout).toBeInTheDocument();
		expect(flyout).not.toHaveClass("is-closing");

		pressEscape(document.body);
		expect(flyout).toHaveClass("is-closing");
	});

	it("keeps the editor open when Escape comes from its name field while the popover is up", () => {
		const { flyout, popover } = openEditorWithColour();
		const name = flyout.querySelector("input")!;
		pressEscape(name);
		expect(popover).toHaveClass("is-closing");
		expect(flyout).not.toHaveClass("is-closing");
	});
});

describe("Segments popup class editor", () => {
	afterEach(() => vi.useRealTimers());

	// The mousedown is what an open editor reads as a click outside it; the
	// click then opens this row's editor.
	const pressPencil = (name: string) => {
		const pencil = screen.getByRole("button", { name: `Rename or recolor ${name}` });
		fireEvent.mouseDown(pencil);
		fireEvent.click(pencil);
		return pencil;
	};
	const flyouts = () => document.querySelectorAll(".segpop__form-flyout");

	it("shows another class's editor when its pencil is pressed while one is open", () => {
		vi.useFakeTimers();
		renderPopup();
		pressPencil("Lesion A");
		const pencilB = pressPencil("Lesion B");
		// Past the first editor's close, which used to take the new one with it.
		act(() => { vi.advanceTimersByTime(500); });
		expect(flyouts()).toHaveLength(1);
		expect(flyouts()[0]).toHaveClass("is-open");
		expect(screen.getByRole("textbox", { name: "Class name" })).toHaveValue("Lesion B");
		expect(pencilB).toHaveClass("is-active");
		// Still anchored to B's pencil, so pressing it isn't a click outside.
		fireEvent.mouseDown(pencilB);
		expect(flyouts()[0]).toHaveClass("is-open");
	});

	it("doesn't carry the colour popover over into the next class's editor", () => {
		vi.useFakeTimers();
		renderPopup();
		pressPencil("Lesion A");
		fireEvent.click(screen.getByRole("button", { name: "Class color" }));
		expect(document.querySelector("[data-color-popover-portal]")).toBeInTheDocument();
		pressPencil("Lesion B");
		expect(document.querySelector("[data-color-popover-portal]")).toBeNull();
	});

	it("keeps the colour popover just opened in the next class's editor open", () => {
		vi.useFakeTimers();
		renderPopup();
		pressPencil("Lesion A");
		fireEvent.click(screen.getByRole("button", { name: "Class color" }));
		// This press also starts the first popover's close, as a click outside it.
		pressPencil("Lesion B");
		act(() => { vi.advanceTimersByTime(50); });
		fireEvent.click(screen.getByRole("button", { name: "Class color" }));
		const popover = document.querySelector("[data-color-popover-portal]");
		expect(popover).toBeInTheDocument();
		// Past the first popover's close, which used to close this one.
		act(() => { vi.advanceTimersByTime(500); });
		expect(popover).toBeInTheDocument();
		expect(popover).toHaveClass("is-open");
	});

	// The panel's own "Add class" button; the open form's submit shares its name.
	const pressAddClass = () => {
		const button = document.querySelector<HTMLElement>(".segpop__new")!;
		fireEvent.mouseDown(button);
		fireEvent.click(button);
	};

	it("reopens the add form when Add class is pressed during its close", () => {
		vi.useFakeTimers();
		renderPopup();
		pressAddClass();
		fireEvent.change(screen.getByPlaceholderText("Class name"), { target: { value: "Cyst" } });
		fireEvent.click(within(flyouts()[0] as HTMLElement).getByRole("button", { name: "Cancel" }));
		expect(flyouts()[0]).toHaveClass("is-closing");
		act(() => { vi.advanceTimersByTime(100); });
		pressAddClass();
		// Past the cancelled form's close, which used to take the new press with it.
		act(() => { vi.advanceTimersByTime(500); });
		expect(flyouts()).toHaveLength(1);
		expect(flyouts()[0]).toHaveClass("is-open");
		expect(screen.getByPlaceholderText("Class name")).toHaveValue("");
	});

	it("reopens a class's editor when its own pencil is pressed during the editor's close", () => {
		vi.useFakeTimers();
		renderPopup();
		pressPencil("Lesion A");
		fireEvent.click(within(flyouts()[0] as HTMLElement).getByRole("button", { name: "Cancel" }));
		expect(flyouts()[0]).toHaveClass("is-closing");
		act(() => { vi.advanceTimersByTime(100); });
		pressPencil("Lesion A");
		// Past the cancelled editor's close, which used to take the new press with it.
		act(() => { vi.advanceTimersByTime(500); });
		expect(flyouts()).toHaveLength(1);
		expect(flyouts()[0]).toHaveClass("is-open");
	});

	it("starts a reopened add form with its colour popover closed", () => {
		vi.useFakeTimers();
		renderPopup();
		pressAddClass();
		fireEvent.click(screen.getByRole("button", { name: "Class color" }));
		expect(document.querySelector("[data-color-popover-portal]")).toBeInTheDocument();
		// A click outside starts the form's close; Add class then reopens it.
		fireEvent.mouseDown(document.body);
		pressAddClass();
		expect(document.querySelector("[data-color-popover-portal]")).toBeNull();
		act(() => { vi.advanceTimersByTime(500); });
		expect(flyouts()[0]).toHaveClass("is-open");
		expect(document.querySelector("[data-color-popover-portal]")).toBeNull();
	});

	it("still animates the class editor and the add form out before unmounting them", () => {
		vi.useFakeTimers();
		renderPopup();
		const opens = [() => pressPencil("Lesion A"), pressAddClass];
		for (const open of opens) {
			open();
			const flyout = flyouts()[0];
			expect(flyout).toHaveClass("is-open");
			fireEvent.click(within(flyout as HTMLElement).getByRole("button", { name: "Cancel" }));
			expect(flyout).toHaveClass("is-closing");
			// Mounted through the 200 ms close animation, then gone.
			act(() => { vi.advanceTimersByTime(150); });
			expect(flyout).toBeInTheDocument();
			act(() => { vi.advanceTimersByTime(100); });
			expect(flyouts()).toHaveLength(0);
		}
	});
});

describe("Segments popup custom class rows", () => {
	it("targets a class with Enter or Space on its name, and says which one is targeted", async () => {
		const user = userEvent.setup();
		const { props, rerender } = renderPopup();
		const lesionB = screen.getByRole("button", { name: "Lesion B" });
		expect(lesionB).toHaveAttribute("aria-pressed", "false");

		lesionB.focus();
		await user.keyboard("{Enter}");
		expect(props.onSelect).toHaveBeenCalledTimes(1);
		expect(props.onSelect).toHaveBeenLastCalledWith(31);

		rerender(<SegmentsPopup {...props} activeSegmentId={31} />);
		expect(screen.getByRole("button", { name: "Lesion B" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Lesion A" })).toHaveAttribute("aria-pressed", "false");
		// Space on the targeted class clears the target, like a second click.
		await user.keyboard(" ");
		expect(props.onSelect).toHaveBeenLastCalledWith(null);
	});

	it("names each row's icon buttons after their class", () => {
		renderPopup({ visibility: { 31: false } });
		for (const name of ["Hide Lesion A", "Rename or recolor Lesion A", "Delete Lesion A",
			"Show Lesion B", "Rename or recolor Lesion B", "Delete Lesion B"]) {
			expect(screen.getByRole("button", { name })).toBeInTheDocument();
		}
		expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
	});

	it("opens the rename field with a name and the class's current name in it", () => {
		renderPopup();
		fireEvent.click(screen.getByRole("button", { name: "Rename or recolor Lesion B" }));
		const field = screen.getByRole("textbox", { name: "Class name" });
		expect(field).toHaveValue("Lesion B");
		expect(field).toHaveFocus();
	});

	it("still selects on a click anywhere in the row, once per click", async () => {
		const user = userEvent.setup();
		const { props } = renderPopup();
		await user.click(screen.getByRole("button", { name: "Lesion A" }));
		expect(props.onSelect).toHaveBeenCalledTimes(1);
		expect(props.onSelect).toHaveBeenLastCalledWith(30);
		await user.click(screen.getByRole("button", { name: "Lesion A" }).closest(".segpop__row")!);
		expect(props.onSelect).toHaveBeenCalledTimes(2);
	});
});
