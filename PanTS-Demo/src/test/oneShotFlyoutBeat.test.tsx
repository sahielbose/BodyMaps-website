/**
 * The one-shot annotation flyouts (Margin, Smoothing, Hollow, Islands and
 * anything using ApplyButton) hold a success checkmark for a beat, then call
 * onApplied to close and deselect. Picking another tool during that beat
 * unmounts the flyout; the late onApplied must not then deselect the new
 * tool or close its flyout, and the busy state still has to clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

vi.mock("../helpers/CornerstoneNifti2", () => ({
	applyHollow: vi.fn(() => ({ changedVoxels: 12 })),
}));

import MarginPanel from "../components/segmentation/MarginPanel";
import SmoothingFlyout from "../components/segmentation/SmoothingFlyout";
import HollowFlyout from "../components/segmentation/HollowFlyout";
import IslandsPanel from "../components/segmentation/IslandsPanel";
import ApplyButton from "../components/ApplyButton";

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => {
	vi.useRealTimers();
});

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

type Case = {
	name: string;
	button: RegExp;
	ui: (onApplied: () => void, onBusyChange: (busy: boolean) => void) => ReactElement;
};

const cases: Case[] = [
	{
		name: "Margin",
		button: /^Grow by/,
		ui: (onApplied, onBusyChange) => (
			<MarginPanel onApply={vi.fn()} onApplied={onApplied} onBusyChange={onBusyChange} />
		),
	},
	{
		name: "Smoothing",
		button: /^Smooth by/,
		ui: (onApplied, onBusyChange) => <SmoothingFlyout onApply={vi.fn()} onApplied={onApplied} onBusyChange={onBusyChange} />,
	},
	{
		name: "Hollow",
		button: /^Hollow from the inside/,
		ui: (onApplied, onBusyChange) => (
			<HollowFlyout segmentIndex={1} maskFilter={{} as never} onApplied={onApplied} onBusyChange={onBusyChange} />
		),
	},
	{
		name: "Islands",
		button: /^Keep largest/,
		ui: (onApplied, onBusyChange) => (
			<IslandsPanel
				onApply={vi.fn()}
				pickingSelectedIsland={false}
				onPickSelectedIsland={vi.fn()}
				onResetPick={vi.fn()}
				hasSelectedIsland={false}
				pickedInvalid={false}
				targetKey={1}
				onApplied={onApplied}
				onBusyChange={onBusyChange}
			/>
		),
	},
];

describe.each(cases)("$name flyout success beat", ({ button, ui }) => {
	it("closes and deselects once the checkmark has had its beat", () => {
		const onApplied = vi.fn();
		const onBusyChange = vi.fn();
		render(ui(onApplied, onBusyChange));
		fireEvent.click(screen.getByRole("button", { name: button }));
		expect(onBusyChange).toHaveBeenLastCalledWith(true);
		advance(2000);
		expect(onApplied).toHaveBeenCalledTimes(1);
		expect(onBusyChange).toHaveBeenLastCalledWith(false);
	});

	it("leaves the next tool alone when it unmounts mid-beat, but still clears busy", () => {
		const onApplied = vi.fn();
		const onBusyChange = vi.fn();
		const { unmount } = render(ui(onApplied, onBusyChange));
		fireEvent.click(screen.getByRole("button", { name: button }));
		// Another tool is picked while the spinner or checkmark is showing.
		advance(800);
		unmount();
		advance(2000);
		expect(onApplied).not.toHaveBeenCalled();
		expect(onBusyChange).toHaveBeenLastCalledWith(false);
	});
});

describe("ApplyButton success beat", () => {
	it("calls onDone after the checkmark beat", () => {
		const onDone = vi.fn();
		render(<ApplyButton onApply={vi.fn()} onDone={onDone} label="Apply" />);
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		advance(1000);
		expect(onDone).toHaveBeenCalledTimes(1);
	});

	it("skips onDone when it unmounts during the beat", () => {
		const onApply = vi.fn();
		const onDone = vi.fn();
		const { unmount } = render(<ApplyButton onApply={onApply} onDone={onDone} label="Apply" />);
		fireEvent.click(screen.getByRole("button", { name: "Apply" }));
		advance(100);
		expect(onApply).toHaveBeenCalledTimes(1);
		unmount();
		advance(1000);
		expect(onDone).not.toHaveBeenCalled();
	});
});
