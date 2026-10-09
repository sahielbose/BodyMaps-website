// Real authentication against the Flask backend (B1 email/password + B2 OAuth).
//
// The session lives in an httponly cookie the JS can't read, so on mount we ask
// GET /api/auth/me to restore it; sign in/up/out hit the auth endpoints. Every
// request uses credentials:"include" so the cookie is sent (also cross-origin in
// dev). This is the single seam the whole account UI reads through.
//
// OAuth is a full-page redirect, not a fetch: the browser goes to
// /api/auth/oauth/<provider>, the backend bounces it to the provider and back,
// sets the same session cookie, and returns us to the app — where the mount-time
// /me call picks the session up. `oauthProviders` reports which buttons to
// enable (a provider without server-side credentials stays disabled).
//
// The account controls (rename, export, delete history, delete account) all go
// to real endpoints — see api/auth_blueprint.py. Deleting the account is
// reversible for a grace period: the server keeps the row and signing back in
// cancels it.
//
// The plan is real too: user_account.plan, changed through /me/plan, and its
// limits are enforced server-side (see flask-server/services/plan_store.py).
// There is no payment step — pricing hasn't been set — but the limits bite.
//
// Account type is real too: user_account.account_type, set through PATCH
// /auth/me. It still gates nothing — it exists so activity can be grouped by it
// — but it is no longer a localStorage value the server has never seen.
//
// Not wired yet: emailNotifications -> B3, still a client-only localStorage pref.
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import {
	type AccountProfile,
	type AccountType,
	type PlanId,
} from "../helpers/accountProfile";
import { track } from "../helpers/analytics";
import { adoptLegacyRunsUntilChecked } from "../helpers/adoptLegacyRuns";
import { API_BASE } from "../helpers/constants";

export type AuthUser = {
	id: string;
	email: string;
	/** The name the user set, or one derived from their email if they haven't. */
	name: string;
	/** True when `name` is the user's own rather than derived from the email. */
	hasCustomName: boolean;
	emailNotifications: boolean; // client-only preference until B3
	/** Whether the account's email address has been verified. */
	emailVerified: boolean;
	/** Billing plan, from user_account.plan. Its limits are enforced server-side. */
	plan: PlanId;
	/** Self-reported account type, from user_account.account_type. Gates nothing. */
	profile: AccountProfile;
	/** Roles held, from the user_role table ("admin" is the only one). The server
	 *  enforces them; these only decide what the UI offers to draw. */
	roles: string[];
};

/** What GET /me/usage returns: the plan's limits and what's been used of them. */
export type PlanUsage = {
	plan: PlanId;
	scans: { used: number; limit: number | null; in_flight: number; resets_at: string | null };
	ai_messages: { used: number; limit: number | null; resets_at: string | null };
};

export type AuthProvider2 = "google" | "github";
// "forgot" is the same card again, asking only for an email. It isn't reachable
// from the header — you get there from the sign-in form, having failed at it.
export type AuthMode = "signin" | "signup" | "forgot";

type AuthContextValue = {
	user: AuthUser | null;
	isAuthenticated: boolean;
	/** True until the initial /me check resolves (avoids a signed-out flash). */
	loading: boolean;
	signIn: (email: string, password: string) => Promise<AuthUser>;
	/** `name` is optional and is stored server-side on user_account.name. */
	signUp: (email: string, password: string, name?: string) => Promise<AuthUser>;
	/** Full-page redirect into the provider's consent screen. Never returns. */
	signInWithProvider: (provider: AuthProvider2) => void;
	/**
	 * Ask for a reset link. Resolves whether or not an account exists — the
	 * server answers the same way either way, so that nobody can use this to
	 * discover which addresses are registered. The UI has to say "if an account
	 * exists" rather than "sent", because it genuinely doesn't know.
	 */
	requestPasswordReset: (email: string) => Promise<void>;
	/** Redeem a reset token. On success the user is signed in. */
	resetPassword: (token: string, password: string) => Promise<AuthUser>;
	/** (Re)send the verification link for the signed-in account. `sent` is the
	 *  truth from the server — false means SMTP is off and the link only went
	 *  to the server log. */
	sendVerification: () => Promise<{ sent: boolean; alreadyVerified: boolean }>;
	/** Redeem an emailed verification token. Public: works signed out too. */
	verifyEmail: (token: string) => Promise<void>;
	/** Which providers the server has credentials for (null until loaded). */
	oauthProviders: Record<AuthProvider2, boolean> | null;
	signOut: () => Promise<void>;
	updatePreferences: (patch: Partial<Pick<AuthUser, "emailNotifications">>) => void;
	/** Set the display name. An empty string clears it back to the email default. */
	updateName: (name: string) => Promise<void>;
	/** Download everything the server holds for this account as a JSON file. */
	exportData: () => Promise<void>;
	/** Delete every scan and result, keeping the account. Returns how many went. */
	deleteScanHistory: () => Promise<number>;
	/**
	 * Schedule the account for deletion and sign out. Reversible by signing back
	 * in — resolves with the deadline and the grace period, so the UI can say so.
	 */
	deleteAccount: () => Promise<{ restoreBy: string; graceDays: number }>;
	/** Patch the self-reported account type. Persisted server-side. */
	updateAccountProfile: (patch: Partial<AccountProfile>) => Promise<void>;
	/** Move to another plan. No payment step — pricing isn't set. */
	setPlan: (plan: PlanId) => Promise<void>;
	/** Redeem a server-configured access coupon for sponsored model access. */
	redeemAdminCoupon: (coupon: string) => Promise<AuthUser>;
	/** Current plan usage, or null until loaded. Refreshed by refreshUsage(). */
	usage: PlanUsage | null;
	/** The last usage read failed. `usage` keeps the last good figures, if any. */
	usageFailed: boolean;
	refreshUsage: () => Promise<void>;
	// Global auth popup, opened from the header or any gated action. Signing up
	// and signing in are the same card with a different title, the way both
	// Claude and ChatGPT do it — `mode` picks which.
	authPrompt: { open: boolean; mode: AuthMode };
	/** Defaults to sign-in: most people reaching a gate already have an account. */
	promptAuth: (mode?: AuthMode) => void;
	closeAuthPrompt: () => void;
	/** Error surfaced by the OAuth callback redirect (?auth_error=...), if any. */
	oauthError: string | null;
	clearOauthError: () => void;
};

// Cross-tab sync: writing this key on any auth change nudges other tabs to
// re-check /me (we can't watch the httponly cookie directly).
const AUTH_PING_KEY = "authChangePing";

const nameFromEmail = (email: string): string => {
	const local = email.split("@")[0] || email;
	return (
		local
			.split(/[._-]+/)
			.filter(Boolean)
			.map((p) => p.charAt(0).toUpperCase() + p.slice(1))
			.join(" ") || email
	);
};

// Email-notification preference is client-only until the backend supports it.
const prefKey = (id: string) => `emailNotif:${id}`;
const loadPref = (id: string): boolean => {
	try {
		const v = localStorage.getItem(prefKey(id));
		return v === null ? true : v === "1";
	} catch {
		return true;
	}
};
const savePref = (id: string, on: boolean) => {
	try {
		localStorage.setItem(prefKey(id), on ? "1" : "0");
	} catch {
		/* ignore */
	}
};

type ApiUser = {
	id: string;
	email: string;
	name?: string | null;
	plan?: string | null;
	account_type?: string | null;
	organization?: string | null;
	occupation?: string | null;
	role_description?: string | null;
	email_verified?: boolean;
	roles?: string[] | null;
};
const mapApiUser = (u: ApiUser): AuthUser => {
	const custom = (u.name || "").trim();
	return {
		id: u.id,
		email: u.email,
		// Accounts predating the name column have none — fall back to the email.
		name: custom || nameFromEmail(u.email),
		hasCustomName: custom.length > 0,
		emailNotifications: loadPref(u.id),
		emailVerified: u.email_verified === true,
		plan: (u.plan as PlanId) || "free",
		profile: {
			accountType: (u.account_type as AccountType) || null,
			organization: u.organization || null,
			occupation: u.occupation || null,
			roleDescription: u.role_description || null,
		},
		// Defaulted, never invented: an endpoint that forgets to send roles
		// leaves you with none, which fails closed.
		roles: u.roles ?? [],
	};
};

// fetch() rejects with the browser's own wording ("Failed to fetch" in Chrome,
// "Load failed" in Safari) when the request never reached the server, and the
// sign-in popup and Settings show an error's message as it is. Say what
// actually happened instead; HTTP errors keep the server's message.
class UnreachableError extends Error {}

/** The message for a failed account request. A lapsed session says so in plain words instead of the server's text. */
const failureMessage = (res: Response, data: { error?: string }, fallback: string) =>
	res.status === 401 ? "Your session has ended. Sign in again." : data.error || fallback;

const authFetch = async (path: string, init?: RequestInit) => {
	try {
		return await fetch(`${API_BASE}${path}`, {
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			...init,
		});
	} catch (err) {
		if (err instanceof TypeError) {
			throw new UnreachableError("Can't reach the server. Check your connection and try again.");
		}
		throw err;
	}
};

/** An error from a request the server answered, with the status it answered with. */
export class AuthRequestError extends Error {
	status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

// A page's URL fragment can be a secret (a live room's key). The fragment never
// goes to the server, so it isn't sent as part of ?next=; it waits in
// sessionStorage for the trip to the provider and is put back on return. It is
// matched on the pathname alone: the query can come back re-encoded.
const OAUTH_HASH_KEY = "oauthReturnHash";
const OAUTH_HASH_TTL_MS = 10 * 60 * 1000;

const stashOauthHash = (path: string, hash: string) => {
	try {
		if (hash) sessionStorage.setItem(OAUTH_HASH_KEY, JSON.stringify({ path, hash, at: Date.now() }));
		else sessionStorage.removeItem(OAUTH_HASH_KEY);
	} catch {
		/* private window or blocked storage: the page comes back without its fragment */
	}
};

/** Puts the stashed fragment back on the address bar when we are on the page it was stashed for. */
const restoreOauthHash = (path: string) => {
	try {
		const raw = sessionStorage.getItem(OAUTH_HASH_KEY);
		if (!raw) return;
		sessionStorage.removeItem(OAUTH_HASH_KEY);
		const saved = JSON.parse(raw) as { path?: unknown; hash?: unknown; at?: unknown };
		if (
			saved.path !== path ||
			typeof saved.hash !== "string" || !saved.hash.startsWith("#") ||
			typeof saved.at !== "number" || Date.now() - saved.at > OAUTH_HASH_TTL_MS ||
			window.location.hash
		) return;
		window.history.replaceState(window.history.state, "", path + saved.hash);
	} catch {
		/* nothing to restore */
	}
};

// The sentences the OAuth callback redirects back with (see oauth_blueprint.py
// and OAuthLinkRefusedError in auth_store.py). The error comes in on the URL,
// which anyone can write, so only these are shown; anything else reads as the
// generic failure.
const OAUTH_ERROR_FALLBACK = "Sign-in failed. Try again.";
const OAUTH_ERRORS = new Set([
	"Sign-in was cancelled or failed. Please try again.",
	"Couldn't read your profile from the provider.",
	"Could not complete sign-in. Please try again.",
	"That email can't be used for sign-in.",
	"That account was deleted and can no longer be restored.",
	"An account with that email already exists. Sign in with your password first, then link this provider.",
	"Your provider didn't share an email address, which we need to create an account.",
	"Google sign in isn't available on this site.",
	"GitHub sign in isn't available on this site.",
]);

// Waits before asking /me again after an answer that says nothing about the
// session: no reply at all, a 5xx, or the rate limit.
const ME_RETRY_DELAYS_MS = [400, 1200];

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [loading, setLoading] = useState(true);
	const [authPrompt, setAuthPrompt] = useState<{ open: boolean; mode: AuthMode }>({
		open: false, mode: "signin",
	});
	const [oauthProviders, setOauthProviders] = useState<Record<AuthProvider2, boolean> | null>(null);
	const [usage, setUsage] = useState<PlanUsage | null>(null);
	const [usageFailed, setUsageFailed] = useState(false);
	// Whose figures `usage` holds, so a failed read after a switch of account
	// can't leave the previous account's usage on screen.
	const usageOwner = useRef<string | null>(null);
	// Bumped by every refreshUsage, so a read that comes back after a newer one
	// began (sign-out, another account, a plan change) is dropped.
	const usageRequest = useRef(0);
	// Bumped when the signed-in account goes away or another one takes over
	// (sign-out, delete, sign-in, reset). An account write reads it before its
	// request and drops its answer if it moved, so a save still in flight when
	// someone signs out can't sign them back in on screen or open the popup.
	const authEpoch = useRef(0);
	// The OAuth callback redirects back with ?auth_error=... on failure (e.g. an
	// unverified provider email colliding with an existing account). Read it once
	// on mount, then strip it from the URL so a refresh doesn't resurface it.
	const [oauthError, setOauthError] = useState<string | null>(() => {
		try {
			const params = new URLSearchParams(window.location.search);
			const err = params.get("auth_error");
			if (err !== null) {
				params.delete("auth_error");
				const qs = params.toString();
				window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
			}
			restoreOauthHash(window.location.pathname);
			return err ? (OAUTH_ERRORS.has(err) ? err : OAUTH_ERROR_FALLBACK) : null;
		} catch {
			return null;
		}
	});

	const refreshMe = useCallback(async () => {
		try {
			for (let attempt = 0; ; attempt++) {
				try {
					const res = await authFetch("/api/auth/me");
					if (res.ok) {
						const { user: u } = await res.json();
						setUser(u ? mapApiUser(u) : null);
						return;
					}
					// A 401 is the server saying there is no session. A 5xx or the
					// rate limit says nothing about it.
					if (res.status !== 429 && !(res.status >= 500)) {
						setUser(null);
						return;
					}
				} catch (err) {
					if (!(err instanceof UnreachableError)) {
						setUser(null);
						return;
					}
				}
				// Not answered: ask again shortly, and if it still isn't, keep whoever
				// was signed in rather than showing a good session as signed out.
				// A cold load has no one to keep: after the last try it settles signed
				// out, so an outage longer than the retries still reads as signed out
				// to a page that decides on first load (Settings).
				if (attempt >= ME_RETRY_DELAYS_MS.length) return;
				await new Promise((r) => setTimeout(r, ME_RETRY_DELAYS_MS[attempt]));
			}
		} finally {
			setLoading(false);
		}
	}, []);

	// Restore the session from the cookie on mount.
	useEffect(() => {
		refreshMe();
	}, [refreshMe]);

	// Runs this browser saved before entries carried an owner belong to whoever
	// the server says they are. Every page that reads the list (History, the
	// viewer, Delete scan history, the Upload page) sits under this provider,
	// so the adoption is done here when sign-in settles rather than by
	// whichever page happens to be opened first. A check the server could not
	// answer is asked again (later, and when the window gets focus).
	const signedInId = loading ? null : (user?.id ?? null);
	useEffect(() => {
		if (!signedInId) return;
		const controller = new AbortController();
		void adoptLegacyRunsUntilChecked(signedInId, controller.signal);
		return () => controller.abort();
	}, [signedInId]);

	// Which OAuth buttons to enable. Only an answer from the server switches a
	// button off. A server that was busy or not reached says nothing about the
	// providers, so the list stays unknown (both buttons usable) rather than
	// greying them out for the rest of the session. While it is still unknown
	// the check is asked again each time the popup opens, so a blip heals before
	// a click can land on a provider the site does not have; and if it is still
	// unknown at the click, the server sends that click back with a message.
	const providersUnknown = oauthProviders === null;
	const providersAsked = useRef(false);
	useEffect(() => {
		if (!providersUnknown) return;
		if (providersAsked.current && !authPrompt.open) return;
		providersAsked.current = true;
		let cancelled = false;
		let answered = false;
		authFetch("/api/auth/oauth/providers")
			.then((r) => (r.ok ? r.json() : null))
			.then((p) => {
				if (p && !cancelled) setOauthProviders({ google: !!p.google, github: !!p.github });
			})
			.catch(() => {})
			.finally(() => {
				answered = true;
			});
		return () => {
			cancelled = true;
			// A run torn down before its answer came (StrictMode's doubled
			// mount, or the popup opening mid-request) threw that answer away,
			// so it has not asked yet.
			if (!answered) providersAsked.current = false;
		};
	}, [providersUnknown, authPrompt.open]);

	// If we came back from a failed OAuth attempt, show the popup with the error.
	// Sign-in mode: the failure message tells them what to do, and the signup
	// side's terms fine print would be noise on top of an error.
	useEffect(() => {
		if (oauthError) setAuthPrompt({ open: true, mode: "signin" });
	}, [oauthError]);

	// Cross-tab: another tab signed in/out -> re-check.
	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key === AUTH_PING_KEY) refreshMe();
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, [refreshMe]);

	const pingOtherTabs = () => {
		try {
			localStorage.setItem(AUTH_PING_KEY, String(Date.now()));
		} catch {
			/* ignore */
		}
	};

	const authAction = useCallback(
		async (path: string, email: string, password: string, name?: string) => {
			const body: Record<string, string> = { email, password };
			if (name?.trim()) body.name = name.trim();
			const res = await authFetch(path, { method: "POST", body: JSON.stringify(body) });
			const data = await res.json().catch(() => ({}));
			// The status rides along so the popup can mark only the field at fault.
			if (!res.ok) throw new AuthRequestError(data.error || "Something went wrong. Try again.", res.status);
			const mapped = mapApiUser(data.user);
			authEpoch.current++;
			setUser(mapped);
			pingOtherTabs();
			return mapped;
		},
		[]
	);

	// A 401 on a save means the session lapsed while the page still shows the
	// account: say so and open the sign-in popup rather than echoing the server.
	// A write that began before a sign-out passes its epoch: its 401 is the
	// sign-out landing first, so the popup stays shut.
	const accountFailure = useCallback((res: Response, data: { error?: string }, fallback: string, epoch?: number) => {
		if (res.status === 401 && (epoch === undefined || epoch === authEpoch.current)) {
			track("auth_open_modal");
			setAuthPrompt({ open: true, mode: "signin" });
		}
		return new Error(failureMessage(res, data, fallback));
	}, []);

	const sendVerification = useCallback(async () => {
		const res = await authFetch("/api/auth/send-verification", { method: "POST" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't send the link. Try again.");
		// The link may have been opened where no other tab could be told, so
		// read the account again rather than leave the Profile row stale.
		if (data.already_verified === true) await refreshMe();
		return { sent: data.sent === true, alreadyVerified: data.already_verified === true };
	}, [accountFailure, refreshMe]);

	const verifyEmail = useCallback(async (token: string) => {
		const res = await authFetch("/api/auth/verify-email", {
			method: "POST",
			body: JSON.stringify({ token }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) {
			// Only a 400 says the token was refused. A rate limit or a 5xx says
			// nothing about it, and the page offers another try.
			throw new AuthRequestError(
				res.status === 400
					? data.error || "This link has expired or has already been used."
					: res.status === 429
						? data.error || "Too many attempts. Wait a moment, then try again."
						: "Couldn't verify your email right now. Try again.",
				res.status
			);
		}
		// If this browser is signed in as the account that just verified,
		// reflect it immediately — the tier check reads it.
		setUser((current) =>
			current && data.user && current.id === data.user.id ? mapApiUser(data.user) : current
		);
		// The link usually opens in a new tab: the others re-check who is signed in.
		pingOtherTabs();
	}, []);

	const signIn = useCallback(
		(email: string, password: string) => authAction("/api/auth/login", email, password),
		[authAction]
	);
	// The name goes to the server with the registration — /auth/register takes it,
	// so a signup name lands in user_account.name rather than in local storage.
	const signUp = useCallback(
		(email: string, password: string, name?: string) =>
			authAction("/api/auth/register", email, password, name),
		[authAction]
	);

	const requestPasswordReset = useCallback(async (email: string) => {
		const res = await authFetch("/api/auth/forgot-password", {
			method: "POST",
			body: JSON.stringify({ email }),
		});
		// 200 whether or not the address has an account. The only failure worth
		// surfacing is the rate limit, which is a thing the user can act on.
		if (!res.ok) {
			const data = await res.json().catch(() => ({}));
			throw new Error(data.error || "Couldn't send the link. Try again.");
		}
	}, []);

	const resetPassword = useCallback(
		async (token: string, password: string) => {
			const res = await authFetch("/api/auth/reset-password", {
				method: "POST",
				body: JSON.stringify({ token, password }),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				throw new AuthRequestError(data.error || "Couldn't reset your password.", res.status);
			}
			const mapped = mapApiUser(data.user);
			authEpoch.current++;
			setUser(mapped);
			pingOtherTabs();
			return mapped;
		},
		[]
	);

	// OAuth can't be a fetch: the provider's consent screen has to be a top-level
	// navigation (and the backend needs to set the cookie on the way back), so we
	// hand the whole browser over. On return, the mount-time /me call restores
	// the session.
	const signInWithProvider = useCallback((provider: AuthProvider2) => {
		// Hand the backend the page we're leaving so its callback can send us
		// back here instead of to the app root. Same-origin relative path only;
		// the backend re-validates it before redirecting.
		// No fragment in it: see stashOauthHash.
		// The one-time link pages are the exception: their token is spent on
		// load, so coming back to the same URL would only report it as used (and
		// would park it in the server session). Those return to the app root.
		const oneTime = /\/(verify-email|reset-password)\/?$/.test(window.location.pathname);
		const next = oneTime ? "" : window.location.pathname + window.location.search;
		if (!oneTime) stashOauthHash(window.location.pathname, window.location.hash);
		const qs = next && next !== "/" ? `?next=${encodeURIComponent(next)}` : "";
		window.location.href = `${API_BASE}/api/auth/oauth/${provider}${qs}`;
	}, []);

	const signOut = useCallback(async () => {
		track("auth_sign_out");
		// Clear locally first so the UI updates instantly, then revoke server-side.
		authEpoch.current++;
		setUser(null);
		try {
			await authFetch("/api/auth/logout", { method: "POST" });
		} catch {
			/* ignore — already cleared locally */
		} finally {
			// Tell the other tabs only once the revoke has settled, so one of
			// them re-checking /me cannot reach the server first and keep its
			// signed-in UI over a session that is about to be revoked.
			pingOtherTabs();
		}
	}, []);

	const promptAuth = useCallback((mode: AuthMode = "signin") => {
		track("auth_open_modal");
		setAuthPrompt({ open: true, mode });
	}, []);
	const closeAuthPrompt = useCallback(
		() => setAuthPrompt((p) => ({ ...p, open: false })),
		[]
	);

	// Auto-close the popup once a user is established.
	useEffect(() => {
		if (user) setAuthPrompt((p) => (p.open ? { ...p, open: false } : p));
	}, [user]);

	const updatePreferences = useCallback(
		(patch: Partial<Pick<AuthUser, "emailNotifications">>) => {
			setUser((prev) => {
				if (!prev) return prev;
				const next = { ...prev, ...patch };
				if (typeof next.emailNotifications === "boolean") savePref(next.id, next.emailNotifications);
				return next;
			});
		},
		[]
	);

	const updateName = useCallback(async (name: string) => {
		const epoch = authEpoch.current;
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify({ name }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't save your name. Try again.", epoch);
		if (epoch !== authEpoch.current) return;
		setUser(mapApiUser(data.user));
	}, [accountFailure]);

	// Streams straight from the server so the file is the real record, not a
	// reconstruction from whatever this browser happens to have cached.
	const exportData = useCallback(async () => {
		const res = await authFetch("/api/me/export");
		if (!res.ok) throw accountFailure(res, {}, "Couldn't prepare your data. Try again.");
		const blob = await res.blob();
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "bodymaps-export.json";
		a.click();
		URL.revokeObjectURL(url);
	}, [accountFailure]);

	const deleteScanHistory = useCallback(async () => {
		const res = await authFetch("/api/me/jobs", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't delete your history. Try again.");
		// Queue jobs and Upload page runs are kept apart on the server.
		return Number(data.deleted?.jobs ?? 0) + Number(data.deleted?.runs ?? 0);
	}, [accountFailure]);

	const deleteAccount = useCallback(async () => {
		const res = await authFetch("/api/me", { method: "DELETE" });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't delete your account. Try again.");
		// The server has already revoked every session and cleared the cookie.
		authEpoch.current++;
		setUser(null);
		pingOtherTabs();
		return { restoreBy: data.restore_by as string, graceDays: Number(data.grace_days) };
	}, [accountFailure]);

	const updateAccountProfile = useCallback(async (patch: Partial<AccountProfile>) => {
		// "" clears a field: the server reads an empty string as "not provided".
		const body: Record<string, string> = {};
		if ("accountType" in patch) body.account_type = patch.accountType ?? "";
		if ("organization" in patch) body.organization = patch.organization ?? "";
		if ("occupation" in patch) body.occupation = patch.occupation ?? "";
		if ("roleDescription" in patch) body.role_description = patch.roleDescription ?? "";
		if (Object.keys(body).length === 0) return;
		const epoch = authEpoch.current;
		const res = await authFetch("/api/auth/me", {
			method: "PATCH",
			body: JSON.stringify(body),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't save your profile. Try again.", epoch);
		if (epoch !== authEpoch.current) return;
		setUser(mapApiUser(data.user));
	}, [accountFailure]);

	const refreshUsage = useCallback(async () => {
		const request = ++usageRequest.current;
		if (!user) {
			usageOwner.current = null;
			setUsage(null);
			setUsageFailed(false);
			return;
		}
		// A failed read keeps what is already shown (a plan change whose re-read
		// fails shouldn't blank the bars) and is reported as failed, so the Plan
		// page can offer a retry rather than saying "Loading…" for good.
		try {
			const res = await authFetch("/api/me/usage");
			if (!res.ok) throw new Error(`Usage request failed (${res.status})`);
			const data = (await res.json()) as PlanUsage;
			if (request !== usageRequest.current) return;
			usageOwner.current = user.id;
			setUsage(data);
			setUsageFailed(false);
		} catch {
			if (request !== usageRequest.current) return;
			if (usageOwner.current !== user.id) {
				usageOwner.current = null;
				setUsage(null);
			}
			setUsageFailed(true);
		}
	}, [user]);

	const setPlan = useCallback(async (plan: PlanId) => {
		const epoch = authEpoch.current;
		const res = await authFetch("/api/me/plan", {
			method: "POST",
			body: JSON.stringify({ plan }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw accountFailure(res, data, "Couldn't change your plan. Try again.", epoch);
		if (epoch !== authEpoch.current) return;
		setUser(mapApiUser(data.user));
	}, [accountFailure]);

	const redeemAdminCoupon = useCallback(async (coupon: string) => {
		const epoch = authEpoch.current;
		const res = await authFetch("/api/auth/redeem-admin-coupon", {
			method: "POST",
			body: JSON.stringify({ coupon }),
		});
		const data = await res.json().catch(() => ({}));
		// An unconfigured deployment answers 503 with a server string; say it plainly.
		if (res.status === 503) throw new Error("Access coupons aren't available on this site.");
		if (!res.ok) throw accountFailure(res, data, "Couldn't redeem that access coupon.", epoch);
		const mapped = mapApiUser(data.user);
		if (epoch === authEpoch.current) setUser(mapped);
		return mapped;
	}, [accountFailure]);

	// Keep usage in step with whoever is signed in — including after a plan
	// change, since the limits it reports come from the plan.
	useEffect(() => {
		refreshUsage();
	}, [refreshUsage]);

	const clearOauthError = useCallback(() => setOauthError(null), []);

	const value = useMemo<AuthContextValue>(
		() => ({
			user,
			isAuthenticated: user !== null,
			loading,
			signIn,
			signUp,
			signInWithProvider,
			requestPasswordReset,
			resetPassword,
			sendVerification,
			verifyEmail,
			oauthProviders,
			signOut,
			updatePreferences,
			updateName,
			exportData,
			deleteScanHistory,
			deleteAccount,
			 updateAccountProfile,
			 setPlan,
			 redeemAdminCoupon,
			 usage,
			usageFailed,
			refreshUsage,
			authPrompt,
			promptAuth,
			closeAuthPrompt,
			oauthError,
			clearOauthError,
		}),
		[user, loading, signIn, signUp, signInWithProvider, requestPasswordReset,
		 resetPassword, sendVerification, verifyEmail, oauthProviders, signOut,
		 updatePreferences, updateName, exportData, deleteScanHistory, deleteAccount,
		 updateAccountProfile, setPlan, redeemAdminCoupon, usage, usageFailed, refreshUsage, authPrompt, promptAuth,
		 closeAuthPrompt, oauthError, clearOauthError]
	);

	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
	return ctx;
}

/** Like useAuth, but null outside an AuthProvider: for a page that only needs to know who is looking. */
export function useAuthIfPresent(): AuthContextValue | null {
	return useContext(AuthContext);
}
