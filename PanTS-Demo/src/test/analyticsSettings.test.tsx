/**
 * The admin usage dashboard (Settings > Analytics) against a stubbed API:
 * the wording of its counts, and that what it draws always matches the
 * filters it shows.
 */
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import AnalyticsSettings from "../routes/Settings/AnalyticsSettings";
import { plural } from "../routes/Settings/analytics/format";

const ADMIN = { id: "a1", email: "admin@example.com", name: "Admin", plan: "free", roles: ["admin"] };

const META = {
	plans: ["free", "pro"],
	account_types: ["student"],
	audiences: ["all", "signed_in", "anonymous"],
	action_names: ["upload_start_inference"],
	routes: ["/upload"],
};

type Country = { country_code: string; country_name: string; sessions: number; people: number; events: number };

/** An overview with one visitor doing one thing, in the given countries. */
const overview = (countries: Country[] = [
	{ country_code: "US", country_name: "United States", sessions: 1, people: 1, events: 1 },
]) => ({
	range: { start: "2026-09-01T00:00:00", end: "2026-09-29T12:34:56.123456" },
	totals: { events: 1, people: 1, sessions: 1, signed_in_people: 0, time_ms: 1000 },
	previous: { events: 0, people: 0, sessions: 0 },
	top_actions: [{ name: "upload_start_inference", count: 1, people: 1 }],
	time_by_route: [{ route: "/upload", views: 1, total_ms: 1000, avg_ms: 1000, people: 1 }],
	by_plan: [], by_account_type: [], daily: [],
	by_country: countries,
	by_city: [],
	by_device: [], new_vs_returning: { new: 1, returning: 0 },
	by_weekday: [], by_hour: [],
});

const json = (body: unknown) =>
	new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

let answerOverview: (url: string) => Promise<Response>;

beforeEach(() => {
	answerOverview = async () => json(overview());
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const u = String(input);
			if (u.includes("/api/auth/me")) return json({ user: ADMIN });
			if (u.includes("/api/analytics/meta")) return json(META);
			if (u.includes("/api/analytics/overview")) return answerOverview(u);
			return json({});
		})
	);
});

afterEach(() => vi.unstubAllGlobals());

const renderDashboard = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<AnalyticsSettings />
			</MemoryRouter>
		</AuthProvider>
	);

describe("usage dashboard counts", () => {
	it("pluralises a count by its number", () => {
		expect(plural(1, "visit", "visits")).toBe("1 visit");
		expect(plural(2, "visit", "visits")).toBe("2 visits");
		expect(plural(0, "person", "people")).toBe("0 people");
	});

	it("says one visit by one person on hover, not 1 visits by 1 people", async () => {
		renderDashboard();
		const country = (await screen.findByText("United States")).closest("li")!;
		expect(country).toHaveAttribute("title", "United States: 1 visit by 1 person");

		const route = screen.getByText("/upload").closest("li")!;
		expect(route.getAttribute("title")).toMatch(/across 1 visit by 1 person$/);

		for (const row of screen.getAllByText("Upload start inference")) {
			expect(row.closest("li")).toHaveAttribute("title", "upload_start_inference: 1 time by 1 person");
		}
	});
});

const country = (code: string, name: string): Country =>
	({ country_code: code, country_name: name, sessions: 3, people: 2, events: 5 });

describe("usage dashboard filters", () => {
	it("ignores an older request that answers after a newer one", async () => {
		const user = userEvent.setup();
		renderDashboard();
		await screen.findByText("United States");

		const pending: ((res: Response) => void)[] = [];
		answerOverview = () => new Promise((resolve) => pending.push(resolve));
		const plan = screen.getAllByRole("combobox")[0];
		await user.selectOptions(plan, "pro");
		await user.selectOptions(plan, "");
		expect(pending).toHaveLength(2);

		// The newer request (plan cleared) answers first, the older one last.
		await act(async () => pending[1](json(overview([country("FR", "France")]))));
		expect(await screen.findByText("France")).toBeInTheDocument();
		await act(async () => {
			pending[0](json(overview([country("DE", "Germany")])));
			await new Promise((r) => setTimeout(r, 20));
		});

		expect(screen.getByText("France")).toBeInTheDocument();
		expect(screen.queryByText("Germany")).toBeNull();
		expect(plan).toHaveValue("");
	});
});

describe("usage dashboard country filter", () => {
	it("can be set from the keyboard through the list beside the map", async () => {
		const asked: string[] = [];
		answerOverview = async (url) => {
			asked.push(url);
			return json(overview());
		};
		const user = userEvent.setup();
		renderDashboard();

		const pick = await screen.findByRole("button", { name: "United States" });
		expect(pick).toHaveAttribute("aria-pressed", "false");
		pick.focus();
		await user.keyboard("{Enter}");

		expect(await screen.findByRole("heading", { name: "Cities in United States" })).toBeInTheDocument();
		expect(asked.at(-1)).toContain("country=US");
		await user.click(screen.getByRole("button", { name: "Show the whole world" }));
		expect(await screen.findByRole("heading", { name: "Top countries" })).toBeInTheDocument();
	});
});
