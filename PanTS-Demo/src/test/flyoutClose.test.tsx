/**
 * A tool's settings flyout eases out when it closes instead of vanishing:
 * the very commit that closes it keeps the panel on screen, marked closing,
 * and it is only hidden (or unmounted) once the fade has had its time. A
 * close that also takes the content away fades a static copy of what was
 * showing, not an empty box or the next tool's controls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { FlyoutPanel } from "../components/viewer/FlyoutPrimitives";
import AnnotationToolbar, { type PrimaryEditTool } from "../components/viewer/AnnotationToolbar";
import LevelTracingFlyout from "../components/segmentation/LevelTracingFlyout";

const realMatchMedia = window.matchMedia;

function setReducedMotion(on: boolean) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: on && /prefers-reduced-motion:\s*reduce/.test(query),
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	// The ribbon asks the model server which prompt tools it can serve.
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: false }), { status: 200 })));
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	window.matchMedia = realMatchMedia;
});

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
const panel = () => document.querySelector<HTMLElement>(".atb-pop__panel");

type Seen = { present: boolean; closing: boolean; display: string };

// Records the panel as each commit of the harness left it. A layout effect
// runs after that commit's DOM changes and before the browser paints, so a
// panel hidden here is a panel whose close never got a frame to animate.
function Harness({ open, keepMounted, seen, children }: { open: boolean; keepMounted: boolean; seen: Seen[]; children: ReactNode }) {
	const anchorRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		const el = panel();
		seen.push({ present: !!el, closing: !!el?.classList.contains("is-closing"), display: el?.style.display ?? "" });
	});
	return (
		<>
			<button type="button" ref={anchorRef}>Tool</button>
			<FlyoutPanel open={open} anchorRef={anchorRef} panelRef={panelRef} keepMounted={keepMounted} label="Tool settings">
				{children}
			</FlyoutPanel>
		</>
	);
}

describe.each([
	{ keepMounted: true, gone: () => expect(panel()).toHaveStyle({ display: "none" }) },
	{ keepMounted: false, gone: () => expect(panel()).toBeNull() },
])("settings flyout closing (keepMounted: $keepMounted)", ({ keepMounted, gone }) => {
	const openThenClose = () => {
		const seen: Seen[] = [];
		const content = <button type="button">Grow</button>;
		const { rerender } = render(<Harness open={false} keepMounted={keepMounted} seen={seen}>{content}</Harness>);
		rerender(<Harness open keepMounted={keepMounted} seen={seen}>{content}</Harness>);
		expect(screen.getByRole("dialog", { name: "Tool settings" })).not.toHaveClass("is-closing");
		seen.length = 0;
		rerender(<Harness open={false} keepMounted={keepMounted} seen={seen}>{content}</Harness>);
		return seen;
	};

	it("keeps the panel on screen, marked closing, in the commit that closes it", () => {
		const seen = openThenClose();
		expect(seen[0]).toEqual({ present: true, closing: true, display: "" });
		expect(panel()).toHaveTextContent("Grow");
	});

	it("hides it once the fade has played", () => {
		openThenClose();
		advance(159);
		expect(panel()).toHaveClass("is-closing");
		expect(panel()).not.toHaveStyle({ display: "none" });
		advance(1);
		gone();
	});

	it("hides it at once under reduced motion, with no fade to wait for", () => {
		setReducedMotion(true);
		openThenClose();
		advance(0);
		gone();
	});
});

// Holds the active tool like VisualizationPage does.
function StatefulRibbon() {
	const [tool, setTool] = useState<PrimaryEditTool>(null);
	return (
		<AnnotationToolbar
			open
			hasSegments
			hasActiveTarget
			popupRef={{ current: document.createElement("div") }}
			activeTool={tool}
			onToolChange={setTool}
			diameterMm={5}
			onDiameterChange={vi.fn()}
			scissorsOptions={{ operation: "eraseInside" }}
			onScissorsOptionsChange={vi.fn()}
			scissorsPointCount={0}
			onScissorsCancel={vi.fn()}
			targetKey={1}
			renderFlyout={(active, _onApplied, onCloseSettings) => active === "levelTracing" ? (
				<LevelTracingFlyout
					operation="fillInside"
					onOperationChange={vi.fn()}
					toleranceHu={50}
					onToleranceChange={vi.fn()}
					onCloseSettings={onCloseSettings}
				/>
			) : (
				<>
					<button type="button" id="grow-option">Grow</button>
					<button type="button">Shrink</button>
				</>
			)}
		/>
	);
}

describe("settings flyout closing with its tool", () => {
	// fireEvent rather than userEvent, whose waits hang on the fake timers.
	const openMargin = () => {
		render(<StatefulRibbon />);
		fireEvent.click(screen.getByRole("button", { name: "Margin" }));
		expect(screen.getByRole("dialog", { name: "Margin settings" })).toHaveTextContent("GrowShrink");
	};

	it("fades a copy of the deselected tool's settings, inert and hidden from assistive tech", () => {
		openMargin();
		fireEvent.keyDown(screen.getByRole("button", { name: "Grow" }), { key: "Escape" });

		const closing = panel()!;
		expect(closing).toHaveClass("is-closing");
		expect(closing).not.toHaveStyle({ display: "none" });
		expect(closing).toHaveTextContent("GrowShrink");
		// The live buttons are gone (the tool unmounted at once); what's
		// left is a copy nobody can reach or hear, with no repeated ids.
		expect(screen.queryByRole("button", { name: "Grow" })).toBeNull();
		const copy = closing.querySelector(".atb-pop__departing")!;
		expect(copy).toHaveAttribute("aria-hidden", "true");
		expect(copy).toHaveAttribute("inert");
		expect(closing.querySelector("#grow-option")).toBeNull();

		advance(160);
		expect(closing).toHaveStyle({ display: "none" });
		expect(closing).not.toHaveTextContent("Grow");
	});

	it("fades the old tool's settings, not the new one's, when switching to a tool whose settings stay shut", () => {
		openMargin();
		const brush = screen.getByRole("button", { name: "Brush" });
		fireEvent.mouseDown(brush);
		fireEvent.click(brush);

		const closing = panel()!;
		expect(closing).toHaveClass("is-closing");
		expect(closing).toHaveTextContent("GrowShrink");
		expect(closing.querySelector("input")).toBeNull();

		advance(160);
		expect(closing).toHaveStyle({ display: "none" });
	});
});

// Picking a Scissors or Level tracing mode closes their settings after a
// short beat, through the ribbon's one shared close.
describe.each([
	["Scissors", "Erase outside", 320],
	["Level tracing", "Fill outside", 260],
])("%s mode pick's delayed close", (tool, mode, beat) => {
	const openAndPick = () => {
		render(<StatefulRibbon />);
		fireEvent.click(screen.getByRole("button", { name: tool }));
		fireEvent.click(screen.getByRole("button", { name: `${tool} settings` }));
		fireEvent.click(screen.getByRole("radio", { name: mode }));
	};

	it("leaves the next tool's settings open when the tool is swapped out within the beat", () => {
		openAndPick();
		const margin = screen.getByRole("button", { name: "Margin" });
		fireEvent.mouseDown(margin);
		fireEvent.click(margin);
		expect(screen.getByRole("dialog", { name: "Margin settings" })).not.toHaveClass("is-closing");

		advance(beat + 200);
		expect(screen.getByRole("dialog", { name: "Margin settings" })).not.toHaveClass("is-closing");
	});

	it("still closes the tool's own settings after the beat, once for two quick picks", () => {
		openAndPick();
		advance(beat - 100);
		fireEvent.click(screen.getByRole("radio", { name: mode }));
		// The first pick's close is replaced by the second's, not stacked.
		advance(100);
		expect(screen.getByRole("dialog", { name: `${tool} settings` })).not.toHaveClass("is-closing");

		advance(beat);
		expect(panel()).toHaveClass("is-closing");
	});
});
