// Product analytics: which features get used, and how long people spend on
// each part of the app.
//
// Deliberately hand-rolled and deliberately small. There is no third-party
// script here — this app handles medical imaging, and a tag manager that can
// ship arbitrary JS into the viewer is not a trade worth making for a bar chart.
//
// What leaves the browser is a feature name, a route PATTERN, and a duration.
// Never a case id, a filename, a search term, or anything typed into the app:
// `track("dataset_search")` records that a search happened, not what was
// searched for. The server enforces the same thing from its side by dropping
// anything not on its list (flask-server/services/analytics_store.py).
//
// Signed-out visitors are tracked too, under `anonId` alone. The server
// attributes a batch to an account only when the session cookie happens to be
// on the request, and stamps plan/account type itself — this file never sends
// them, because a client-asserted plan would be worthless.

import { API_BASE } from "./constants";

/** The curated vocabulary. Mirrors ACTION_NAMES in analytics_store.py — an
 *  event the server doesn't know is dropped on arrival, so the two lists have
 *  to be changed together. */
export type TrackedAction =
	| "upload_files_selected"
	| "upload_start_inference"
	| "upload_cancel_inference"
	| "upload_select_model"
	| "upload_select_postprocessing"
	| "upload_open_batch_details"
	| "viewer_open_case"
	| "viewer_change_layout"
	| "viewer_toggle_organ"
	| "viewer_measure"
	| "report_open"
	| "assistant_open"
	| "assistant_send_message"
	| "dataset_search"
	| "dataset_open_compare"
	| "account_open_settings"
	| "account_change_plan"
	| "account_set_account_type"
	| "auth_open_modal"
	| "auth_sign_in"
	| "auth_sign_up"
	| "auth_sign_out"
	| "auth_forgot_password_request"
	| "auth_reset_password"
	| "plan_limit_hit"
	| "plan_limit_dialog_cta"
	| "admin_grant_role"
	| "admin_revoke_role"
	| "admin_delete_account"
	| "admin_restore_account";

type TrackedEvent = {
	// Generated here, not on the server, and used as the row's primary key. A
	// keepalive flush that the browser retries resends the same body, so the ids
	// come back identical and the server can drop the second copy.
	id: string;
	kind: "action" | "page_view";
	name: string;
	route: string | null;
	duration_ms?: number;
	ts: number;
	anon_id: string;
	session_id: string;
};

// Static routes, and the prefixes that stand in for a parameterised one. The
// pattern is what gets sent: "/case/:caseId", never "/case/BDMAP_00000123".
const STATIC_ROUTES = new Set([
	"/", "/dashboard", "/dicom", "/local-nifti", "/upload", "/signup",
	"/reset-password",
	"/account", "/account/plan", "/account/history", "/account/privacy",
	"/account/analytics", "/account/people",
	"/terms", "/privacy", "/team", "/contact", "/compare", "/compare-viewer",
]);

const PARAM_ROUTES: Record<string, string> = {
	case: "/case/:caseId",
	session: "/session/:sessionId",
	reconstruction: "/reconstruction/:reconstructionId",
};

/** A pathname reduced to the pattern it matched, or null if we don't know it.
 *  Unknown routes are dropped rather than guessed at — a route we can't name is
 *  a route whose URL might carry something we shouldn't be storing. */
export const routePattern = (pathname: string): string | null => {
	const path = pathname.replace(/\/+$/, "") || "/";
	if (STATIC_ROUTES.has(path)) return path;
	const head = path.split("/")[1] ?? "";
	return PARAM_ROUTES[head] ?? null;
};

const ANON_KEY = "bmAnalyticsAnon";
const SESSION_KEY = "bmAnalyticsSession";

const randomId = (): string => {
	try {
		return crypto.randomUUID();
	} catch {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
};

/** Stable per-browser id. Storage being unavailable (private mode, blocked
 *  cookies) isn't an error — the visit is just counted as its own. */
const readStored = (storage: "local" | "session", key: string): string => {
	try {
		const store = storage === "local" ? localStorage : sessionStorage;
		const existing = store.getItem(key);
		if (existing) return existing;
		const fresh = randomId();
		store.setItem(key, fresh);
		return fresh;
	} catch {
		return randomId();
	}
};

let anonId: string | null = null;
let sessionId: string | null = null;

const ids = () => {
	if (!anonId) anonId = readStored("local", ANON_KEY);
	if (!sessionId) sessionId = readStored("session", SESSION_KEY);
	return { anon_id: anonId, session_id: sessionId };
};

// ---- the queue -------------------------------------------------------------
//
// Events are batched rather than sent one per click: a viewer session produces
// a lot of small interactions, and one request per interaction would put
// analytics traffic in the same order of magnitude as the app's real traffic.

const FLUSH_AFTER_MS = 10_000;
const FLUSH_AT = 20;

let queue: TrackedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const send = (events: TrackedEvent[], keepalive: boolean) => {
	if (!events.length) return;
	// keepalive lets the request outlive the page on a pagehide flush. fetch
	// rather than sendBeacon because the beacon can't carry credentials
	// cross-origin, which is exactly the dev setup (5173 -> 5001).
	fetch(`${API_BASE}/api/analytics/collect`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ events }),
		keepalive,
	}).catch(() => {
		// Analytics must never surface in the app it measures. A dropped batch
		// is a missing bar on a chart, and that's the end of it.
	});
};

export const flush = (keepalive = false) => {
	if (timer) {
		clearTimeout(timer);
		timer = null;
	}
	const batch = queue;
	queue = [];
	send(batch, keepalive);
};

const enqueue = (event: TrackedEvent) => {
	queue.push(event);
	if (queue.length >= FLUSH_AT) {
		flush();
		return;
	}
	if (!timer) timer = setTimeout(() => flush(), FLUSH_AFTER_MS);
};

const currentRoute = (): string | null => {
	if (typeof window === "undefined") return null;
	return routePattern(window.location.pathname);
};

/** Record that a feature was used. Fire-and-forget: never awaited, never throws. */
export const track = (name: TrackedAction) => {
	if (typeof window === "undefined") return;
	try {
		enqueue({
			id: randomId(),
			kind: "action",
			name,
			route: currentRoute(),
			ts: Date.now(),
			...ids(),
		});
	} catch {
		/* never let tracking break a click handler */
	}
};

/** Record a completed visit to a route, with how long it lasted. */
export const trackPageView = (route: string, durationMs: number) => {
	if (typeof window === "undefined") return;
	try {
		enqueue({
			id: randomId(),
			kind: "page_view",
			name: route,
			route,
			duration_ms: Math.max(0, Math.round(durationMs)),
			ts: Date.now(),
			...ids(),
		});
	} catch {
		/* as above */
	}
};
