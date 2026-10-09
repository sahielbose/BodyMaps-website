/**
 * The AI assistant panel keeps working when the browser blocks site data
 * (the remembered model pick is read and written through guarded storage),
 * and it hands focus back to whatever opened it, or to the model button when
 * the model menu closes, instead of dropping it on the page.
 */
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ViewerActions } from "../components/AIAssistant/types";

vi.mock("../contexts/authContext", () => ({ useAuth: () => ({ promptAuth: vi.fn() }) }));

import AISidebar from "../components/AIAssistant/AISidebar";

const MODELS = { available: true, models: [{ name: "llama3" }, { name: "mistral" }], default_model: "llama3" };

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(MODELS), { status: 200 })));
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

function renderSidebar(props: { open?: boolean; onClose?: () => void } = {}) {
	return render(
		<AISidebar
			open={props.open ?? true}
			onClose={props.onClose ?? vi.fn()}
			caseId="1"
			availableOrgans={[]}
			viewerState={{ view: "mpr", opacity: 50, windowWidth: 400, windowCenter: 40, zoomLevel: 1 }}
			actions={{} as ViewerActions}
		/>,
	);
}

const modelButton = (container: HTMLElement) => container.querySelector<HTMLButtonElement>(".ai-model-picker__button")!;

describe("AI assistant with site data blocked", () => {
	it("still loads the models and lets one be picked", async () => {
		const blocked = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked);
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked);
		vi.spyOn(Storage.prototype, "removeItem").mockImplementation(blocked);

		const { container } = renderSidebar();
		await waitFor(() => expect(modelButton(container)).toHaveTextContent("llama3"));

		fireEvent.click(modelButton(container));
		fireEvent.click(screen.getByRole("button", { name: /^mistral/ }));
		expect(modelButton(container)).toHaveTextContent("mistral");
	});
});

function WithToggle() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen((v) => !v)}>AI</button>
			<button type="button">Elsewhere</button>
			<AISidebar
				open={open}
				onClose={() => setOpen(false)}
				caseId="1"
				availableOrgans={[]}
				viewerState={{ view: "mpr", opacity: 50, windowWidth: 400, windowCenter: 40, zoomLevel: 1 }}
				actions={{} as ViewerActions}
			/>
		</>
	);
}

describe("AI assistant focus", () => {
	const openFromToggle = () => {
		const toggle = screen.getByRole("button", { name: "AI" });
		toggle.focus();
		fireEvent.click(toggle);
		return toggle;
	};

	it("goes back to the AI button when Escape closes the panel", async () => {
		const { container } = render(<WithToggle />);
		const toggle = openFromToggle();
		await waitFor(() => expect(modelButton(container)).toHaveTextContent("llama3"));
		container.querySelector("textarea")!.focus();

		fireEvent.keyDown(window, { key: "Escape" });
		expect(toggle).toHaveFocus();
	});

	it("goes back to the AI button when the Close button closes the panel", async () => {
		const { container } = render(<WithToggle />);
		const toggle = openFromToggle();
		await waitFor(() => expect(modelButton(container)).toHaveTextContent("llama3"));
		const close = screen.getByRole("button", { name: "Close AI assistant" });
		close.focus();

		fireEvent.click(close);
		expect(toggle).toHaveFocus();
	});

	it("stays where the person moved it when the panel closes", async () => {
		const { container } = render(<WithToggle />);
		openFromToggle();
		await waitFor(() => expect(modelButton(container)).toHaveTextContent("llama3"));
		const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
		elsewhere.focus();

		fireEvent.keyDown(window, { key: "Escape" });
		expect(elsewhere).toHaveFocus();
	});

	it("leaves focus to another dialog that closes in the same moment, such as HD loading", async () => {
		function Harness({ open, overlay }: { open: boolean; overlay: boolean }) {
			return (
				<>
					<button type="button">AI</button>
					{overlay && <div role="dialog" aria-label="Loading HD resolution"><button type="button">Cancel</button></div>}
					<AISidebar
						open={open}
						onClose={vi.fn()}
						caseId="1"
						availableOrgans={[]}
						viewerState={{ view: "mpr", opacity: 50, windowWidth: 400, windowCenter: 40, zoomLevel: 1 }}
						actions={{} as ViewerActions}
					/>
				</>
			);
		}
		const view = render(<Harness open={false} overlay={false} />);
		const toggle = screen.getByRole("button", { name: "AI" });
		toggle.focus();
		view.rerender(<Harness open overlay={false} />);
		await waitFor(() => expect(modelButton(view.container)).toHaveTextContent("llama3"));
		view.container.querySelector("textarea")!.focus();

		// Annotate opens the HD dialog, which takes focus; then HD finishes,
		// closing the dialog and the panel in one commit.
		view.rerender(<Harness open overlay />);
		screen.getByRole("button", { name: "Cancel" }).focus();
		view.rerender(<Harness open={false} overlay={false} />);

		expect(toggle).not.toHaveFocus();
	});

	it("goes back to the model button when the model menu closes from an item", async () => {
		const onClose = vi.fn();
		const { container } = renderSidebar({ onClose });
		await waitFor(() => expect(modelButton(container)).toHaveTextContent("llama3"));

		fireEvent.click(modelButton(container));
		screen.getByRole("button", { name: /^mistral/ }).focus();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(modelButton(container)).toHaveFocus();
		expect(onClose).not.toHaveBeenCalled(); // that Escape was the menu's

		fireEvent.click(modelButton(container));
		const mistral = screen.getByRole("button", { name: /^mistral/ });
		mistral.focus();
		fireEvent.click(mistral);
		expect(modelButton(container)).toHaveFocus();
	});
});
