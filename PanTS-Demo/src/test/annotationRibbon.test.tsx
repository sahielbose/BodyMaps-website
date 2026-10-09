/**
 * The annotate ribbon's tool buttons report which tool is on, not just by
 * colour: the selected tool is pressed and every other one isn't. A tool
 * clicked before any class is picked explains itself in a hint that takes
 * focus and closes on Escape. A tool's settings flyout is a named dialog that
 * takes focus when it opens, closes on Escape (like an outside click) and
 * hands focus back, and tabbing out of it carries on from its tool.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AnnotationToolbar from "../components/viewer/AnnotationToolbar";
import { escapeWasUsed } from "../helpers/viewer/escapeUsed";
import type { PrimaryEditTool } from "../components/viewer/AnnotationToolbar";

beforeEach(() => {
	// The ribbon asks the model server which prompt tools it can serve.
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ available: false }), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

const renderRibbon = (activeTool: "pointSegment" | "paint" | null, hasActiveTarget = true, modelToolsAvailable?: boolean) =>
	render(
		<AnnotationToolbar
			open
			modelToolsAvailable={modelToolsAvailable}
			hasSegments
			hasActiveTarget={hasActiveTarget}
			popupRef={{ current: document.createElement("div") }}
			activeTool={activeTool}
			onToolChange={vi.fn()}
			diameterMm={5}
			onDiameterChange={vi.fn()}
			scissorsOptions={{ operation: "eraseInside" }}
			onScissorsOptionsChange={vi.fn()}
			scissorsPointCount={0}
			onScissorsCancel={vi.fn()}
			targetKey={1}
			renderFlyout={() => null}
		/>,
	);

describe("annotate ribbon", () => {
	it("marks the selected tool pressed and the rest not", () => {
		renderRibbon("pointSegment");
		expect(screen.getByRole("button", { name: "Segment from click" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Brush" })).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByRole("button", { name: "Refine with model" })).toHaveAttribute("aria-pressed", "false");
	});

	it("has nothing pressed while no tool is on", () => {
		renderRibbon(null);
		const pressed = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "true");
		expect(pressed).toHaveLength(0);
	});

	it("asks for a class first, in a hint that takes focus and closes on Escape", async () => {
		const user = userEvent.setup();
		renderRibbon(null, false);
		const brush = screen.getByRole("button", { name: "Brush" });
		await user.click(brush);

		const hint = screen.getByRole("dialog", { name: "Pick a class first" });
		expect(hint).toHaveAccessibleDescription("Select an existing class or create a custom one to start annotating.");
		expect(screen.getByRole("button", { name: "Got it" })).toHaveFocus();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(brush).toHaveFocus();
	});

	it("leaves the model tools out where there is no dataset case to send", () => {
		renderRibbon(null, true, false);
		for (const name of ["Segment from click", "Segment from box", "Segment from scribble", "Segment from lasso", "Refine with model"]) {
			expect(screen.queryByRole("button", { name })).toBeNull();
		}
		expect(screen.getByRole("button", { name: "Brush" })).toBeInTheDocument();
	});
});

// Holds the active tool like VisualizationPage does, so picking and
// dismissing a tool shows up on the ribbon.
function StatefulRibbon({ onToolChange }: { onToolChange: (tool: PrimaryEditTool) => void }) {
	const [tool, setTool] = useState<PrimaryEditTool>(null);
	return (
		<AnnotationToolbar
			open
			hasSegments
			hasActiveTarget
			popupRef={{ current: document.createElement("div") }}
			activeTool={tool}
			onToolChange={(next) => { onToolChange(next); setTool(next); }}
			diameterMm={5}
			onDiameterChange={vi.fn()}
			scissorsOptions={{ operation: "eraseInside" }}
			onScissorsOptionsChange={vi.fn()}
			scissorsPointCount={0}
			onScissorsCancel={vi.fn()}
			targetKey={1}
			renderFlyout={() => (
				<>
					<button type="button">Grow</button>
					<button type="button">Shrink</button>
				</>
			)}
		/>
	);
}

describe("annotate settings flyout", () => {
	const settingsGone = (name: string) =>
		waitFor(() => expect(screen.queryByRole("dialog", { name })).toBeNull());

	it("opens as a named dialog with focus inside, and Escape closes it back onto its trigger", async () => {
		const user = userEvent.setup();
		const onToolChange = vi.fn();
		renderRibbon("paint");
		const arrow = screen.getByRole("button", { name: "Brush settings" });
		expect(arrow).toHaveAttribute("aria-haspopup", "dialog");
		await user.click(arrow);

		const panel = await screen.findByRole("dialog", { name: "Brush settings" });
		expect(screen.getByRole("slider", { name: "Brush size" })).toHaveFocus();
		expect(panel).toContainElement(document.activeElement as HTMLElement);

		const viewerSawEscape = vi.fn((e: KeyboardEvent) => escapeWasUsed(e));
		window.addEventListener("keydown", viewerSawEscape);
		await user.keyboard("{Escape}");
		window.removeEventListener("keydown", viewerSawEscape);
		// Used up, so the viewer's own Escape doesn't also disarm the brush.
		expect(viewerSawEscape).toHaveReturnedWith(true);
		await settingsGone("Brush settings");
		expect(arrow).toHaveFocus();
		expect(onToolChange).not.toHaveBeenCalled();
	});

	it("leaves the typed-value Escape to the size field and stays open", async () => {
		const user = userEvent.setup();
		renderRibbon("paint");
		await user.click(screen.getByRole("button", { name: "Brush settings" }));
		const panel = await screen.findByRole("dialog", { name: "Brush settings" });
		const box = screen.getByRole("textbox", { name: "Brush size exact value" });
		await user.click(box);
		await user.keyboard("7");
		await user.keyboard("{Escape}");
		// A closing panel stays on screen for its exit animation, so check
		// it isn't on its way out.
		expect(panel).not.toHaveClass("is-closing");
		expect(screen.getByRole("dialog", { name: "Brush settings" })).toBeInTheDocument();
		expect(box).toHaveFocus();
	});

	it("lets Escape in an untouched size field close the flyout", async () => {
		const user = userEvent.setup();
		renderRibbon("paint");
		await user.click(screen.getByRole("button", { name: "Brush settings" }));
		const panel = await screen.findByRole("dialog", { name: "Brush settings" });
		await user.click(screen.getByRole("textbox", { name: "Brush size exact value" }));
		await user.keyboard("{Escape}");
		await waitFor(() => expect(panel.classList.contains("is-closing") || !panel.isConnected).toBe(true));
	});

	it("dismisses a one-shot tool on Escape like an outside click: closed, deselected, focus on its icon", async () => {
		const user = userEvent.setup();
		const onToolChange = vi.fn();
		render(<StatefulRibbon onToolChange={onToolChange} />);
		const margin = screen.getByRole("button", { name: "Margin" });
		await user.click(margin);

		await screen.findByRole("dialog", { name: "Margin settings" });
		expect(screen.getByRole("button", { name: "Grow" })).toHaveFocus();

		await user.keyboard("{Escape}");
		await settingsGone("Margin settings");
		expect(onToolChange).toHaveBeenLastCalledWith(null);
		expect(margin).toHaveAttribute("aria-pressed", "false");
		expect(margin).toHaveFocus();
	});

	it("tabbing past the end carries on after the tool; Shift+Tab from the start goes back to it", async () => {
		const user = userEvent.setup();
		render(<StatefulRibbon onToolChange={vi.fn()} />);
		const margin = screen.getByRole("button", { name: "Margin" });

		await user.click(margin);
		await screen.findByRole("dialog", { name: "Margin settings" });
		await user.tab();
		expect(screen.getByRole("button", { name: "Shrink" })).toHaveFocus();
		await user.tab();
		await settingsGone("Margin settings");
		expect(screen.getByRole("button", { name: "Smoothing" })).toHaveFocus();

		await user.click(margin);
		await screen.findByRole("dialog", { name: "Margin settings" });
		await user.tab({ shift: true });
		await settingsGone("Margin settings");
		expect(margin).toHaveFocus();
	});
});
