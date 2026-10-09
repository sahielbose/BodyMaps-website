import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthModal from "../components/AuthModal";
import { AuthProvider, useAuth } from "../contexts/authContext";
import SignupRedirect from "../routes/SignupRedirect";

// Creating an account, at the component level. It's the auth popup's signup
// mode — the same card as signing in, with a different title and submit button.
// No account type, no plan picker, no terms checkbox: a new account lands on
// Free and meets its limits when it reaches them.
//
// Settings has its own suite (accountPage.test.tsx).

const USER = { id: "u1", email: "test@example.com", plan: "free" };

let signedIn = false;
// What the register endpoint received, so the request can be asserted on.
let registeredWith: Record<string, unknown> | null = null;

const jsonResponse = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	localStorage.clear();
	signedIn = false;
	registeredWith = null;
	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/api/auth/me")) return jsonResponse({ user: signedIn ? USER : null });
		if (u.includes("/api/auth/register") || u.includes("/api/auth/login")) {
			if (u.includes("/register") && init?.body) {
				registeredWith = JSON.parse(String(init.body));
			}
			signedIn = true;
			return jsonResponse({ user: USER });
		}
		if (u.includes("/api/auth/oauth/providers")) return jsonResponse({ google: true, github: true });
		return jsonResponse({ items: [], total: 0, ids: [] });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

/** Opens the popup straight into signup mode, the way a "Sign up" click does. */
const OpenSignup: React.FC = () => {
	const { promptAuth } = useAuth();
	return (
		<button type="button" onClick={() => promptAuth("signup")}>open signup</button>
	);
};

const renderPopup = () =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={["/"]}>
				<OpenSignup />
				<AuthModal />
			</MemoryRouter>
		</AuthProvider>
	);

/** Opens signup and reveals the email/password form behind "Continue with email". */
const openEmailSignup = async (user: ReturnType<typeof userEvent.setup>) => {
	await user.click(await screen.findByRole("button", { name: "open signup" }));
	await user.click(await screen.findByRole("button", { name: "Continue with email" }));
};

describe("signup popup", () => {
	it("creates the account from the popup", async () => {
		const user = userEvent.setup();
		renderPopup();
		await openEmailSignup(user);

		await user.type(screen.getByLabelText(/^Email$/i), "test@example.com");
		await user.type(screen.getByLabelText(/^Password$/i), "hunter2hunter2");
		await user.click(screen.getByRole("button", { name: "Create account" }));

		await waitFor(() =>
			expect(registeredWith).toMatchObject({
				email: "test@example.com", password: "hunter2hunter2",
			})
		);
		// authContext closes the popup once a user is established.
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
	});

	it("is a popup, not a page", async () => {
		const user = userEvent.setup();
		renderPopup();
		await user.click(await screen.findByRole("button", { name: "open signup" }));

		const dialog = await screen.findByRole("dialog", { name: "Create your account" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
	});

	it("asks nothing beyond an email and a password", async () => {
		const user = userEvent.setup();
		renderPopup();
		await openEmailSignup(user);

		expect(screen.queryByLabelText(/^Name$/i)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(/Confirm password/i)).not.toBeInTheDocument();
		expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
		expect(document.body.textContent).not.toMatch(/How will you use|Choose a plan/i);
	});

	it("accepts the terms inline rather than as a step", async () => {
		const user = userEvent.setup();
		renderPopup();
		await user.click(await screen.findByRole("button", { name: "open signup" }));

		expect(screen.getByText(/By continuing, you agree to the/i)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
		expect(screen.getByRole("link", { name: "Privacy Notice" })).toHaveAttribute("href", "/privacy");
	});

	it("offers both providers, with the same wording as sign-in", async () => {
		const user = userEvent.setup();
		renderPopup();
		await user.click(await screen.findByRole("button", { name: "open signup" }));

		expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Continue with GitHub/i })).toBeInTheDocument();
	});

	it("disables a provider the server has no credentials for", async () => {
		global.fetch = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/me")) return jsonResponse({ user: null });
			if (u.includes("/api/auth/oauth/providers")) return jsonResponse({ google: true, github: false });
			return jsonResponse({});
		}) as unknown as typeof fetch;

		const user = userEvent.setup();
		renderPopup();
		await user.click(await screen.findByRole("button", { name: "open signup" }));

		await waitFor(() =>
			expect(screen.getByRole("button", { name: /Continue with GitHub/i })).toBeDisabled()
		);
		expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeEnabled();
	});

	it("reports a rejected registration without closing", async () => {
		global.fetch = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/me")) return jsonResponse({ user: null });
			if (u.includes("/api/auth/oauth/providers")) return jsonResponse({ google: true, github: false });
			if (u.includes("/api/auth/register")) {
				return {
					ok: false, status: 409,
					json: async () => ({ error: "An account with that email already exists" }),
					text: async () => "",
					headers: { get: () => "application/json" },
				};
			}
			return jsonResponse({});
		}) as unknown as typeof fetch;

		const user = userEvent.setup();
		renderPopup();
		await openEmailSignup(user);

		await user.type(screen.getByLabelText(/^Email$/i), "taken@example.com");
		await user.type(screen.getByLabelText(/^Password$/i), "hunter2hunter2");
		await user.click(screen.getByRole("button", { name: "Create account" }));

		expect(
			await screen.findByText("An account with that email already exists")
		).toBeInTheDocument();
		expect(screen.getByRole("dialog", { name: "Create your account" })).toBeInTheDocument();
	});
});

describe("switching between the two modes", () => {
	it("flips to sign-in and back without closing", async () => {
		const user = userEvent.setup();
		renderPopup();
		await user.click(await screen.findByRole("button", { name: "open signup" }));

		await user.click(screen.getByRole("button", { name: "Sign in" }));
		expect(await screen.findByRole("dialog", { name: "Sign in" })).toBeInTheDocument();
		// The same fine print is shown on sign-in: Terms accepted, Privacy acknowledged.
		expect(screen.getByText(/By continuing, you agree to the/i)).toBeInTheDocument();
		expect(screen.getByText(/and acknowledge the/i)).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Sign up" }));
		expect(await screen.findByRole("dialog", { name: "Create your account" })).toBeInTheDocument();
	});

	it("clears a failed attempt when flipping mode", async () => {
		global.fetch = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/me")) return jsonResponse({ user: null });
			if (u.includes("/api/auth/oauth/providers")) return jsonResponse({ google: true, github: true });
			if (u.includes("/api/auth/register")) {
				return {
					ok: false, status: 409,
					json: async () => ({ error: "An account with that email already exists" }),
					text: async () => "",
					headers: { get: () => "application/json" },
				};
			}
			return jsonResponse({});
		}) as unknown as typeof fetch;

		const user = userEvent.setup();
		renderPopup();
		await openEmailSignup(user);
		await user.type(screen.getByLabelText(/^Email$/i), "taken@example.com");
		await user.type(screen.getByLabelText(/^Password$/i), "hunter2hunter2");
		await user.click(screen.getByRole("button", { name: "Create account" }));
		await screen.findByText("An account with that email already exists");

		await user.click(screen.getByRole("button", { name: "Sign in" }));
		await waitFor(() =>
			expect(
				screen.queryByText("An account with that email already exists")
			).not.toBeInTheDocument()
		);
		// The email survives the flip; the password does not.
		expect(screen.getByLabelText(/^Email$/i)).toHaveValue("taken@example.com");
		expect(screen.getByLabelText(/^Password$/i)).toHaveValue("");
	});
});

describe("/signup", () => {
	const renderRoute = () =>
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/signup"]}>
					<Routes>
						<Route path="/signup" element={<SignupRedirect />} />
						<Route path="/" element={<div>Landing</div>} />
						<Route path="/upload" element={<div>Upload page</div>} />
					</Routes>
					<AuthModal />
				</MemoryRouter>
			</AuthProvider>
		);

	it("still works as a link, opening the popup over the landing page", async () => {
		renderRoute();
		expect(await screen.findByText("Landing")).toBeInTheDocument();
		expect(
			await screen.findByRole("dialog", { name: "Create your account" })
		).toBeInTheDocument();
	});

	it("sends someone who is already signed in to the app instead", async () => {
		signedIn = true;
		renderRoute();
		await waitFor(() => expect(screen.getByText("Upload page")).toBeInTheDocument());
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
