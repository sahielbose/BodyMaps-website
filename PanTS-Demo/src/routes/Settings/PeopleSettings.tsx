import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../../contexts/authContext";
import { API_BASE } from "../../helpers/constants";
import { track } from "../../helpers/analytics";
import { parseServerTime } from "../../helpers/resetTime";
import { useSettings } from "./context";
import { titleCase } from "./analytics/format";
import "./analytics/dashboard.css";
import MetaParts from "./MetaParts";

// People: every account, and the roles they hold.
//
// Admin-only, checked here as well as on the server — the settings nav hides the
// link for everyone else, but a hidden link is not access control.
//
// Admin is the only role there is. The vocabulary comes from the server
// (body.roles) rather than a list here, so the menu follows whatever the server
// is actually willing to grant.
//
// Every row's actions sit behind one Edit button, and every action behind a
// confirmation. The toggles this replaced were a single click from making a
// stranger an admin — which hands them every account's email address and the
// ability to demote the person who clicked. A control that dangerous should not
// be the same gesture as a checkbox, and it should have to say what it does.

type Person = {
	id: string;
	email: string;
	name: string | null;
	plan: string;
	account_type: string | null;
	created_at: string | null;
	/** Non-null once the account is scheduled for deletion. */
	deletion_requested_at: string | null;
	roles: string[];
};

/** What an Edit menu item does, once confirmed. */
type Action =
	| { kind: "role"; role: string; held: boolean }
	| { kind: "delete" }
	| { kind: "restore" };

const GRACE_DAYS = 30;

const joined = (iso: string | null) => {
	if (!iso) return "";
	const d = parseServerTime(iso);
	return Number.isNaN(d.getTime())
		? ""
		: d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** How long is left to change your mind about a deletion. */
const daysLeft = (iso: string | null): number | null => {
	if (!iso) return null;
	const requested = parseServerTime(iso).getTime();
	if (Number.isNaN(requested)) return null;
	const elapsed = (Date.now() - requested) / 86_400_000;
	return Math.max(0, Math.ceil(GRACE_DAYS - elapsed));
};

/** The confirmation text for each action. Written out per case rather than
 *  assembled from fragments: these are the sentences that have to stop someone,
 *  and a template that reads "Remove admin from ... including yours" would be
 *  worse than no warning at all. */
const explain = (person: Person, action: Action): { title: string; body: string } => {
	if (action.kind === "delete") {
		return {
			title: `Delete ${person.email}?`,
			body:
				"They'll be signed out everywhere and won't be able to sign in. The "
				+ `account, its scans and its results can be restored for ${GRACE_DAYS} days; `
				+ "after that they're deleted for good.",
		};
	}
	if (action.kind === "restore") {
		return {
			title: `Restore ${person.email}?`,
			body: "The account becomes usable again and they can sign in as before.",
		};
	}
	return action.held
		? {
			title: `Remove admin from ${person.email}?`,
			body: "They'll lose the usage dashboard and this page, can no longer "
				+ "grant or remove roles, and go back to their plan's limits.",
		}
		: {
			title: `Make ${person.email} an admin?`,
			body: "Admins can see every account's email address and usage data, can "
				+ "grant or remove roles (including yours), and are not held to any "
				+ "plan limit. Only do this for someone you'd trust with the whole "
				+ "site.",
		};
};

const PeopleSettings: React.FC = () => {
	const { user, promptAuth } = useAuth();
	const { run, notify } = useSettings();
	const isAdmin = !!user?.roles.includes("admin");

	const [query, setQuery] = useState("");
	const [people, setPeople] = useState<Person[]>([]);
	const [roles, setRoles] = useState<string[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// Why the list did not load, when retrying would not help: a lapsed session
	// is fixed by signing in, and a non-admin account by nothing the page can do.
	const [loadStopped, setLoadStopped] = useState<"signedOut" | "forbidden" | null>(null);
	// The row being changed, so only its controls go dead rather than the page.
	const [pending, setPending] = useState<string | null>(null);
	// Which row's Edit menu is open, and what it has been asked to do.
	const [menuFor, setMenuFor] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<{ person: Person; action: Action } | null>(null);
	// Delete is the one action that has to be typed out, because it's the one
	// aimed at somebody else's account rather than at a role.
	const [typed, setTyped] = useState("");

	// Only the newest search draws. A slower, older one landing after it would
	// show another query's accounts (or its error, or stop the spinner) under
	// the text now in the box, and the rows are what Edit and Delete act on.
	const requestSeq = useRef(0);
	const heading = useRef<HTMLHeadingElement>(null);

	const load = useCallback(async (q: string) => {
		const id = ++requestSeq.current;
		setLoading(true);
		setError(null);
		setLoadStopped(null);
		try {
			const params = new URLSearchParams();
			if (q.trim()) params.set("q", q.trim());
			const res = await fetch(`${API_BASE}/api/admin/people?${params}`, {
				credentials: "include",
			});
			if (res.status === 401 || res.status === 403) {
				if (id !== requestSeq.current) return;
				setLoadStopped(res.status === 401 ? "signedOut" : "forbidden");
				setError(res.status === 401 ? "Your session has ended." : "You need an admin account to see this.");
				setPeople([]);
				setTotal(0);
				return;
			}
			if (!res.ok) throw new Error(`Loading accounts failed (${res.status})`);
			const body = await res.json();
			if (id !== requestSeq.current) return;
			setPeople(body.people);
			setRoles(body.roles);
			setTotal(body.total);
		} catch (e) {
			if (id !== requestSeq.current) return;
			console.error(e);
			setError("Couldn't load accounts. Try again.");
			setPeople([]);
			setTotal(0);
		} finally {
			if (id === requestSeq.current) setLoading(false);
		}
	}, []);

	// Debounced so typing an email doesn't fire a request per keystroke.
	useEffect(() => {
		if (!isAdmin) return;
		const t = setTimeout(() => load(query), 250);
		return () => clearTimeout(t);
	}, [isAdmin, query, load]);

	// Signing in again from the session-ended banner swaps the user object but
	// not the admin flag or the search, so the effects above would not run.
	const lastUser = useRef(user);
	useEffect(() => {
		const changed = lastUser.current !== user;
		lastUser.current = user;
		if (changed && loadStopped === "signedOut" && isAdmin) load(query);
	}, [user, loadStopped, isAdmin, query, load]);

	// Each row's Edit button, and the row whose menu or confirmation just
	// closed. The control that had focus went with it, so focus goes back to
	// that row's Edit button (once it is enabled again after a change), unless
	// the person has already moved it somewhere else on the page.
	const editButtons = useRef(new Map<string, HTMLButtonElement>());
	const refocusRow = useRef<string | null>(null);
	useEffect(() => {
		if (menuFor || confirming || pending || !refocusRow.current) return;
		const now = document.activeElement;
		if (!now || now === document.body) editButtons.current.get(refocusRow.current)?.focus();
		refocusRow.current = null;
	}, [menuFor, confirming, pending]);

	// A search can hide the row a menu or confirmation belongs to. Its panel
	// unmounts, but the state would stay, and clearing the search would bring
	// the panel back with the old typed email already in it, armed, and its
	// autofocused field would take focus from the search box mid-edit. So both
	// go once the list no longer holds their row.
	useEffect(() => {
		if (confirming && !people.some((p) => p.id === confirming.person.id)) {
			setConfirming(null);
			setTyped("");
		}
		if (menuFor && !people.some((p) => p.id === menuFor)) setMenuFor(null);
	}, [people, confirming, menuFor]);

	const closeConfirm = () => {
		refocusRow.current = confirming?.person.id ?? null;
		setConfirming(null);
		setTyped("");
	};

	// Esc closes whichever of the two is open, innermost first.
	useEffect(() => {
		if (!menuFor && !confirming) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			refocusRow.current = confirming?.person.id ?? menuFor;
			if (confirming) { setConfirming(null); setTyped(""); }
			else setMenuFor(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [menuFor, confirming]);

	const start = (person: Person, action: Action) => {
		setMenuFor(null);
		setConfirming({ person, action });
		setTyped("");
	};

	// Through the shell's run(), like every other settings action: it clears the
	// banners when the action starts (so an old refusal doesn't sit beside a
	// later success), queues behind anything in flight, and reports a failure.
	const apply = () => {
		if (!confirming) return;
		const { person, action } = confirming;
		setPending(person.id);
		run(async () => {
			try {
				let res: Response;
				try {
					res = await fetch(requestUrl(person, action), {
						method: requestMethod(action),
						credentials: "include",
						headers: requestBody(action) ? { "Content-Type": "application/json" } : undefined,
						body: requestBody(action),
					});
				} catch (e) {
					console.error(e);
					throw new Error("That didn't work. Try again.");
				}
				const body = await res.json().catch(() => ({}));
				if (res.status === 401) {
					// The session lapsed under an open page: say so and open sign-in,
					// as the other account saves do, rather than echo the server.
					promptAuth();
					throw new Error("Your session has ended. Sign in again.");
				}
				if (!res.ok) throw new Error(body.error || "That didn't work.");

				setPeople((current) => current.map((p) => (p.id === person.id
					? applyToRow(p, action, body)
					: p)));
				closeConfirm();
				notify(outcome(person, action));
				// Spelled out rather than routed through a helper: the server drops
				// any name it doesn't know, and the test that keeps the two lists in
				// step (test_analytics_vocabulary.py) can only see literals.
				if (action.kind === "delete") track("admin_delete_account");
				else if (action.kind === "restore") track("admin_restore_account");
				else track(action.held ? "admin_revoke_role" : "admin_grant_role");
			} finally {
				setPending(null);
			}
		});
	};

	if (!isAdmin) {
		return (
			<div className="set-group">
				<div className="set-head">
					<h2 className="set-heading">People</h2>
					<p className="set-sub">You need an admin account to see this.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="dash">
			<div className="set-group">
				<div className="set-head">
					<h2 className="set-heading" ref={heading} tabIndex={-1}>People</h2>
					<p className="set-sub">
						Every account, and what it can do. Admins see usage, manage roles, and
						are not held to any plan limit.
					</p>
				</div>

				<input
					type="search"
					className="set-input dash-search"
					placeholder="Search by email or name"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					aria-label="Search accounts"
				/>
			</div>

			{error && (
				<div className="set-banner set-banner--error dash-banner" role="alert">
					{error}{" "}
					{loadStopped === "signedOut" ? (
						<button type="button" className="dash-retry" onClick={() => promptAuth()}>Sign in</button>
					) : loadStopped === null && (
						<button
							type="button"
							className="dash-retry"
							onClick={() => {
								// The retry clears this banner, button and all, so focus goes
								// to the heading rather than falling to the page. Not the
								// search box: on a phone that would raise the keyboard.
								heading.current?.focus();
								load(query);
							}}
						>
							Try again
						</button>
					)}
				</div>
			)}

			{loading && !people.length && <p className="dash-empty">Loading…</p>}

			{!loading && !people.length && !error && (
				<p className="dash-empty">
					{query ? `No account matches "${query}".` : "No accounts yet."}
				</p>
			)}

			{people.map((person) => {
				const isYou = person.id === user?.id;
				const left = daysLeft(person.deletion_requested_at);
				const menuOpen = menuFor === person.id;
				// The server refuses to let you remove a role from yourself or delete
				// your own account here, so neither is offered on your row.
				const roleActions = roles.filter((role) => !(isYou && person.roles.includes(role)));
				const restorable = !!person.deletion_requested_at;
				const deletable = !isYou && !restorable;
				const hasActions = roleActions.length > 0 || restorable || deletable;
				const ownNote = isYou && !restorable;
				const confirm = confirming?.person.id === person.id ? confirming : null;

				return (
					<div className="dash-person-block" key={person.id}>
						<div className={`set-row dash-person${confirm ? " set-row--open" : ""}`}>
							<span className="set-row-label">
								{person.email}
								{isYou && <span className="dash-you">you</span>}
								<span className="set-row-note">
									<MetaParts
										parts={[
											person.name && { text: person.name, wrap: true },
											{ text: titleCase(person.plan) },
											{ text: person.roles.length ? person.roles.map(titleCase).join(", ") : "No roles" },
											joined(person.created_at) && { text: `Joined ${joined(person.created_at)}` },
										]}
									/>
								</span>
								{ownNote && !hasActions && (
									<span className="set-row-note">To delete your own account, use Privacy.</span>
								)}
								{left !== null && (
									<span className="dash-scheduled">
										<MetaParts
											parts={[
												{ text: "Scheduled for deletion" },
												{ text: `${left} ${left === 1 ? "day" : "days"} left to restore` },
											]}
										/>
									</span>
								)}
							</span>
							{hasActions && (
								<button
									ref={(el) => {
										if (el) editButtons.current.set(person.id, el);
										else editButtons.current.delete(person.id);
									}}
									type="button"
									className="set-btn"
									// Without the email, every row's button is announced
									// identically — a screen reader hears "Edit" a dozen times
									// with no way to tell whose it is.
									aria-label={`Edit ${person.email}`}
									aria-expanded={menuOpen}
									disabled={pending === person.id}
									onClick={() => setMenuFor(menuOpen ? null : person.id)}
								>
									Edit
								</button>
							)}
						</div>

						{menuOpen && hasActions && (
							<div className="dash-menu" role="group" aria-label={`Actions for ${person.email}`}>
								{roleActions.map((role) => {
									const held = person.roles.includes(role);
									return (
										<button
											key={role}
											type="button"
											className="dash-menu-item"
											onClick={() => start(person, { kind: "role", role, held })}
										>
											{held ? `Remove ${role}` : `Make ${role}`}
										</button>
									);
								})}
								{roleActions.length > 0 && (restorable || deletable || ownNote) && (
									<div className="dash-menu-rule" />
								)}
								{restorable ? (
									<button
										type="button"
										className="dash-menu-item"
										onClick={() => start(person, { kind: "restore" })}
									>
										Restore account
									</button>
								) : isYou ? (
									// Your own account goes through Privacy.
									<span className="set-row-note" style={{ padding: "4px 10px" }}>
										To delete your own account, use Privacy.
									</span>
								) : (
									<button
										type="button"
										className="dash-menu-item dash-menu-item--danger"
										onClick={() => start(person, { kind: "delete" })}
									>
										Delete account
									</button>
								)}
							</div>
						)}

						{confirm && <ConfirmPanel
							person={confirm.person}
							action={confirm.action}
							typed={typed}
							setTyped={setTyped}
							busy={pending === person.id}
							onCancel={closeConfirm}
							onConfirm={apply}
						/>}
					</div>
				);
			})}

			{total > people.length && (
				<p className="dash-empty">
					Showing {people.length} of {total}. Search to narrow it down.
				</p>
			)}
		</div>
	);
};

/** `text` with each copy of the address in a span that keeps it whole. */
const withEmail = (text: string, email: string) =>
	text.split(email).flatMap((piece, i) => (i === 0 ? [piece] : [<span key={i} className="set-email">{email}</span>, piece]));

// ---- the confirmation ------------------------------------------------------

const ConfirmPanel: React.FC<{
	person: Person;
	action: Action;
	typed: string;
	setTyped: (v: string) => void;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}> = ({ person, action, typed, setTyped, busy, onCancel, onConfirm }) => {
	const { title, body } = explain(person, action);
	const needsTyping = action.kind === "delete";
	const armed = !needsTyping || typed.trim().toLowerCase() === person.email.toLowerCase();
	const danger = action.kind === "delete"
		|| (action.kind === "role" && action.role === "admin" && !action.held);

	// The menu item that opened this is gone by now, so focus comes here: the
	// typing field when there is one (autoFocus), otherwise the panel itself,
	// which announces what is being confirmed without landing on a button
	// that Enter would press.
	const panelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!needsTyping) panelRef.current?.focus();
	}, [needsTyping]);

	return (
		<div
			ref={panelRef}
			className="set-confirm dash-confirm"
			role="alertdialog"
			aria-label={title}
			tabIndex={-1}
		>
			<div className="set-confirm-text">
				<strong className="set-confirm-title">{withEmail(title, person.email)}</strong>
				<div className="set-confirm-body">{body}</div>
				{needsTyping && (
					<div className="set-confirm-prompt">
						Type <strong><span className="set-email">{person.email}</span></strong> to confirm.
					</div>
				)}
			</div>
			{/* A form so Enter confirms once the email is typed, as on Privacy. The
			    Confirm button is aria-disabled rather than disabled so it keeps
			    focus while busy or unarmed; the submit guard does the refusing. */}
			<form
				className="set-confirm-actions"
				onSubmit={(e) => {
					e.preventDefault();
					if (armed && !busy) onConfirm();
				}}
			>
				{needsTyping && (
					<input
						className="set-input"
						value={typed}
						autoFocus
						aria-label={`Type ${person.email} to confirm`}
						onChange={(e) => setTyped(e.target.value)}
					/>
				)}
				<button
					type="submit"
					className={`set-btn${danger ? " set-btn--danger" : ""}`}
					aria-disabled={busy || !armed || undefined}
				>
					{busy ? "Working…" : confirmLabel(action)}
				</button>
				<button type="button" className="set-btn" onClick={onCancel}>
					Cancel
				</button>
			</form>
		</div>
	);
};

// ---- what each action sends, and what it means -----------------------------

const requestUrl = (person: Person, action: Action) => {
	const base = `${API_BASE}/api/admin/people/${person.id}`;
	if (action.kind === "delete") return base;
	if (action.kind === "restore") return `${base}/restore`;
	return action.held ? `${base}/roles/${action.role}` : `${base}/roles`;
};

const requestMethod = (action: Action) => {
	if (action.kind === "delete") return "DELETE";
	if (action.kind === "restore") return "POST";
	return action.held ? "DELETE" : "POST";
};

const requestBody = (action: Action) =>
	action.kind === "role" && !action.held
		? JSON.stringify({ role: action.role })
		: undefined;

/** Fold the server's answer into the row. Role changes trust the server's list
 *  rather than assuming the change took — it refuses some revokes, and this is
 *  the row that has to show it. */
const applyToRow = (person: Person, action: Action, body: { roles?: string[] }): Person => {
	if (action.kind === "role") return { ...person, roles: body.roles ?? person.roles };
	return {
		...person,
		deletion_requested_at: action.kind === "delete" ? new Date().toISOString() : null,
	};
};

const confirmLabel = (action: Action) => {
	if (action.kind === "delete") return "Delete account";
	if (action.kind === "restore") return "Restore account";
	return action.held ? `Remove ${action.role}` : `Make ${action.role}`;
};

const outcome = (person: Person, action: Action) => {
	if (action.kind === "delete") {
		return `${person.email} is scheduled for deletion and has been signed out.`;
	}
	if (action.kind === "restore") return `${person.email} has been restored.`;
	return action.held
		? `Removed ${action.role} from ${person.email}.`
		: `${person.email} is now an ${action.role}.`;
};

export default PeopleSettings;
