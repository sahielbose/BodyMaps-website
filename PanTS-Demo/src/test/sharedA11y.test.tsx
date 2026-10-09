/**
 * Shared accessibility plumbing: per-route document titles, the dialog focus
 * hook every overlay uses, and backdrop dismissal that ignores drags which
 * merely end on the backdrop.
 */
import { describe, expect, it, vi } from "vitest";
import { StrictMode, useRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { titleForPath } from "../helpers/routeTitles";
import { SITE_TITLE } from "../helpers/copy";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDialogFocus";

describe("titleForPath", () => {
	it("names every kind of page differently", () => {
		const titles = [
			"/", "/dashboard", "/case/12", "/upload", "/team", "/terms", "/privacy", "/compare",
			"/compare-viewer", "/account", "/account/plan", "/reset-password", "/verify-email",
			"/share/abc", "/live/r1", "/learn/quiz/p", "/nope",
		].map(titleForPath);
		expect(new Set(titles).size).toBe(titles.length);
		expect(titleForPath("/")).toBe(SITE_TITLE);
		expect(titleForPath("/case/12")).toBe("Case 12 | BodyMaps");
		expect(titleForPath("/dashboard/")).toBe("Dataset | BodyMaps");
		expect(titleForPath("/somewhere/else")).toBe("Page not found | BodyMaps");
		for (const t of titles) expect(t).not.toMatch(/—/);
	});

	it("titles a path as not found when it lacks the parts its route needs", () => {
		for (const path of ["/case", "/learn", "/learn/quiz", "/learn/other/p", "/live", "/share", "/session",
			"/reconstruction", "/case/12/extra", "/upload/x", "/account/plan/x"]) {
			expect(titleForPath(path)).toBe("Page not found | BodyMaps");
		}
		expect(titleForPath("/live/challenge/c1")).toBe("Challenge | BodyMaps");
		expect(titleForPath("/live/challenge")).toBe("Live room | BodyMaps");
		expect(titleForPath("/learn/quiz/p")).toBe("Quiz practice | BodyMaps");
	});
});

function Dialog({ onClose }: { onClose: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useDialogFocus(true, ref, { onEscape: onClose });
	return (
		<div ref={ref} role="dialog" aria-modal="true">
			<button>First</button>
			<button>Last</button>
		</div>
	);
}

function Harness() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button onClick={() => setOpen(true)}>Open</button>
			<button>Behind</button>
			{open && <Dialog onClose={() => setOpen(false)} />}
		</>
	);
}

describe("useDialogFocus", () => {
	it("moves focus in, keeps Tab inside, locks scroll, and gives focus back", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const opener = screen.getByText("Open");
		await user.click(opener);

		expect(document.activeElement).toBe(screen.getByText("First"));
		expect(document.body.style.overflow).toBe("hidden");
		await user.tab();
		expect(document.activeElement).toBe(screen.getByText("Last"));
		await user.tab();
		expect(document.activeElement).toBe(screen.getByText("First"));
		await user.tab({ shift: true });
		expect(document.activeElement).toBe(screen.getByText("Last"));

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
		expect(document.body.style.overflow).toBe("");
	});

	it("pads the body by the scrollbar it hides, so the page doesn't jump sideways", async () => {
		// A classic 15px window scrollbar: the viewport is 15px wider than the page.
		const clientWidth = vi
			.spyOn(document.documentElement, "clientWidth", "get")
			.mockReturnValue(window.innerWidth - 15);
		const user = userEvent.setup();
		render(<Harness />);
		await user.click(screen.getByText("Open"));
		expect(document.body.style.overflow).toBe("hidden");
		expect(document.body.style.paddingRight).toBe("15px");

		await user.keyboard("{Escape}");
		expect(document.body.style.overflow).toBe("");
		expect(document.body.style.paddingRight).toBe("");

		// Overlay scrollbars take no width, so nothing is added.
		clientWidth.mockReturnValue(window.innerWidth);
		await user.click(screen.getByText("Open"));
		expect(document.body.style.paddingRight).toBe("");
		await user.keyboard("{Escape}");
		clientWidth.mockRestore();
	});
});

// Like the report over the case viewer: opening it hides the toolbar that
// holds its own opener, so the browser has moved focus to <body> by the time
// the dialog's effect runs.
function HidingHarness() {
	const [open, setOpen] = useState(false);
	return (
		<>
			{!open && <p>Toolbar</p>}
			{/* disabled too: jsdom would still focus a merely hidden button,
			    where a browser leaves a display: none element unfocused. */}
			<button
				hidden={open}
				disabled={open}
				onClick={(e) => {
					(e.currentTarget as HTMLButtonElement).blur();
					setOpen(true);
				}}
			>
				Open report
			</button>
			{open && <Dialog onClose={() => setOpen(false)} />}
		</>
	);
}

describe("useDialogFocus with an opener the dialog hides", () => {
	it("still gives focus back to the opener once it shows again", async () => {
		const user = userEvent.setup();
		// StrictMode, as in the app: the doubled effect run must not lose the opener.
		render(
			<StrictMode>
				<HidingHarness />
			</StrictMode>,
		);
		const opener = screen.getByText("Open report");
		await user.click(opener);
		expect(document.activeElement).toBe(screen.getByText("First"));

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
	});
});

// A step card with a hint opened over it, like Grow from seeds' first step
// under the ribbon's controls explainer. The hint points at controls outside
// itself, so it doesn't trap Tab.
function Card({ label, onClose, trapFocus = true }: { label: string; onClose: () => void; trapFocus?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	useDialogFocus(true, ref, { onEscape: onClose, lockScroll: false, trapFocus });
	return (
		<div ref={ref} role="dialog" aria-label={label}>
			<button>{label} button</button>
		</div>
	);
}

function StackHarness() {
	const [step, setStep] = useState(true);
	const [hint, setHint] = useState(false);
	return (
		<>
			<button onClick={() => setHint(true)}>Show hint</button>
			<button>Class list</button>
			{step && <Card label="Step" onClose={() => setStep(false)} />}
			{hint && <Card label="Hint" onClose={() => setHint(false)} trapFocus={false} />}
		</>
	);
}

describe("useDialogFocus with dialogs stacked", () => {
	it("gives Escape to the newest dialog only", async () => {
		const user = userEvent.setup();
		render(<StackHarness />);
		await user.click(screen.getByText("Show hint"));
		expect(document.activeElement).toBe(screen.getByText("Hint button"));

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Hint" })).toBeNull();
		expect(screen.getByRole("dialog", { name: "Step" })).toBeInTheDocument();

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog", { name: "Step" })).toBeNull();
	});

	it("keeps Tab in the card that traps it, not the hint above", async () => {
		const user = userEvent.setup();
		render(<StackHarness />);
		await user.click(screen.getByText("Show hint"));
		await user.tab();
		expect(document.activeElement).toBe(screen.getByText("Step button"));
	});
});

// A hint that asks for a click elsewhere closes once that click happens.
function PickHint() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useDialogFocus(open, ref, { onEscape: () => setOpen(false), lockScroll: false, trapFocus: false });
	return (
		<>
			<button onClick={() => setOpen(true)}>Tool</button>
			<button onClick={() => setOpen(false)}>Spleen</button>
			{open && (
				<div ref={ref} role="dialog" aria-label="Pick a class first">
					<button>Got it</button>
				</div>
			)}
		</>
	);
}

describe("useDialogFocus for a hint that doesn't trap focus", () => {
	it("lets Tab leave, and leaves focus where the person went when it closes", async () => {
		const user = userEvent.setup();
		render(<PickHint />);
		await user.click(screen.getByText("Tool"));
		expect(document.activeElement).toBe(screen.getByText("Got it"));
		await user.tab();
		expect(document.activeElement).not.toBe(screen.getByText("Got it"));

		await user.click(screen.getByText("Spleen"));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(screen.getByText("Spleen"));
	});

	it("hands focus back to the opener when dismissed with Escape", async () => {
		const user = userEvent.setup();
		render(<PickHint />);
		await user.click(screen.getByText("Tool"));
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(screen.getByText("Tool"));
	});
});

function Backdrop({ onDismiss }: { onDismiss: () => void }) {
	const handlers = useBackdropDismiss(onDismiss);
	return (
		<div data-testid="backdrop" {...handlers}>
			<input aria-label="Email" />
		</div>
	);
}

describe("useBackdropDismiss", () => {
	it("closes on a click on the backdrop but not on a drag that ends there", () => {
		const onDismiss = vi.fn();
		render(<Backdrop onDismiss={onDismiss} />);
		const backdrop = screen.getByTestId("backdrop");
		const input = screen.getByLabelText("Email");

		// Text selection: press in the field, release over the backdrop.
		fireEvent.mouseDown(input);
		fireEvent.click(backdrop);
		expect(onDismiss).not.toHaveBeenCalled();

		fireEvent.mouseDown(backdrop);
		fireEvent.click(backdrop);
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
