/**
 * The sign-in popup as a keyboard or screen-reader user meets it: focus goes
 * in and stays in, Escape gives it back, the page behind stops scrolling, a
 * text selection released over the backdrop does not throw the form away,
 * errors are announced, and the copy follows the site's rules.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import AuthModal from "../components/AuthModal";
import { AuthProvider, useAuth } from "../contexts/authContext";

const json = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	localStorage.clear();
	document.body.style.overflow = "";
	global.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/auth/me")) return json({ user: null });
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const Opener: React.FC = () => {
	const { promptAuth } = useAuth();
	return (
		<>
			<button type="button" onClick={() => promptAuth()}>Open sign in</button>
			<a href="#page">A link on the page</a>
		</>
	);
};

const renderModal = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<Opener />
				<AuthModal />
			</MemoryRouter>
		</AuthProvider>,
	);

const open = async (user: ReturnType<typeof userEvent.setup>) => {
	const opener = await screen.findByRole("button", { name: "Open sign in" });
	await user.click(opener);
	return { opener, dialog: await screen.findByRole("dialog", { name: "Sign in" }) };
};

describe("sign-in popup focus", () => {
	it("moves focus in, keeps Tab inside, locks the page, and returns focus on Escape", async () => {
		const user = userEvent.setup();
		renderModal();
		const { opener, dialog } = await open(user);

		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.body.style.overflow).toBe("hidden");
		for (let i = 0; i < 10; i++) {
			await user.tab();
			expect(dialog.contains(document.activeElement)).toBe(true);
		}
		await user.tab({ shift: true });
		expect(dialog.contains(document.activeElement)).toBe(true);

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(opener);
		expect(document.body.style.overflow).toBe("");
	});

	it("keeps focus in the card when a screen swap removes the focused button", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await open(user);
		await user.click(within(dialog).getByRole("button", { name: "Continue with email" }));
		expect(document.activeElement).toBe(within(dialog).getByLabelText("Email"));

		await user.click(within(dialog).getByRole("button", { name: "Forgot password?" }));
		const resetDialog = await screen.findByRole("dialog", { name: "Reset your password" });
		expect(document.activeElement).toBe(within(resetDialog).getByLabelText("Email"));

		// Sign in from the reset screen goes back to the provider buttons the reset hint points at.
		await user.click(within(resetDialog).getByRole("button", { name: "Sign in" }));
		expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Continue with email" }));
	});
});

describe("sign-in popup backdrop", () => {
	it("a drag that starts in a field and ends on the backdrop keeps the popup and the text", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await open(user);
		await user.click(within(dialog).getByRole("button", { name: "Continue with email" }));
		const email = within(dialog).getByLabelText("Email");
		await user.type(email, "ada@example.com");

		const backdrop = dialog.parentElement as HTMLElement;
		fireEvent.mouseDown(email);
		fireEvent.click(backdrop);
		expect(screen.getByRole("dialog", { name: "Sign in" })).toBeInTheDocument();
		expect(within(dialog).getByLabelText("Email")).toHaveValue("ada@example.com");

		fireEvent.mouseDown(backdrop);
		fireEvent.click(backdrop);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});

describe("sign-in popup messages and copy", () => {
	it("announces a validation error and ties it to the fields", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await open(user);
		await user.click(within(dialog).getByRole("button", { name: "Continue with email" }));
		await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

		const alert = within(dialog).getByRole("alert");
		expect(alert).toHaveTextContent("Enter an email and password.");
		expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-describedby", alert.id);
		expect(within(dialog).getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
	});

	it("names the action while it runs, and says so plainly when the server can't be reached", async () => {
		let failLogin: (err: Error) => void = () => {};
		global.fetch = vi.fn((url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/login")) {
				return new Promise((_, reject) => {
					failLogin = reject;
				});
			}
			if (u.includes("/api/auth/me")) return Promise.resolve(json({ user: null }));
			return Promise.resolve(json({ google: true, github: true }));
		}) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await open(user);
		await user.click(within(dialog).getByRole("button", { name: "Continue with email" }));
		await user.type(within(dialog).getByLabelText("Email"), "ada@example.com");
		await user.type(within(dialog).getByLabelText("Password"), "hunter22");
		await user.click(within(dialog).getByRole("button", { name: "Sign in" }));

		// aria-disabled, not disabled: a disabled button drops keyboard focus.
		expect(within(dialog).getByRole("button", { name: "Signing in…" })).toHaveAttribute("aria-disabled", "true");

		// What fetch() itself throws when the request never reaches a server.
		failLogin(new TypeError("Failed to fetch"));
		const alert = await within(dialog).findByRole("alert");
		expect(alert).toHaveTextContent("Can't reach the server. Check your connection and try again.");
		expect(alert).not.toHaveTextContent(/Failed to fetch/);
		expect(within(dialog).getByRole("button", { name: "Sign in" })).toBeEnabled();
	});

	it("names the privacy document as its page does, and uses no em dash", async () => {
		const user = userEvent.setup();
		renderModal();
		const { dialog } = await open(user);
		expect(within(dialog).getByRole("link", { name: "Privacy Notice" })).toHaveAttribute("href", "/privacy");
		expect(within(dialog).queryByText(/Privacy Policy/)).toBeNull();

		await user.click(within(dialog).getByRole("button", { name: "Continue with email" }));
		await user.click(within(dialog).getByRole("button", { name: "Forgot password?" }));
		const reset = await screen.findByRole("dialog", { name: "Reset your password" });
		expect(reset).toHaveTextContent(/Google or GitHub/);
		expect(reset.textContent).not.toMatch(/\u2014/);
	});

	it("error text meets contrast and the card can scroll on a short screen", () => {
		const css = readFileSync(resolve(process.cwd(), "src/components/AuthModal.css"), "utf8");
		const block = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
		expect(block(".authm-error")).not.toContain("#ef4444");
		expect(block(".authm-backdrop")).toMatch(/overflow-y:\s*auto/);
		expect(block(".authm-backdrop")).not.toMatch(/align-items:\s*center;/);
		expect(block(".authm-card")).toContain("margin: 0 auto auto");
	});
});
