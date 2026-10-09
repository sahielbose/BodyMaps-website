import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AuthRequestError, useAuth } from "../contexts/authContext";
import "../components/AuthModal.css";
import "./ResetPassword.css";

// Where the emailed verification link lands: /verify-email?token=…
//
// Same card as the reset page, for the same reason: it is arrived at from a
// mail client, with nothing behind it to pop over. Unlike a reset token, the
// token is redeemed on load - the worst a burned token can do is finish its
// own job (the address ends up verified either way), so the smooth path wins
// over a confirm button. Failure explains itself, points at Settings and offers the next step.
// The token a tab has already redeemed. A reload, or Back from the dashboard,
// remounts this page with the same spent link; asking the server again would
// refuse it and turn a verified account into a dead end.
const VERIFIED_KEY = "verifiedToken";
const redeemed = (token: string) => {
	try {
		return sessionStorage.getItem(VERIFIED_KEY) === token;
	} catch {
		return false;
	}
};

const VerifyEmail: React.FC = () => {
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const { verifyEmail, isAuthenticated, loading, promptAuth } = useAuth();
	const token = params.get("token") || "";

	const [state, setState] = useState<"working" | "done" | "failed">(() => (token && redeemed(token) ? "done" : "working"));
	const [error, setError] = useState("");
	// The server did not refuse the token (it was busy, rate limiting, or not
	// reached), so the link is still good and another try can work.
	const [retryable, setRetryable] = useState(false);
	// Strict Mode mounts twice; the token works once.
	const attempted = useRef(false);
	// Set when "Try again" is pressed: that button goes away while the check runs,
	// so the heading (which also says what is happening) takes focus instead of
	// it being dropped to the page, and keeps it once the result is in.
	const refocus = useRef(false);
	const headingRef = useRef<HTMLHeadingElement>(null);

	const verify = React.useCallback(() => {
		setState("working");
		setRetryable(false);
		verifyEmail(token)
			.then(() => {
				try {
					sessionStorage.setItem(VERIFIED_KEY, token);
				} catch {
					// Private mode or blocked storage: a revisit just asks the server again.
				}
				setState("done");
			})
			.catch((err) => {
				setState("failed");
				setRetryable(!(err instanceof AuthRequestError && err.status === 400));
				setError(
					err instanceof Error && err.message
						? err.message
						: "Couldn't verify your email."
				);
			});
	}, [token, verifyEmail]);

	useEffect(() => {
		if (attempted.current) return;
		attempted.current = true;
		if (!token) {
			setState("failed");
			setError("This link is missing its token. Copy the full link from the email.");
			return;
		}
		if (redeemed(token)) {
			setState("done");
			return;
		}
		verify();
	}, [token, verify]);

	useEffect(() => {
		if (!refocus.current) return;
		headingRef.current?.focus();
		if (state !== "working") refocus.current = false;
	}, [state]);

	// Signing in from the failed card swaps its Sign in button for the Open
	// settings link, taking the popup's focus-return target with it: put focus
	// on the heading rather than letting it fall to the page.
	// Tracked only once the session check has come back, so a reader who was
	// already signed in does not count as having just signed in.
	const wasAuthenticated = useRef<boolean | null>(null);
	useEffect(() => {
		if (loading) return;
		const justSignedIn = isAuthenticated && wasAuthenticated.current === false;
		wasAuthenticated.current = isAuthenticated;
		// Focus is still in the sign-in popup (about to close) or already on the page.
		const active = document.activeElement;
		const inPopup = !active || active === document.body || !!active.closest('[role="dialog"]');
		if (justSignedIn && state === "failed" && !retryable && inPopup) {
			headingRef.current?.focus();
		}
	}, [loading, isAuthenticated, state, retryable]);

	const title =
		state === "working" ? "Verifying your email…"
		: state === "done" ? "Email verified"
		: "Couldn't verify";
	const message =
		state === "working" ? "One moment."
		: state === "done" ? `Your email address is confirmed.${loading ? "" : isAuthenticated ? " You're all set." : " Sign in to continue."}`
		: error;
	// Until the first check of the session cookie comes back, `isAuthenticated`
	// is false for everyone, so a signed-in reader would be told to sign in and
	// offered a Sign in button, and the card would then change under them. The
	// note and the action hold their place, unseen, until it is known.
	const held = loading ? ({ "aria-hidden": true, style: { visibility: "hidden" } } as const) : undefined;

	// One heading and one status line that change in place, rather than three
	// blocks swapped in and out: the status line is mounted from the start, so
	// screen readers announce "verified" or the reason it failed.
	return (
		<main className="rp-wrapper">
			<div className="authm-card rp-card">
				<Link to="/" className="rp-brand" aria-label="BodyMaps home">
					<img src="/bodymaps-logo.svg" alt="" className="authm-logo" />
				</Link>

				<h1 className="authm-title" ref={headingRef} tabIndex={-1}>{title}</h1>
				<p className="authm-sent" role="status">
					{message}
				</p>

				{/* The line above tells a signed-out reader to sign in, so that is the
				    action offered; the button holds its place until the session is known. */}
				{state === "done" && (
					!loading && !isAuthenticated ? (
						<button type="button" className="authm-submit rp-submit" onClick={() => promptAuth("signin")}>
							Sign in
						</button>
					) : (
						<button
							type="button"
							className="authm-submit rp-submit"
							onClick={() => navigate("/dashboard", { replace: true })}
							{...held}
						>
							Continue to BodyMaps
						</button>
					)
				)}

				{state === "failed" && retryable && (
					<button type="button" className="authm-submit rp-submit" onClick={() => { refocus.current = true; verify(); }}>
						Try again
					</button>
				)}

				{state === "failed" && !retryable && (
					<>
						<p className="authm-sent" {...held}>
							{isAuthenticated ? "You" : "After signing in, you"} can ask for a fresh link from Settings → Profile.
							Each link works once, and the newest one replaces the rest.
						</p>
						{loading ? (
							<span className="authm-submit rp-submit rp-action" {...held}>
								Open settings
							</span>
						) : isAuthenticated ? (
							<Link to="/account" className="authm-submit rp-submit rp-action">
								Open settings
							</Link>
						) : (
							<button type="button" className="authm-submit rp-submit" onClick={() => promptAuth("signin")}>
								Sign in
							</button>
						)}
					</>
				)}
			</div>
		</main>
	);
};

export default VerifyEmail;
