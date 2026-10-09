import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthModal from "../components/AuthModal";
import { AuthProvider } from "../contexts/authContext";
import SettingsPage from "../routes/Settings";
import HistorySettings from "../routes/Settings/HistorySettings";
import PlanSettings from "../routes/Settings/PlanSettings";
import PrivacySettings from "../routes/Settings/PrivacySettings";
import ProfileSettings from "../routes/Settings/ProfileSettings";
import { RECENT_UPLOADS_KEY, type RecentUpload } from "../helpers/recentUploads";

// Settings against a stubbed API. Each section is its own URL now, so the tests
// navigate to one rather than scrolling one long page. Assertions are on the
// requests the server would actually receive — that's the contract that matters.

const USER = {
	id: "u1",
	email: "test.user@example.com",
	name: null as string | null,
	plan: "free",
	account_type: null as string | null,
	organization: null as string | null,
	occupation: null as string | null,
	role_description: null as string | null,
	email_verified: false,
	roles: [] as string[],
};

const USAGE = {
	plan: "free",
	limits: { daily_scans: 1, daily_ai_messages: 10 },
	scans: { used: 0, limit: 1, in_flight: 0, resets_at: null },
	ai_messages: { used: 0, limit: 10, resets_at: null },
};

let calls: { method: string; url: string; body?: unknown }[] = [];
// The server reports the *effective* plan (verified-researcher promotion);
// tests set this to model it, since USER.plan deliberately stays "free".
let USAGE_PLAN_OVERRIDE: string | null = null;

const json = (body: unknown, ok = true, status = 200) => ({
	ok,
	status,
	json: async () => body,
	text: async () => "",
	blob: async () => new Blob([JSON.stringify(body)], { type: "application/json" }),
	headers: { get: () => "application/json" },
});

beforeEach(() => {
	calls = [];
	localStorage.clear();
	USER.name = null;
	USER.plan = "free";
	USER.account_type = null;
	USER.organization = null;
	USER.occupation = null;
	USER.role_description = null;
	USER.email_verified = false;
	USER.roles = [];
	USAGE_PLAN_OVERRIDE = null;
	USAGE.limits.daily_scans = 1;
	USAGE.scans.limit = 1;
	URL.createObjectURL = vi.fn(() => "blob:stub");
	URL.revokeObjectURL = vi.fn();

	global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
		const u = String(url);
		const method = init?.method ?? "GET";
		calls.push({ method, url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });

		if (u.includes("/api/auth/send-verification")) {
			return json({ ok: true, already_verified: false, sent: true });
		}
		if (u.includes("/api/auth/me") && method === "PATCH") {
			const patch = JSON.parse(String(init?.body)) as {
				name?: string; account_type?: string;
				organization?: string; occupation?: string; role_description?: string;
			};
			if ("name" in patch) USER.name = patch.name || null;
			if ("account_type" in patch) USER.account_type = patch.account_type || null;
			if ("organization" in patch) USER.organization = patch.organization || null;
			if ("occupation" in patch) USER.occupation = patch.occupation || null;
			if ("role_description" in patch) USER.role_description = patch.role_description || null;
			return json({ user: { ...USER } });
		}
		if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
		if (u.includes("/api/me/plan")) {
			USER.plan = (JSON.parse(String(init?.body)) as { plan: string }).plan;
			return json({ user: { ...USER } });
		}
		if (u.includes("/api/me/usage")) {
			return json({ ...USAGE, plan: USAGE_PLAN_OVERRIDE ?? USER.plan });
		}
		if (u.includes("/api/me/export")) {
			return json({
				exported_at: "2026-08-29T00:00:00",
				account: { email: USER.email, name: USER.name, account_type: USER.account_type, plan: USER.plan, created_at: "2026-08-01T00:00:00" },
			});
		}
		if (u.includes("/api/me/jobs") && method === "DELETE") {
			return json({ deleted: { jobs: 2, files: 5, runs: 1 } });
		}
		if (u.endsWith("/api/me") && method === "DELETE") {
			return json({
				deletion_requested_at: "2026-08-02T00:00:00",
				restore_by: "2026-09-01T00:00:00",
				grace_days: 30,
			});
		}
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({ items: [], total: 0, ids: [] });
	}) as unknown as typeof fetch;
});

afterEach(() => vi.restoreAllMocks());

/** Renders the settings shell at one of its sections. */
const renderAt = (path = "/account", signedOutElement: ReactElement = <div>Landing</div>) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/account" element={<SettingsPage />}>
						<Route index element={<ProfileSettings />} />
						<Route path="plan" element={<PlanSettings />} />
						<Route path="history" element={<HistorySettings />} />
							<Route path="privacy" element={<PrivacySettings />} />
					</Route>
					<Route path="/" element={signedOutElement} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

const lastCall = (method: string, fragment: string) =>
	[...calls].reverse().find((c) => c.method === method && c.url.includes(fragment));

describe("navigation", () => {
	it("offers a section per URL", async () => {
		const user = userEvent.setup();
		renderAt();
		await screen.findByRole("heading", { name: "Profile" });

		for (const [link, heading] of [
			["Plan", "Usage"],
			["History", "History"],
			["Privacy", "Your data"],
		] as const) {
			await user.click(screen.getByRole("link", { name: link }));
			expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
		}
	});

	it("opens straight at a deep-linked section", async () => {
		renderAt("/account/privacy");
		expect(await screen.findByRole("heading", { name: "Your data" })).toBeInTheDocument();
	});
});

describe("display name", () => {
	it("shows the email-derived name as a placeholder, not a value to delete", async () => {
		renderAt();
		const field = await screen.findByLabelText("Name");
		expect(field).toHaveValue("");
		expect(field).toHaveAttribute("placeholder", "Test User");
	});

	it("saves on blur without an edit mode", async () => {
		const user = userEvent.setup();
		renderAt();

		await user.type(await screen.findByLabelText("Name"), "Ada Lovelace");
		await user.tab();

		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ name: "Ada Lovelace" })
		);
		expect(await screen.findByText(/Your name has been updated/i)).toBeInTheDocument();
	});

	it("saves the role to the account rather than to this browser", async () => {
		const user = userEvent.setup();
		renderAt();

		await user.selectOptions(await screen.findByLabelText(/Role/), "clinician");

		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ account_type: "clinician" })
		);
		expect(await screen.findByText(/role is set to Clinician/i)).toBeInTheDocument();
	});

	it("clears the role with an empty value", async () => {
		const user = userEvent.setup();
		USER.account_type = "student";
		renderAt();

		await user.selectOptions(await screen.findByLabelText(/Role/), "");

		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ account_type: "" })
		);
	});

	it("does not fire a request when the field is left unchanged", async () => {
		const user = userEvent.setup();
		renderAt();

		await user.click(await screen.findByLabelText("Name"));
		await user.tab();

		expect(lastCall("PATCH", "/api/auth/me")).toBeUndefined();
	});

	it("surfaces a save failure instead of silently doing nothing", async () => {
		const user = userEvent.setup();
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/auth/me") && init?.method === "PATCH") {
				return json({ error: "Name must be text" }, false, 400);
			}
			if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
			return json({});
		}) as unknown as typeof fetch;

		renderAt();
		await user.type(await screen.findByLabelText("Name"), "x");
		await user.tab();

		expect(await screen.findByText("Name must be text")).toBeInTheDocument();
	});

	it("keeps the notification switch on Profile rather than a page of its own", async () => {
		renderAt();
		expect(await screen.findByText("Email me when a scan finishes")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: "Notifications" })).not.toBeInTheDocument();
	});
});

describe("email verification", () => {
	it("offers to resend the link until the address is verified", async () => {
		const user = userEvent.setup();
		renderAt();
		await user.click(await screen.findByRole("button", { name: "Resend" }));
		await waitFor(() => expect(lastCall("POST", "/api/auth/send-verification")).toBeTruthy());
		expect(await screen.findByText(/Verification email sent/)).toBeInTheDocument();
	});
});

describe("verified researcher profile", () => {
	it("saves each field on blur with the server's field names", async () => {
		const user = userEvent.setup();
		renderAt();

		const org = await screen.findByLabelText(/Organization/);
		await user.type(org, "Duke University");
		await user.tab();
		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ organization: "Duke University" })
		);
		expect(await screen.findByText("Your organization has been saved.")).toBeInTheDocument();

		const occ = screen.getByLabelText(/Occupation/);
		await user.type(occ, "Radiologist");
		await user.tab();
		await waitFor(() =>
			expect(lastCall("PATCH", "/api/auth/me")?.body).toEqual({ occupation: "Radiologist" })
		);
	});

	it("explains what the profile unlocks", async () => {
		renderAt();
		expect(
			await screen.findByText(/A verified email and a full profile unlock 10 scans a day/)
		).toBeInTheDocument();
	});
});

describe("signing out", () => {
	const landing = (
		<>
			<div>Landing</div>
			<AuthModal />
		</>
	);

	it("from the page lands on the overview without opening the sign-in popup", async () => {
		const user = userEvent.setup();
		renderAt("/account", landing);
		await user.click(await screen.findByRole("button", { name: "Sign out" }));

		expect(await screen.findByText("Landing")).toBeInTheDocument();
		await waitFor(() => expect(lastCall("POST", "/api/auth/logout")).toBeTruthy());
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("from the header's account menu lands on the overview without the popup", async () => {
		const user = userEvent.setup();
		renderAt("/account", landing);
		await screen.findByRole("heading", { name: "Profile" });
		const trigger = screen.getByRole("button", { name: /test\.user@example\.com/ });
		await user.click(trigger);
		const menu = document.getElementById(trigger.getAttribute("aria-controls")!)!;
		await user.click(within(menu).getByRole("button", { name: "Sign out" }));

		expect(await screen.findByText("Landing")).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("deleting the account lands on the overview without the popup", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy", landing);
		await user.click((await screen.findByRole("button", { name: "Delete account" })));
		await user.type(screen.getByLabelText(/Type DELETE to confirm/i), "DELETE");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		expect(await screen.findByText("Landing")).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("still asks a visitor who arrives signed out to sign in", async () => {
		const answer = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
			String(url).includes("/api/auth/me") ? json({ user: null }) : answer(url, init)
		) as unknown as typeof fetch;
		renderAt("/account", landing);

		expect(await screen.findByText("Landing")).toBeInTheDocument();
		expect(await screen.findByRole("dialog", { name: "Sign in" })).toBeInTheDocument();
	});
});

describe("profile layout", () => {
	it("lets a long email break inside the card on a phone instead of overflowing it", async () => {
		renderAt("/account");
		// The email row's value; the header's account button shows it as well.
		expect(await screen.findByText(USER.email, { selector: ".set-row-value" })).toBeInTheDocument();

		const css = readFileSync(resolve(process.cwd(), "src/routes/Settings/Settings.css"), "utf8");
		const start = css.indexOf(".set-row-value {");
		const rule = css.slice(start, css.indexOf("}", start));
		expect(rule).toMatch(/min-width:\s*0/);
		expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
	});

	it("slides the email switch's knob with the track instead of jumping it across", () => {
		const css = readFileSync(resolve(process.cwd(), "src/routes/Settings/Settings.css"), "utf8");
		const ruleOf = (selector: string) => {
			const start = css.indexOf(`${selector} {`);
			expect(start).toBeGreaterThanOrEqual(0);
			return css.slice(start, css.indexOf("}", start));
		};
		// justify-content can't be animated, so the on state must not move the knob with it.
		expect(ruleOf(".set-switch--on")).not.toMatch(/justify-content/);
		expect(ruleOf(".set-switch-knob")).toMatch(/transition:\s*transform/);
		expect(ruleOf(".set-switch--on .set-switch-knob")).toMatch(/transform:\s*translateX\(17px\)/);
	});
});

describe("plan", () => {
	it("shows the current plan and what's been used of it", async () => {
		renderAt("/account/plan");
		expect(await screen.findByRole("heading", { name: "Free plan" })).toBeInTheDocument();
		expect(await screen.findByText("0 of 1")).toBeInTheDocument();
		expect(screen.getByText("0 of 10")).toBeInTheDocument();
	});

	it("says so when usage can't be loaded, and can try again", async () => {
		let usageDown = true;
		const answer = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
			usageDown && String(url).includes("/api/me/usage")
				? json({ error: "Database is busy" }, false, 500)
				: answer(url, init)
		) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderAt("/account/plan");

		expect(await screen.findByText("Couldn't load your usage.")).toBeInTheDocument();
		expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

		usageDown = false;
		await user.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByText("0 of 1")).toBeInTheDocument();
		expect(screen.queryByText("Couldn't load your usage.")).not.toBeInTheDocument();
	});

	it("keeps the usage it has when a later refresh fails", async () => {
		USER.roles = ["admin"];
		let usageDown = false;
		const answer = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) =>
			usageDown && String(url).includes("/api/me/usage")
				? json({}, false, 503)
				: answer(url, init)
		) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderAt("/account/plan");
		expect(await screen.findByText("0 of 1")).toBeInTheDocument();

		usageDown = true;
		await user.click(screen.getByRole("button", { name: "Choose Pro" }));
		expect(await screen.findByText("You're on Pro.")).toBeInTheDocument();
		expect(screen.getByText("0 of 1")).toBeInTheDocument();
		expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
	});

	it("splits the plans into Individual and Team like the reference sites", async () => {
		const user = userEvent.setup();
		renderAt("/account/plan");
		await screen.findByRole("heading", { name: "Change plan" });

		expect(screen.getByRole("heading", { name: "Free" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Pro" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Team" })).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Team and Enterprise" }));
		expect(await screen.findByRole("heading", { name: "Team" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Enterprise" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Pro" })).not.toBeInTheDocument();
	});

	it("jumps to the picker without a smooth scroll for reduced motion", async () => {
		const originalMatchMedia = window.matchMedia;
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: query.includes("prefers-reduced-motion"),
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
		})) as unknown as typeof window.matchMedia;
		const scrollIntoView = vi.mocked(window.HTMLElement.prototype.scrollIntoView);
		scrollIntoView.mockClear();
		try {
			const user = userEvent.setup();
			renderAt("/account/plan");
			await user.click(await screen.findByRole("button", { name: "Change plan" }));
			expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto" });
		} finally {
			window.matchMedia = originalMatchMedia;
		}
	});

	it("marks the plan you're on and won't let you re-pick it", async () => {
		renderAt("/account/plan");
		await screen.findByRole("heading", { name: "Change plan" });
		expect(screen.getByRole("button", { name: "Current plan" })).toHaveAttribute("aria-disabled", "true");
	});

	it("locks Pro behind verification, and won't send anything", async () => {
		const user = userEvent.setup();
		renderAt("/account/plan");

		// A link to the Profile tab, where verification happens, not a dead button.
		const cta = await screen.findByRole("link", { name: "Verify to unlock" });
		expect(cta).toHaveAttribute("href", "/account");
		await user.click(cta);
		expect(lastCall("POST", "/api/me/plan")).toBeUndefined();
	});

	it("names the promoted tier once verification and the profile are done", async () => {
		USAGE_PLAN_OVERRIDE = "pro";
		USAGE.limits.daily_scans = 10;
		USAGE.scans.limit = 10;
		renderAt("/account/plan");

		expect(await screen.findByRole("heading", { name: "Pro plan" })).toBeInTheDocument();
		expect(await screen.findByRole("button", { name: "Current plan" })).toBeInTheDocument();
	});

	it("upgrades through the server, not local state", async () => {
		USER.roles = ["admin"]; // the paid plans are closed to everyone else
		const user = userEvent.setup();
		renderAt("/account/plan");

		await user.click(await screen.findByRole("button", { name: "Choose Pro" }));

		await waitFor(() => expect(lastCall("POST", "/api/me/plan")?.body).toEqual({ plan: "pro" }));
		expect(await screen.findByText("You're on Pro.")).toBeInTheDocument();
	});

	it("shows Free as free and the future tiers without a price", async () => {
		renderAt("/account/plan");
		await screen.findByRole("heading", { name: "Change plan" });
		expect(screen.getByText("$0")).toBeInTheDocument();
		expect(screen.getByText("always free")).toBeInTheDocument();
		// The picker shows one group at a time; "individual" = Free + Pro. Pro
		// costs nothing - it is earned, not bought.
		expect(screen.getByText("verify email + complete profile")).toBeInTheDocument();
		// "$0" is real; no invented $x.xx prices anywhere.
		expect(screen.queryByText(/\$\d+\.\d{2}/)).toBeNull();
	});
});

describe("history", () => {
	const day = 24 * 60 * 60 * 1000;
	const entry = (over: Partial<RecentUpload>): RecentUpload => ({
		sessionId: "s", label: "ct.nii.gz", model: "LesionSegmenter",
		status: "Completed", timestamp: Date.now(), ownerId: "u1", ...over,
	});

	it("lists scans older than a day and scans already opened, and says so", async () => {
		localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([
			entry({ sessionId: "new", label: "today.nii.gz", timestamp: Date.now() - 60_000 }),
			entry({ sessionId: "seen", label: "opened.nii.gz", timestamp: Date.now() - 60_000, viewed: true }),
			entry({ sessionId: "old", label: "lastweek.nii.gz", timestamp: Date.now() - 7 * day }),
		]));

		renderAt("/account/history");
		expect(await screen.findByText("lastweek.nii.gz")).toBeInTheDocument();
		expect(screen.getByText("opened.nii.gz")).toBeInTheDocument();
		expect(screen.queryByText("today.nii.gz")).not.toBeInTheDocument();
		// The page describes the same rule the list follows (splitByAge).
		expect(screen.getByText(/Scans you've already opened, and any older than a day/)).toBeInTheDocument();
	});

	it("names each row's View and Remove after its scan", async () => {
		localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([
			entry({ sessionId: "a", label: "lastweek.nii.gz", timestamp: Date.now() - 7 * day }),
			entry({ sessionId: "b", label: "lastmonth.nii.gz", timestamp: Date.now() - 30 * day }),
		]));
		renderAt("/account/history");
		expect(await screen.findByRole("button", { name: "View lastweek.nii.gz" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove lastweek.nii.gz" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove lastmonth.nii.gz" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
	});

	it("shows only this account's scans, and Remove cannot reach another account's", async () => {
		const user = userEvent.setup();
		localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([
			entry({ sessionId: "mine", label: "mine.nii.gz", timestamp: Date.now() - 7 * day }),
			entry({ sessionId: "theirs", label: "theirs.nii.gz", timestamp: Date.now() - 7 * day, ownerId: "u2" }),
			entry({ sessionId: "nobodys", label: "nobodys.nii.gz", timestamp: Date.now() - 7 * day, ownerId: undefined }),
		]));

		renderAt("/account/history");
		expect(await screen.findByText("mine.nii.gz")).toBeInTheDocument();
		expect(screen.queryByText("theirs.nii.gz")).not.toBeInTheDocument();
		expect(screen.queryByText("nobodys.nii.gz")).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Remove mine.nii.gz" }));
		expect((JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).map((u) => u.sessionId)).toEqual([
			"theirs",
			"nobodys",
		]);
	});

	it("says so when there's nothing old enough yet", async () => {
		localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([
			entry({ sessionId: "new", timestamp: Date.now() - 60_000 }),
		]));
		renderAt("/account/history");
		expect(await screen.findByText("Nothing here yet.")).toBeInTheDocument();
	});
});

describe("export", () => {
	it("downloads the account details from the server rather than rebuilding them locally", async () => {
		// jsdom can't navigate to the blob link, and its "not implemented"
		// error fires on a timer that sometimes lands as an unhandled error
		// and fails the whole run, so capture the click instead.
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click(await screen.findByRole("button", { name: "Export account details" }));

		await waitFor(() => expect(lastCall("GET", "/api/me/export")).toBeTruthy());
		expect(URL.createObjectURL).toHaveBeenCalled();
		expect(await screen.findByText(/Your account details have been downloaded/i)).toBeInTheDocument();
		expect(click).toHaveBeenCalledTimes(1);
		click.mockRestore();
	});
});

describe("delete scan history", () => {
	it("needs CLEAR typed, then reports how many scans went", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click(
			(await screen.findByRole("button", { name: "Delete scan history" }))
		);
		const confirm = screen.getByRole("button", { name: "Confirm" });
		expect(confirm).toHaveAttribute("aria-disabled", "true");
		expect(lastCall("DELETE", "/api/me/jobs")).toBeUndefined();

		await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
		await user.click(confirm);

		await waitFor(() => expect(lastCall("DELETE", "/api/me/jobs")).toBeTruthy());
		expect(await screen.findByText(/Removed 3 scans and their results/i)).toBeInTheDocument();
	});

	it("counts and clears only this account's scans from the browser's list", async () => {
		const user = userEvent.setup();
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/me/jobs") && (init?.method ?? "GET") === "DELETE") {
				return json({ deleted: { jobs: 0, files: 0, runs: 0 } });
			}
			if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
			if (u.includes("/api/me/usage")) return json(USAGE);
			if (u.includes("/api/me/runs/owned")) return json({ owned: [] }); // "nobodys" is not this account's
			return json({});
		}) as unknown as typeof fetch;
		const run = (sessionId: string, ownerId?: string): RecentUpload => ({
			sessionId, label: sessionId, model: "ePAI", status: "Completed", timestamp: Date.now(), ownerId,
		});
		localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify([run("mine", "u1"), run("theirs", "u2"), run("nobodys")]));
		renderAt("/account/privacy");

		await user.click((await screen.findByRole("button", { name: "Delete scan history" })));
		await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		expect(await screen.findByText("Removed 1 scan and their results.")).toBeInTheDocument();
		expect((JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as RecentUpload[]).map((u) => u.sessionId)).toEqual([
			"theirs",
			"nobodys",
		]);
	});

	it("keeps you signed in", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click((await screen.findByRole("button", { name: "Delete scan history" })));
		await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(lastCall("DELETE", "/api/me/jobs")).toBeTruthy());
		expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
	});
});

describe("privacy confirmation", () => {
	it("names what it confirms, and Escape closes it back to the button that opened it", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");
		const deleteAccount = (await screen.findByRole("button", { name: "Delete account" }));
		await user.click(deleteAccount);

		const dialog = screen.getByRole("alertdialog", { name: "Delete your account?" });
		expect(dialog.contains(document.activeElement)).toBe(true);
		await user.keyboard("{Escape}");
		expect(screen.queryByRole("alertdialog")).toBeNull();
		expect(document.activeElement).toBe(deleteAccount);
		expect(lastCall("DELETE", "/api/me")).toBeUndefined();
	});

	it("Cancel hands focus back to the Delete button that opened it", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");
		const deleteHistory = (await screen.findByRole("button", { name: "Delete scan history" }));
		await user.click(deleteHistory);

		const dialog = screen.getByRole("alertdialog", { name: "Delete your scan history?" });
		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(document.activeElement).toBe(deleteHistory);
	});
});

describe("delete account", () => {
	// The warning lives in the confirmation rather than on the page, so it has to
	// appear on the way through — not before, and not never.
	it("explains itself only once you start, and needs DELETE not CLEAR", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");
		await screen.findByRole("heading", { name: "Your data" });
		expect(screen.queryByText(/Sign back in before then/i)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "Delete account" }));
		expect(await screen.findByText(/Sign back in before then/i)).toBeInTheDocument();

		await user.type(screen.getByLabelText(/Type DELETE to confirm/i), "CLEAR");
		expect(screen.getByRole("button", { name: "Confirm" })).toHaveAttribute("aria-disabled", "true");
	});

	it("calls the endpoint and leaves settings once confirmed", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy");

		await user.click((await screen.findByRole("button", { name: "Delete account" })));
		await user.type(screen.getByLabelText(/Type DELETE to confirm/i), "DELETE");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(lastCall("DELETE", "/api/me")).toBeTruthy());
		expect(await screen.findByText("Landing")).toBeInTheDocument();
	});

	it("does not carry a deletion message onto the sign-in popup", async () => {
		const user = userEvent.setup();
		renderAt("/account/privacy", <AuthModal />);

		await user.click((await screen.findByRole("button", { name: "Delete account" })));
		await user.type(screen.getByLabelText(/Type DELETE to confirm/i), "DELETE");
		await user.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => expect(lastCall("DELETE", "/api/me")).toBeTruthy());
		expect(screen.queryByText(/scheduled for deletion/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/Sign back in before/i)).not.toBeInTheDocument();
	});
});

describe("success notices", () => {
	// Clearing scan history is the fixture: the one Privacy action that ends in
	// a success notice without signing you out.
	const clearHistory = async (user: ReturnType<typeof userEvent.setup>) => {
		await user.click((await screen.findByRole("button", { name: "Delete scan history" })));
		await user.type(screen.getByLabelText(/Type CLEAR to confirm/i), "CLEAR");
		await user.click(screen.getByRole("button", { name: "Confirm" }));
	};

	it("clear themselves instead of staying pinned to the page", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		renderAt("/account/privacy");

		await clearHistory(user);
		expect(await screen.findByText(/Removed 3 scans and their results/i)).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(6500);
		await waitFor(() =>
			expect(screen.queryByText(/Removed 3 scans and their results/i)).not.toBeInTheDocument()
		);
		vi.useRealTimers();
	});

	it("stay with the section they came from", async () => {
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/me/jobs") && (init?.method ?? "GET") === "DELETE") {
				return json({ error: "Storage is offline" }, false, 503);
			}
			if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
			if (u.includes("/api/me/usage")) return json(USAGE);
			return json({});
		}) as unknown as typeof fetch;
		const user = userEvent.setup();
		renderAt("/account/privacy");
		await clearHistory(user);
		expect(await screen.findByText(/Storage is offline/i)).toBeInTheDocument();

		await user.click(screen.getByRole("link", { name: "Plan" }));
		expect(await screen.findByRole("heading", { name: "Usage" })).toBeInTheDocument();
		expect(screen.queryByText(/Storage is offline/i)).not.toBeInTheDocument();
		expect(screen.getByRole("alert")).toBeEmptyDOMElement();
	});

	it("leaves errors up, since those still need acting on", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/api/me/jobs") && (init?.method ?? "GET") === "DELETE") {
				return json({ error: "Storage is offline" }, false, 503);
			}
			if (u.includes("/api/auth/me")) return json({ user: { ...USER } });
			return json({});
		}) as unknown as typeof fetch;

		renderAt("/account/privacy");
		await clearHistory(user);
		expect(await screen.findByText(/Storage is offline/i)).toBeInTheDocument();

		await vi.advanceTimersByTimeAsync(10000);
		expect(screen.getByText(/Storage is offline/i)).toBeInTheDocument();
		vi.useRealTimers();
	});
});
