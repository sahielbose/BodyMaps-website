import { IconBrandGithub, IconBrandGoogle } from "@tabler/icons-react";
import React, { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AUTH_FINEPRINT_LEAD, AUTH_FINEPRINT_MID, AUTH_OAUTH_RESET_HINT } from "../helpers/copy";
import { AuthRequestError, useAuth } from "../contexts/authContext";
import { track } from "../helpers/analytics";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDialogFocus";
import "./AuthModal.css";

// The one auth popup: signing in and creating an account are the same card with
// a different title, a different submit button, and terms fine print on the
// signup side. Claude and ChatGPT both do exactly this — their log-in and
// create-account screens are the same layout throughout.
//
// Opened by authContext.promptAuth(mode) from the header, from gated upload
// actions, and from /signup — which redirects here rather than 404ing, so old
// links and bookmarks still land somewhere sensible.
//
// Providers come first with the email form behind "Continue with email", which
// keeps the default card short.
//
// "forgot" is the third mode, and it skips the provider screen: it is reached
// from the sign-in form by someone who already knows the password isn't working,
// so offering them the Google button again as the first thing is answering a
// question they didn't ask. The one line about OAuth accounts covers the case
// where the reason their password fails is that they never had one.
//
// Keyboard and screen readers: useDialogFocus moves focus into the card on
// open, keeps Tab inside it, closes on Escape, stops the page behind from
// scrolling and returns focus to whatever opened it. Errors are role="alert"
// so they are read out the moment they appear.
// The server counts a password in code points too, so a short one is named on
// its field before the request rather than after it.
const MIN_PASSWORD_LENGTH = 8;

// Which fields a failed sign-in or sign-up is about. 409 is the email (already
// registered), a 400 on sign-up is the email (the length is checked before the
// request), 401 is the pair, and anything else (a dropped connection, a rate
// limit, a 5xx) is about neither field.
const failedFields = (err: unknown, isSignup: boolean) => {
	const status = err instanceof AuthRequestError ? err.status : 0;
	if (status === 409 || (status === 400 && isSignup)) return { email: true, password: false };
	if (status === 401) return { email: true, password: true };
	return { email: false, password: false };
};

const AuthModal: React.FC = () => {
	const {
		authPrompt, closeAuthPrompt, promptAuth, signIn, signUp,
		requestPasswordReset, signInWithProvider, oauthProviders, oauthError,
		clearOauthError,
	} = useAuth();

	const isSignup = authPrompt.mode === "signup";
	const isForgot = authPrompt.mode === "forgot";

	// "email mode" reveals the email/password form (World Labs' "Continue with email").
	const [emailMode, setEmailMode] = useState(false);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	// Which fields the current error is about, so only those read as invalid.
	const [invalid, setInvalid] = useState({ email: false, password: false });
	const [busy, setBusy] = useState(false);
	// The reset request has been accepted. A settled end state, not a banner over
	// the form: there is nothing left to do on this card.
	const [resetSent, setResetSent] = useState(false);
	// Counts submits. Closing the popup or switching mode bumps it, so a request
	// that answers late is ignored instead of writing into the next screen.
	const submitToken = useRef(0);

	// Reset transient form state whenever the popup opens/closes.
	useEffect(() => {
		if (!authPrompt.open) {
			submitToken.current += 1;
			setEmailMode(false);
			setEmail(""); setPassword(""); setError(""); setInvalid({ email: false, password: false }); setBusy(false);
			setResetSent(false);
		}
	}, [authPrompt.open]);

	// Flipping between sign-in and sign-up clears the password and any error —
	// a rejected sign-in shouldn't still be showing over the signup form.
	useEffect(() => {
		submitToken.current += 1;
		setPassword(""); setError(""); setInvalid({ email: false, password: false }); setResetSent(false); setBusy(false);
	}, [authPrompt.mode]);

	// Surface an error the OAuth callback redirected back with.
	useEffect(() => {
		if (oauthError) setError(oauthError);
	}, [oauthError]);

	// Closing the popup also clears a pending OAuth error so it doesn't reappear.
	const dismiss = () => {
		clearOauthError();
		closeAuthPrompt();
	};

	const cardRef = useRef<HTMLDivElement>(null);
	const emailRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);
	const emailBtnRef = useRef<HTMLButtonElement>(null);
	const titleId = useId();
	const errorId = useId();

	// Opening straight onto a form (Forgot password from an expired reset link)
	// lands on its Email field; the provider screen keeps the Close-first default.
	useDialogFocus(authPrompt.open, cardRef, {
		onEscape: dismiss,
		initialFocus: isForgot || emailMode ? emailRef : undefined,
	});
	// Closes only for a click that starts and ends on the backdrop: selecting
	// text in a field and letting go outside the card keeps what was typed.
	const backdropHandlers = useBackdropDismiss(dismiss);

	// Switching screens can unmount the button that had focus ("Forgot
	// password?", "Other options", "try another address"). Put focus back in
	// the card, on the field or button that leads the new screen, rather than
	// letting it fall to the page behind.
	useEffect(() => {
		const card = cardRef.current;
		if (!authPrompt.open || !card || card.contains(document.activeElement)) return;
		(emailRef.current ?? emailBtnRef.current ?? card).focus({ preventScroll: true });
	}, [authPrompt.open, authPrompt.mode, emailMode, resetSent]);

	if (!authPrompt.open) return null;

	const submitEmail = async (e: React.FormEvent) => {
		e.preventDefault();
		// The button is aria-disabled, not disabled, while busy (a disabled button
		// drops keyboard focus), so Enter or a click still arrives here.
		if (busy) return;
		setError("");
		setInvalid({ email: false, password: false });
		// A blank field is named, marked and focused, not just announced.
		const rejectBlank = (message: string, emailBlank: boolean, passwordBlank: boolean) => {
			setError(message);
			setInvalid({ email: emailBlank, password: passwordBlank });
			(emailBlank ? emailRef : passwordRef).current?.focus();
		};
		if (isForgot) {
			if (!email.trim()) { rejectBlank("Enter your email address.", true, false); return; }
		} else if (!email.trim() || !password) {
			const noEmail = !email.trim();
			const noPassword = !password;
			rejectBlank(
				noEmail && noPassword ? "Enter an email and password."
					: noEmail ? "Enter your email address." : "Enter a password.",
				noEmail,
				noPassword,
			);
			return;
		}
		if (isSignup && [...password].length < MIN_PASSWORD_LENGTH) {
			rejectBlank(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, false, true);
			return;
		}
		const token = ++submitToken.current;
		const stale = () => token !== submitToken.current;
		setBusy(true);
		try {
			if (isForgot) {
				await requestPasswordReset(email.trim());
				track("auth_forgot_password_request");
				if (!stale()) setResetSent(true);
				return;
			}
			if (isSignup) await signUp(email, password);
			else await signIn(email, password);
			// After the await: this counts successful sign-ins, not attempts.
			track(isSignup ? "auth_sign_up" : "auth_sign_in");
			// authContext auto-closes the popup once the user is set.
		} catch (err) {
			if (stale()) return;
			// Surface the API's message ("Invalid email or password", "An account
			// with that email already exists", ...) rather than a generic string.
			setError(err instanceof Error && err.message ? err.message : "Something went wrong. Try again.");
			const fields = failedFields(err, isSignup);
			setInvalid(fields);
			// Hand focus to the field at fault, as the blank-field checks do.
			if (fields.password) passwordRef.current?.focus();
			else if (fields.email) emailRef.current?.focus();
		} finally {
			if (!stale()) setBusy(false);
		}
	};

	return (
		<div className="authm-backdrop" {...backdropHandlers}>
			<div
				ref={cardRef}
				className="authm-card"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
			>
				<button type="button" className="authm-close" aria-label="Close" onClick={dismiss}>
					<span aria-hidden="true">×</span>
				</button>

				<img src="/bodymaps-logo.svg" alt="" className="authm-logo" />
				<h2 className="authm-title" id={titleId}>
					{isForgot ? "Reset your password" : isSignup ? "Create your account" : "Sign in"}
				</h2>

				{isForgot && resetSent ? (
					<>
						{/* Deliberately hedged. The server answers identically whether or
						    not the address has an account, so that this card can't be used
						    to find out which addresses are registered — which means the
						    card genuinely does not know, and saying "sent" would be a
						    claim it can't make. */}
						<p className="authm-sent" role="status">
							If an account exists for <strong>{email.trim()}</strong>, a reset
							link is on its way. It works once and expires in an hour.
						</p>
						<p className="authm-fineprint">
							Nothing arrived? Check your spam folder, or{" "}
							<button
								type="button"
								className="authm-link"
								onClick={() => { setResetSent(false); setError(""); }}
							>
								try another address
							</button>
							.
						</p>
					</>
				) : !emailMode && !isForgot ? (
					<>
						{/* A provider with no server-side credentials stays disabled. */}
						<button
							type="button"
							className="authm-provider"
							disabled={oauthProviders?.google === false}
							title={oauthProviders?.google === false ? "Not available on this site" : undefined}
							onClick={() => signInWithProvider("google")}
						>
							<IconBrandGoogle size={18} />
							Continue with Google
						</button>
						<button
							type="button"
							className="authm-provider"
							disabled={oauthProviders?.github === false}
							title={oauthProviders?.github === false ? "Not available on this site" : undefined}
							onClick={() => signInWithProvider("github")}
						>
							<IconBrandGithub size={18} />
							Continue with GitHub
						</button>

						{/* Errors bounced back from the OAuth callback land here. */}
						{error && <div className="authm-error" role="alert">{error}</div>}

						<div className="authm-divider"><span>or</span></div>

						<button
							ref={emailBtnRef}
							type="button"
							className="authm-email-btn"
							onClick={() => setEmailMode(true)}
						>
							Continue with email
						</button>
					</>
				) : (
					<form className="authm-form" onSubmit={submitEmail}>
						{isForgot && (
							<p className="authm-sub">{AUTH_OAUTH_RESET_HINT}</p>
						)}
						<label className="authm-field">
							<span className="authm-label">Email</span>
							<input key={authPrompt.mode} ref={emailRef} type="email" autoComplete="email" className="authm-input" value={email}
								onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus
								aria-invalid={invalid.email ? true : undefined}
								aria-describedby={invalid.email ? errorId : undefined} />
						</label>
						{!isForgot && (
							<label className="authm-field">
								<span className="authm-label">Password</span>
								<input
									ref={passwordRef}
									type="password"
									autoComplete={isSignup ? "new-password" : "current-password"}
									className="authm-input"
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									placeholder={isSignup ? "At least 8 characters" : "••••••••"}
									aria-invalid={invalid.password ? true : undefined}
									aria-describedby={invalid.password ? errorId : undefined}
								/>
							</label>
						)}
						{error && <div className="authm-error" role="alert" id={errorId}>{error}</div>}
						{/* Sign-in only. On the signup side there is no password to have
						    forgotten, and offering a reset there just invites confusion. */}
						{!isSignup && !isForgot && (
							<button
								type="button"
								className="authm-link authm-forgot"
								onClick={() => promptAuth("forgot")}
							>
								Forgot password?
							</button>
						)}
						<button type="submit" className="authm-submit" aria-disabled={busy || undefined}>
							{isForgot
								? busy ? "Sending…" : "Send reset link"
								: isSignup
									? busy ? "Creating account…" : "Create account"
									: busy ? "Signing in…" : "Sign in"}
						</button>
						{/* The reset screen already ends in "Remembered it? Sign in";
						    a second way back would only repeat it. */}
						{!isForgot && (
							<button
									type="button"
									className="authm-back"
									onClick={() => {
										// The credentials error belongs to the form, not the provider screen,
										// and a request still in flight must not bring it back.
										submitToken.current += 1;
										setBusy(false);
										setError(""); setInvalid({ email: false, password: false });
										setEmailMode(false);
									}}
								>
								<span aria-hidden="true">← </span>Other options
							</button>
						)}
					</form>
				)}

				{/* Consent by continuing rather than a checkbox, on both sign-up and
				    sign-in — Terms are accepted, the Privacy Notice is acknowledged
				    (named as the page itself names it). The reset-password view is
				    not an entry into the service. */}
				{!isForgot && (
					<p className="authm-fineprint">
						{AUTH_FINEPRINT_LEAD}{" "}
						<Link to="/terms" target="_blank">Terms of Service</Link>{" "}
						{AUTH_FINEPRINT_MID}{" "}
						<Link to="/privacy" target="_blank">Privacy Notice</Link>.
					</p>
				)}

				<div className="authm-toggle">
					{isForgot ? (
						<>
							Remembered it?{" "}
							{/* Back to the provider buttons, which the hint above points at. Keyed so it
							    is not reused as the Sign up link, and focus moves to the new screen's lead. */}
							<button key="forgot-signin" type="button" className="authm-link" onClick={() => { setEmailMode(false); promptAuth("signin"); }}>
								Sign in
							</button>
						</>
					) : isSignup ? (
						<>
							Already have an account?{" "}
							<button type="button" className="authm-link" onClick={() => promptAuth("signin")}>
								Sign in
							</button>
						</>
					) : (
						<>
							Don't have an account?{" "}
							<button type="button" className="authm-link" onClick={() => promptAuth("signup")}>
								Sign up
							</button>
						</>
					)}
				</div>
			</div>
		</div>
	);
};

export default AuthModal;
