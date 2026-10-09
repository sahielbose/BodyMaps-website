// The two endpoints the usage dashboard reads.
//
// Both need the server started with ANALYTICS_DASHBOARD=true *and* an admin
// session. Those two refusals are different things and the page says so
// differently: a 404 is "this deploy doesn't serve analytics at all", a 403 is
// "you're signed in and this isn't yours". Neither is a bug to retry. A 401 is
// neither: the session ended, and signing in again is the way forward.

import { API_BASE } from "../../../helpers/constants";

export type Audience = "all" | "signed_in" | "anonymous";

export type Filters = {
	from: string;
	to: string;
	plan: string;
	accountType: string;
	audience: Audience;
	/** "Ever": ignores from/to and starts at the oldest event on record. */
	allTime: boolean;
	/** Alpha-2, set by clicking into a country on the map. Narrows the WHOLE
	 *  response, not just the location panels — see overview() on the server. */
	country: string;
};

export type Overview = {
	range: { start: string; end: string };
	totals: {
		events: number;
		people: number;
		sessions: number;
		signed_in_people: number;
		time_ms: number;
	};
	/** The same counts over the window immediately before this one, so each
	 *  headline number can carry a change against it. No time_ms — the server
	 *  doesn't compute one. */
	previous: { events: number; people: number; sessions: number };
	top_actions: { name: string; count: number; people: number }[];
	time_by_route: {
		route: string; views: number; total_ms: number; avg_ms: number; people: number;
	}[];
	by_plan: { plan: string; events: number; people: number }[];
	by_account_type: { account_type: string; events: number; people: number }[];
	daily: { day: string; events: number; people: number }[];
	by_country: {
		country_code: string; country_name: string;
		sessions: number; people: number; events: number;
	}[];
	/** Only populated when a country is selected; empty otherwise. */
	by_city: {
		city: string; region: string | null;
		latitude: number | null; longitude: number | null;
		sessions: number; people: number;
	}[];
	by_device: { device_type: string; sessions: number; people: number }[];
	new_vs_returning: { new: number; returning: number };
	/** 0 = Sunday, as SQLite's %w reports it. Named client-side so the day
	 *  names come out in the reader's locale. */
	by_weekday: { weekday: number; sessions: number; people: number }[];
	by_hour: { hour: number; sessions: number; people: number }[];
};

export type Meta = {
	plans: string[];
	account_types: string[];
	audiences: Audience[];
	/** Every action the server will store. The ones missing from top_actions are
	 *  exactly the features nobody has used — which is half the question. */
	action_names: string[];
	routes: string[];
};

/** The server is up but this deploy doesn't serve the dashboard endpoints. */
export class DashboardDisabled extends Error {}
/** Signed in, but not an admin. */
export class DashboardForbidden extends Error {}
/** The session behind an admin's page has ended (cookie expired or revoked). */
export class DashboardSignedOut extends Error {}

const get = async <T,>(path: string): Promise<T> => {
	let res: Response;
	try {
		res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
	} catch {
		throw new Error("Can't reach the API. Is the server running?");
	}
	if (res.status === 404) {
		throw new DashboardDisabled(
			"This server isn't serving analytics. It needs to be started with ANALYTICS_DASHBOARD=true."
		);
	}
	if (res.status === 401) {
		throw new DashboardSignedOut("Your session has ended. Sign in again.");
	}
	if (res.status === 403) {
		throw new DashboardForbidden("You need an admin account to see usage data.");
	}
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error || `Request failed (${res.status}).`);
	}
	return res.json() as Promise<T>;
};

export const fetchMeta = () => get<Meta>("/api/analytics/meta");

export const fetchOverview = (f: Filters) => {
	const params = new URLSearchParams({ audience: f.audience });
	if (f.allTime) params.set("range", "all");
	else {
		params.set("from", f.from);
		params.set("to", f.to);
	}
	if (f.plan) params.set("plan", f.plan);
	if (f.accountType) params.set("account_type", f.accountType);
	if (f.country) params.set("country", f.country);
	return get<Overview>(`/api/analytics/overview?${params}`);
};
