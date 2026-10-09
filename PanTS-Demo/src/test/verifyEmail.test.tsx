import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import VerifyEmail from "../routes/VerifyEmail";

const json = (body: unknown, ok = true, status = 200) => ({
	ok,
	status,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

let calls: string[] = [];

beforeEach(() => {
	calls = [];
	// A redeemed token is remembered for the tab, so each test starts without one.
	sessionStorage.clear();
	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		calls.push(`${init?.method ?? "GET"} ${u}`);
		if (u.includes("/api/auth/verify-email")) {
			const body = JSON.parse(String(init?.body)) as { token: string };
			if (body.token === "good") {
				return json({ ok: true, user: { id: "u9", email: "v@w.com", email_verified: true } });
			}
			return json(
				{ error: "This link has expired or has already been used. Ask for a new one from Settings." },
				false,
				400,
			);
		}
		return json({ items: [], total: 0, ids: [] });
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

const renderAt = (url: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[url]}>
				<Routes>
					<Route path="/verify-email" element={<VerifyEmail />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>,
	);

describe("verify-email landing page", () => {
	it("redeems the token from the link and reports success", async () => {
		renderAt("/verify-email?token=good");
		expect(await screen.findByText("Email verified")).toBeInTheDocument();
		await waitFor(() =>
			expect(calls.some((c) => c.startsWith("POST") && c.includes("verify-email"))).toBe(true),
		);
	});

	it("explains an expired link and where to get a fresh one", async () => {
		renderAt("/verify-email?token=stale");
		expect(await screen.findByText("Couldn't verify")).toBeInTheDocument();
		expect(await screen.findByText(/expired or has already been used/)).toBeInTheDocument();
	});

	it("announces the outcome through a status line that was there from the start", async () => {
		renderAt("/verify-email?token=good");
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent("One moment.");
		await waitFor(() => expect(status).toHaveTextContent("Your email address is confirmed."));
		expect(screen.getByRole("status")).toBe(status);
		expect(screen.getByRole("link", { name: "BodyMaps home" })).toBeInTheDocument();
		expect(screen.getByRole("main")).toBeInTheDocument();
	});

	it("treats a link with no token as mangled, without calling the server", async () => {
		renderAt("/verify-email");
		expect(await screen.findByText("Couldn't verify")).toBeInTheDocument();
		expect(calls.some((c) => c.includes("verify-email"))).toBe(false);
	});
});
