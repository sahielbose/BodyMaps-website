/**
 * Settings sections are separate chunks. While one loads for the first time it
 * waits inside the panel, so the page header and the section nav stay on screen
 * instead of the whole page giving way to the full-screen route spinner.
 */
import { render, screen } from "@testing-library/react";
import { lazy } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import SettingsPage from "../routes/Settings";

const USER = {
	id: "u1",
	email: "test.user@example.com",
	name: null,
	plan: "free",
	account_type: null,
	organization: null,
	occupation: null,
	role_description: null,
	email_verified: true,
	roles: [] as string[],
};

const json = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	localStorage.clear();
	global.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({ items: [], total: 0, ids: [] });
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

// A section whose chunk never finishes loading.
const NeverLoads = lazy(() => new Promise<{ default: () => null }>(() => {}));

describe("loading a settings section", () => {
	it("keeps the header and nav on screen and shows the spinner in the panel", async () => {
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/account/plan"]}>
					<Routes>
						<Route path="/account" element={<SettingsPage />}>
							<Route path="plan" element={<NeverLoads />} />
						</Route>
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);

		expect(await screen.findByRole("status", { name: "Loading section" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /Profile/ })).toBeInTheDocument();
	});
});
