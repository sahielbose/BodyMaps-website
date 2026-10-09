import React, { useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AuthRequestError, useAuth } from "../contexts/authContext";
import { track } from "../helpers/analytics";
import "../components/AuthModal.css";
import "./ResetPassword.css";

// Where the emailed reset link lands: /reset-password?token=…
//
// A page rather than a mode of the auth popup, because it is arrived at from
// outside the app entirely — a mail client, on a device that may never have
// loaded the site. There is nothing behind it to pop over.
//
// It borrows AuthModal's stylesheet rather than growing a second set of form
// styles; the card is the same card, standing on its own.
//
// The token is NOT checked on load. Doing so would mean an endpoint that
// reports whether a token is valid without redeeming it, which is a thing worth
// guessing at; and a link-preview fetch by the mail client would burn the token
// before the user ever clicked. It is checked when the form is submitted.

const MIN_LENGTH = 8;

// The token a tab has already redeemed. A reload, or the browser restoring the
// session, remounts this page with the same spent link; showing the form again
// would only end in "link can't be used" for a password that did change.
const REDEEMED_KEY = "resetToken";
const redeemed = (token: string) => {
	try {
		return !!token && sessionStorage.getItem(REDEEMED_KEY) === token;
	} catch {
		return false;
	}
};

const ResetPassword: React.FC = () => {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const { resetPassword, promptAuth, user, loading } = useAuth();
	const token = params.get("token") || "";

	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState("");
	// Which field the error is about, so only that one reads as invalid.
	const [invalid, setInvalid] = useState({ password: false, confirm: false });
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(() => redeemed(token));
	// The server refused the token itself: expired, or already used.
	const [linkDead, setLinkDead] = useState(false);
	const errorId = useId();
	const passwordRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLInputElement>(null);
	const deadHeadingRef = useRef<HTMLHeadingElement>(null);
	const doneHeadingRef = useRef<HTMLHeadingElement>(null);

	// A link with no token at all is a mangled paste, not an expired one, and
	// saying so is more useful than letting them type a password first.
	const missingToken = !token;

	// `done` also starts true on a remount with a spent token, when the session
	// may be long gone (signed out, then Back; or the cookie expired). Only a
	// person who actually has a session is told they are signed in.
	const signedIn = !!user;

	// The form, and the submit button that had focus, go away when the password
	// is changed or the link turns out to be dead; put focus on what replaced
	// them so it isn't dropped to the page. The changed screen stays until the
	// person moves on, since it says every other browser was signed out.
	useEffect(() => {
		if (done) doneHeadingRef.current?.focus();
	}, [done]);
	useEffect(() => {
		if (linkDead) deadHeadingRef.current?.focus();
	}, [linkDead]);

	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		// aria-disabled, not disabled, while busy: a disabled button drops keyboard
		// focus, so Enter or a click still arrives here.
		if (busy) return;
		setError("");
		setInvalid({ password: false, confirm: false });
		// Counted in code points, as the server does, so that a password of a few
		// emoji isn't let through here only to be refused there.
		if ([...password].length < MIN_LENGTH) {
			setError(`Use at least ${MIN_LENGTH} characters.`);
			setInvalid({ password: true, confirm: false });
			passwordRef.current?.focus();
			return;
		}
		// Checked here rather than server-side: the server only ever sees one
		// password, and "you typed it differently twice" is a question about this
		// form, not about the account.
		if (password !== confirm) {
			setError("Those two passwords don't match.");
			setInvalid({ password: false, confirm: true });
			confirmRef.current?.focus();
			return;
		}
		setBusy(true);
		try {
			await resetPassword(token, password);
			track("auth_reset_password");
			try {
				sessionStorage.setItem(REDEEMED_KEY, token);
			} catch {
				// Private mode or blocked storage: a reload just shows the form again.
			}
			setDone(true);
		} catch (err) {
			// The length was checked above (the same way the server counts it), so a
			// 400 here is about the token, and retrying the same link can't help.
			if (err instanceof AuthRequestError && err.status === 400) setLinkDead(true);
			setError(
				err instanceof Error && err.message
					? err.message
					: "Couldn't reset your password. Try again."
			);
			// The fields were checked above and a 400 replaced the form, so what is
			// left (a rate limit, a dropped connection) is about neither of them.
		} finally {
			setBusy(false);
		}
	};

	return (
		<main className="rp-wrapper">
			<div className="authm-card rp-card">
				<Link to="/" className="rp-brand" aria-label="BodyMaps home">
					<img src="/bodymaps-logo.svg" alt="" className="authm-logo" />
				</Link>
				{/* Mounted from the start so the change is announced. */}
				<p className="rp-sr" role="status">
					{done
						? loading
							? ""
							: signedIn
								? "Password changed. You're signed in."
								: "Password changed."
						: linkDead
							? error
							: ""}
				</p>

				{done ? (
					<>
						<h1 className="authm-title" ref={doneHeadingRef} tabIndex={-1}>
							Password changed
						</h1>
						{/* Neither sentence is shown until the session check has
						    answered, so the card doesn't say one thing and then the other. */}
						{loading ? null : signedIn ? (
							<>
								<p className="authm-sent">
									You're signed in on this device. Every other browser that was
									signed in as you has been signed out.
								</p>
								<button
									type="button"
									className="authm-submit rp-submit"
									onClick={() => navigate("/dashboard", { replace: true })}
								>
									Continue to BodyMaps
								</button>
							</>
						) : (
							<>
								<p className="authm-sent">Your password was changed.</p>
								<button
									type="button"
									className="authm-submit rp-submit"
									onClick={() => promptAuth("signin")}
								>
									Sign in
								</button>
							</>
						)}
					</>
				) : linkDead ? (
					<>
						<h1 className="authm-title" ref={deadHeadingRef} tabIndex={-1}>
							That link can't be used
						</h1>
						<p className="authm-sent">{error}</p>
						<button
							type="button"
							className="authm-submit rp-submit"
							onClick={() => { navigate("/"); promptAuth("forgot"); }}
						>
							Send a new link
						</button>
					</>
				) : missingToken ? (
					<>
						<h1 className="authm-title">That link is incomplete</h1>
						<p className="authm-sent">
							The reset link seems to have been cut short. That often happens
							when it wraps across two lines in an email. Copy the whole link, or
							ask for a new one.
						</p>
						<button
							type="button"
							className="authm-submit rp-submit"
							onClick={() => { navigate("/"); promptAuth("forgot"); }}
						>
							Send a new link
						</button>
					</>
				) : (
					<>
						<h1 className="authm-title">Choose a new password</h1>
						<form className="authm-form" onSubmit={submit}>
							<label className="authm-field">
								<span className="authm-label">New password</span>
								<input
									ref={passwordRef}
									type="password"
									autoComplete="new-password"
									className="authm-input"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder={`At least ${MIN_LENGTH} characters`}
									aria-invalid={invalid.password ? true : undefined}
									aria-describedby={invalid.password ? errorId : undefined}
									autoFocus
								/>
							</label>
							<label className="authm-field">
								<span className="authm-label">Confirm new password</span>
								<input
									ref={confirmRef}
									type="password"
									autoComplete="new-password"
									className="authm-input"
									value={confirm}
									onChange={(e) => setConfirm(e.target.value)}
									placeholder="••••••••"
									aria-invalid={invalid.confirm ? true : undefined}
									aria-describedby={invalid.confirm ? errorId : undefined}
								/>
							</label>
							{/* Always mounted (empty until needed): an alert that appears
							    together with its text is often not read out. */}
							<div id={errorId} className="authm-error rp-error" role="alert">
								{error}
							</div>
							<button type="submit" className="authm-submit" aria-disabled={busy || undefined}>
								{busy ? "Setting password…" : "Set new password"}
							</button>
						</form>
						<p className="authm-fineprint">
							Links expire an hour after they're sent and work only once.
						</p>
					</>
				)}
			</div>
		</main>
	);
};

export default ResetPassword;
