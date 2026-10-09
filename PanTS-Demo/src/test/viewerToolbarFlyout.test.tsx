/**
 * The viewer toolbar's flyouts (Layout, CT window, Adjust, Measure, View,
 * Cine, Capture, Panels) all run on useToolbarFlyout. They follow the
 * disclosure pattern: the trigger reports aria-expanded, focus moves into the
 * panel on open, Escape closes it and hands focus back to the trigger without
 * reaching the viewer's own Escape, an outside click closes it, tabbing past
 * its end carries on after the trigger, and the panel is pulled back inside
 * a narrow window. The pure helpers the toolbar uses beside it (the Crosshair
 * button's state, the ribbon tooltip's side) are covered here too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { clampFlyoutLeft, useToolbarFlyout } from "../helpers/viewer/useToolbarFlyout";
import { crosshairAfterClick, crosshairModeShown } from "../helpers/viewer/crosshairMode";
import { tooltipSide } from "../helpers/viewer/tooltipSide";

function Toolbar({ onViewerKey }: { onViewerKey?: (e: KeyboardEvent) => void }) {
	const { open, pos, groupRef, triggerProps, panelProps } = useToolbarFlyout();
	useEffect(() => {
		if (!onViewerKey) return;
		window.addEventListener("keydown", onViewerKey);
		return () => window.removeEventListener("keydown", onViewerKey);
	}, [onViewerKey]);
	return (
		<div>
			<div ref={groupRef}>
				<button aria-label="Window" {...triggerProps}>
					Window
				</button>
				{open && pos &&
					createPortal(
						<div {...panelProps("CT window preset")}>
							<button aria-pressed={false}>Soft tissue</button>
							<button aria-pressed={true}>Bone</button>
							<button aria-pressed={false}>Lung</button>
						</div>,
						document.body,
					)}
			</div>
			<button>Adjust</button>
		</div>
	);
}

const originalWidth = window.innerWidth;
afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});

describe("useToolbarFlyout", () => {
	it("reports its state and moves focus to the selected option on open", () => {
		render(<Toolbar />);
		const trigger = screen.getByRole("button", { name: "Window" });
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(trigger).toHaveAttribute("aria-haspopup", "dialog");

		fireEvent.click(trigger);

		const panel = screen.getByRole("dialog", { name: "CT window preset" });
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(trigger.getAttribute("aria-controls")).toBe(panel.id);
		// No menu roles: the panel is a group of toggles, not a menu.
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Bone" }));
	});

	it("closes on Escape, returns focus to the trigger and keeps the Escape from the viewer", () => {
		const viewerKey = vi.fn();
		render(<Toolbar onViewerKey={viewerKey} />);
		const trigger = screen.getByRole("button", { name: "Window" });
		fireEvent.click(trigger);
		const inside = screen.getByRole("button", { name: "Bone" });

		fireEvent.keyDown(inside, { key: "Escape" });

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(document.activeElement).toBe(trigger);
		expect(viewerKey).not.toHaveBeenCalled();
	});

	it("closes on an outside click", () => {
		render(<Toolbar />);
		fireEvent.click(screen.getByRole("button", { name: "Window" }));
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		fireEvent.mouseDown(document.body);

		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("tabbing past the last option closes it and carries on after the trigger", () => {
		render(<Toolbar />);
		fireEvent.click(screen.getByRole("button", { name: "Window" }));
		const last = screen.getByRole("button", { name: "Lung" });
		last.focus();

		fireEvent.keyDown(last, { key: "Tab" });

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Adjust" }));
	});

	it("shift-tabbing before the first option closes it and returns to the trigger", () => {
		render(<Toolbar />);
		const trigger = screen.getByRole("button", { name: "Window" });
		fireEvent.click(trigger);
		const first = screen.getByRole("button", { name: "Soft tissue" });
		first.focus();

		fireEvent.keyDown(first, { key: "Tab", shiftKey: true });

		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("pulls a panel that would run off a phone-width window back on screen", () => {
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
		const rect = (left: number, width: number) =>
			({ left, top: 40, right: left + width, bottom: 76, width, height: 36, x: left, y: 40, toJSON() {} }) as DOMRect;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			return this.getAttribute("role") === "dialog" ? rect(0, 240) : rect(330, 36);
		});
		render(<Toolbar />);

		act(() => {
			fireEvent.click(screen.getByRole("button", { name: "Window" }));
		});

		const panel = screen.getByRole("dialog");
		// 390 - 240 - 8: flush against the right edge with the 8px margin.
		expect(panel.style.left).toBe("142px");
	});
});

describe("clampFlyoutLeft", () => {
	it("leaves a panel that fits where it is", () => {
		expect(clampFlyoutLeft(100, 200, 1440)).toBe(100);
	});
	it("pulls a panel off the right edge back inside", () => {
		expect(clampFlyoutLeft(330, 240, 390)).toBe(142);
	});
	it("never pushes it past the left edge", () => {
		expect(clampFlyoutLeft(4, 200, 1440)).toBe(8);
		expect(clampFlyoutLeft(100, 500, 390)).toBe(8);
	});
});

describe("Crosshair button (crosshairMode)", () => {
	const idle = { crosshairToolActive: true, measureToolArmed: false, editToolArmed: false, promptToolArmed: false };

	it("reads as on only while crosshair navigation owns the mouse", () => {
		expect(crosshairModeShown(idle)).toBe(true);
		expect(crosshairModeShown({ ...idle, measureToolArmed: true })).toBe(false);
		expect(crosshairModeShown({ ...idle, editToolArmed: true })).toBe(false);
		expect(crosshairModeShown({ ...idle, promptToolArmed: true })).toBe(false);
		expect(crosshairModeShown({ ...idle, crosshairToolActive: false })).toBe(false);
	});

	it("turns navigation on, never off, when clicked from another tool", () => {
		// The flag is still true underneath an armed measure or prompt tool,
		// which is what used to make the first click turn it off.
		expect(crosshairAfterClick({ ...idle, measureToolArmed: true })).toBe(true);
		expect(crosshairAfterClick({ ...idle, promptToolArmed: true })).toBe(true);
		expect(crosshairAfterClick({ ...idle, editToolArmed: true })).toBe(true);
		expect(crosshairAfterClick({ ...idle, crosshairToolActive: false })).toBe(true);
	});

	it("toggles navigation off when it is already the active mode", () => {
		expect(crosshairAfterClick(idle)).toBe(false);
	});
});

describe("ribbon tooltip side (tooltipSide)", () => {
	const icon = { top: 110, bottom: 146 };

	it("stays above its icon when it fits", () => {
		expect(tooltipSide(icon, 60, 900)).toBe("above");
	});

	it("flips below when a tall tooltip would run off the top", () => {
		// The model tools' tooltips measured 119px tall under a ribbon at y=110.
		expect(tooltipSide(icon, 119, 900)).toBe("below");
	});

	it("stays above when below has even less room", () => {
		expect(tooltipSide({ top: 110, bottom: 146 }, 200, 200)).toBe("above");
	});
});
