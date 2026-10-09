import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthModal from "../components/AuthModal";
import { AuthProvider, useAuth } from "../contexts/authContext";
import ResetPassword from "../routes/ResetPassword";

// Account recovery, both halves: asking for a link from the sign-in card, and
// redeeming one on the page the link lands on.
//
// The assertion that matters most is the hedged wording after a request. The
// server answers identically whether or not the address has an account, so that
// this card can't be used to find out which addresses are registered — and the
// card therefore must not claim an email was sent.

let calls: { method: string; url: string; body?: unknown }[] = [];

const json = (body: unknown, ok = true, status = 200) => ({
	ok,
	status,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

const USER = { id: "u1", email: "jane@example.com", name: null, plan: "free", roles: [] };

beforeEach(() => {
	calls = [];
	localStorage.clear();
	sessionStorage.clear();
	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		const method = init?.method ?? "GET";
		calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });

		if (u.includes("/api/auth/forgot-password")) return json({ ok: true });
		if (u.includes("/api/auth/reset-password")) {
			const body = JSON.parse(String(init?.body)) as { token: string };
			return body.token === "good-token"
				? json({ user: USER })
				: json({ error: "This link has expired or has already been used." }, false, 400);
		}
		if (u.includes("/api/auth/me")) return json({ error: "no" }, false, 401);
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

// Opens the auth popup in sign-in mode, the way the header does.
const OpenSignIn: React.FC = () => {
	const { promptAuth } = useAuth();
	return <button onClick={() => promptAuth("signin")}>open</button>;
};

const renderModal = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<OpenSignIn />
				<AuthModal />
			</MemoryRouter>
		</AuthProvider>,
	);

const renderResetPage = (search: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[`/reset-password${search}`]}>
				<Routes>
					<Route path="/reset-password" element={<ResetPassword />} />
					<Route path="/dashboard" element={<div>Dashboard</div>} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>,
	);

describe("asking for a reset link", () => {
	it("is reachable from the sign-in form", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(screen.getByRole("button", { name: "open" }));
		await user.click(await screen.findByRole("button", { name: "Continue with email" }));
		await user.click(await screen.findByRole("button", { name: "Forgot password?" }));

		expect(await screen.findByRole("heading", { name: "Reset your password" }))
			.toBeInTheDocument();
	});

	it("sends the address and never claims an email was actually sent", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(screen.getByRole("button", { name: "open" }));
		await user.click(await screen.findByRole("button", { name: "Continue with email" }));
		await user.click(await screen.findByRole("button", { name: "Forgot password?" }));
		await user.type(await screen.findByLabelText(/Email/i), "jane@example.com");
		await user.click(screen.getByRole("button", { name: "Send reset link" }));

		const sent = calls.find((c) => c.url.includes("/forgot-password"));
		expect(sent?.body).toEqual({ email: "jane@example.com" });
		// "If an account exists", not "we sent you an email".
		expect(await screen.findByText(/If an account exists/i)).toBeInTheDocument();
	});

	it("points OAuth users at their provider rather than at a password", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(screen.getByRole("button", { name: "open" }));
		await user.click(await screen.findByRole("button", { name: "Continue with email" }));
		await user.click(await screen.findByRole("button", { name: "Forgot password?" }));

		expect(await screen.findByText(/Google or GitHub/)).toBeInTheDocument();
	});

	it("is not offered on the signup side, where there's no password to forget", async () => {
		const user = userEvent.setup();
		renderModal();

		await user.click(screen.getByRole("button", { name: "open" }));
		await user.click(await screen.findByRole("button", { name: "Continue with email" }));
		expect(screen.getByRole("button", { name: "Forgot password?" })).toBeInTheDocument();

		// Switching to signup keeps the email form open, so this is the same
		// form with the link gone rather than a fresh card.
		await user.click(screen.getByRole("button", { name: "Sign up" }));
		await screen.findByRole("button", { name: "Create account" });

		expect(screen.queryByRole("button", { name: "Forgot password?" })).not.toBeInTheDocument();
	});
});

describe("redeeming a reset link", () => {
	it("refuses two passwords that don't match, without asking the server", async () => {
		const user = userEvent.setup();
		renderResetPage("?token=good-token");

		await user.type(await screen.findByLabelText("New password"), "brandnewpass");
		await user.type(screen.getByLabelText("Confirm new password"), "brandnewpasx");
		await user.click(screen.getByRole("button", { name: "Set new password" }));

		expect(await screen.findByText(/don't match/i)).toBeInTheDocument();
		expect(calls.some((c) => c.url.includes("/reset-password"))).toBe(false);
	});

	it("refuses a short password without asking the server", async () => {
		const user = userEvent.setup();
		renderResetPage("?token=good-token");

		await user.type(await screen.findByLabelText("New password"), "short");
		await user.type(screen.getByLabelText("Confirm new password"), "short");
		await user.click(screen.getByRole("button", { name: "Set new password" }));

		expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
		expect(calls.some((c) => c.url.includes("/reset-password"))).toBe(false);
	});

	it("sends the token with the new password and confirms the change", async () => {
		const user = userEvent.setup();
		renderResetPage("?token=good-token");

		await user.type(await screen.findByLabelText("New password"), "brandnewpass");
		await user.type(screen.getByLabelText("Confirm new password"), "brandnewpass");
		await user.click(screen.getByRole("button", { name: "Set new password" }));

		expect(await screen.findByRole("heading", { name: "Password changed" }))
			.toBeInTheDocument();
		const sent = calls.find((c) => c.url.includes("/api/auth/reset-password"));
		expect(sent?.body).toEqual({ token: "good-token", password: "brandnewpass" });
	});

	it("surfaces the server's refusal of a spent link", async () => {
		const user = userEvent.setup();
		renderResetPage("?token=stale-token");

		await user.type(await screen.findByLabelText("New password"), "brandnewpass");
		await user.type(screen.getByLabelText("Confirm new password"), "brandnewpass");
		await user.click(screen.getByRole("button", { name: "Set new password" }));

		expect(await screen.findByRole("status")).toHaveTextContent(/expired or has already been used/i);
	});

	it("announces errors through an alert region that exists before the error does", async () => {
		const user = userEvent.setup();
		renderResetPage("?token=good-token");

		const alert = await screen.findByRole("alert");
		expect(alert).toBeEmptyDOMElement();
		const input = screen.getByLabelText("New password");
		await user.type(input, "short");
		await user.type(screen.getByLabelText("Confirm new password"), "short");
		await user.click(screen.getByRole("button", { name: "Set new password" }));

		// Same element, now holding the message, and the fields point at it.
		expect(screen.getByRole("alert")).toBe(alert);
		expect(alert).toHaveTextContent(/at least 8 characters/i);
		expect(input).toHaveAttribute("aria-describedby", alert.id);
		expect(input).toHaveAttribute("aria-invalid", "true");
	});

	it("names the logo link and has a main landmark", async () => {
		renderResetPage("?token=good-token");
		expect(await screen.findByRole("link", { name: "BodyMaps home" })).toHaveAttribute("href", "/");
		expect(screen.getByRole("main")).toBeInTheDocument();
	});

	it("says so when the link arrived without a token at all", async () => {
		renderResetPage("");
		expect(await screen.findByRole("heading", { name: "That link is incomplete" }))
			.toBeInTheDocument();
		expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
	});
});
