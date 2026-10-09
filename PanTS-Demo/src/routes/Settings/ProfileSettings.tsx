import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { ACCOUNT_TYPES, accountTypeLabel, type AccountType } from "../../helpers/accountProfile";
import { track } from "../../helpers/analytics";
import { nameInitial } from "../../liveRooms/composerHelpers";
import { useSettings } from "./context";

// Profile: who you are, one preference, and the way out.
//
// The name is a live field rather than an Add/Save/Cancel dance — Claude puts a
// plain text input in the row and commits on blur, which is three interactions
// fewer for the same result.
//
// The account type used to be a required signup step with four descriptive
// cards. It's an optional select here: it still gates nothing, it's just
// reported on. It lives on the account, so it follows the user between browsers.
// Commit-on-blur text row, same interaction pattern as the name field: the
// draft belongs to the input while it's being edited, the account value is
// authoritative otherwise, and nothing fires unless the value changed.
const ProfileFieldRow: React.FC<{
	id: string;
	label: string;
	note?: string;
	placeholder: string;
	value: string | null;
	maxLength: number;
	onCommit: (next: string) => void;
}> = ({ id, label, note, placeholder, value, maxLength, onCommit }) => {
	const committed = value ?? "";
	const [draft, setDraft] = useState(committed);
	// A save that lands while the person is typing again must not put the older
	// value back over what they are typing; the draft is only reset from the
	// account when the field is not being edited.
	const editing = useRef(false);
	useEffect(() => {
		if (!editing.current) setDraft(committed);
	}, [committed]);
	const commit = () => {
		editing.current = false;
		const next = draft.trim();
		if (next === committed) return;
		onCommit(next);
	};
	return (
		<div className="set-row set-row--field">
			<label className="set-row-label" htmlFor={id}>
				{label}
				{note && <span className="set-row-note">{note}</span>}
			</label>
			<input
				id={id}
				className="set-input"
				value={draft}
				maxLength={maxLength}
				placeholder={placeholder}
				onChange={(e) => setDraft(e.target.value)}
				onFocus={() => { editing.current = true; }}
				onBlur={commit}
				onKeyDown={(e) => {
					// Enter or Escape during IME composition belongs to the composition.
					if (e.nativeEvent.isComposing || e.keyCode === 229) return;
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") setDraft(committed);
				}}
			/>
		</div>
	);
};

const ProfileSettings: React.FC = () => {
	const navigate = useNavigate();
	const {
		user, updateName, updateAccountProfile, updatePreferences, signOut,
		sendVerification,
	} = useAuth();
	const { run, notify, fail } = useSettings();

	// Only a second Resend is ignored, not a click that lands while a field is
	// saving: pressing Resend straight after typing blurs the field first, which
	// starts that save before the click arrives. `run` queues the send behind it.
	const sendingRef = useRef(false);
	const [sending, setSending] = useState(false);

	// Resend is removed once the account reads as verified, whether the server
	// said "already verified" or another tab verified the address. If it held
	// keyboard focus when that happened, focus moves to the email value instead
	// of falling to the page, which would send a screen reader back to the top.
	// Focus is tracked on the button itself. Only a blur of the whole window (the
	// tab going to the background) keeps the mark, since focus returns with the
	// tab; any other blur, including a click on blank page, clears it.
	const resendHadFocus = useRef(false);
	const emailValueRef = useRef<HTMLSpanElement>(null);
	const emailVerified = user?.emailVerified;
	useEffect(() => {
		if (!emailVerified || !resendHadFocus.current) return;
		resendHadFocus.current = false;
		const active = document.activeElement;
		if (!active || active === document.body) emailValueRef.current?.focus();
	}, [emailVerified]);

	// What the server currently holds. A name derived from the email isn't a
	// value the user chose, so it shows as a placeholder rather than text they'd
	// have to delete before typing their own.
	const committed = user?.hasCustomName ? user.name : "";

	// Seeded from the account, then owned by the field while it's being edited.
	const [draft, setDraft] = useState(committed);
	// Same rule as ProfileFieldRow: a late save response doesn't overwrite what
	// is being typed.
	const editingName = useRef(false);
	useEffect(() => {
		if (!editingName.current) setDraft(committed);
	}, [committed]);

	// The Role select shows the pick the moment it is made, not when the save
	// returns; null means "follow the account". Without it the control snaps
	// back to the old value until the response lands, and keyboard stepping
	// restarts from there on every press.
	const [roleDraft, setRoleDraft] = useState<string | null>(null);

	if (!user) return null;

	// Commit on blur (and on Enter). No-op when nothing changed, so tabbing
	// through the form doesn't fire a request per field. A save that starts while
	// another is running is queued by `run`, not dropped, so tabbing on and
	// typing in the next field never loses either edit.
	const commitName = () => {
		editingName.current = false;
		const next = draft.trim();
		if (next === committed) return;
		run(async () => {
			await updateName(next);
			notify(next ? "Your name has been updated." : "Your name has been cleared.");
		}, "name");
	};

	return (
		<>
			<div className="set-group">
				<h2 className="set-heading">Profile</h2>

				<div className="set-row">
					<span className="set-row-label">Avatar</span>
					<span className="set-avatar">
						{nameInitial(user.name || user.email)}
					</span>
				</div>

				<div className="set-row set-row--field">
					<label className="set-row-label" htmlFor="set-name">Name</label>
					<input
						id="set-name"
						className="set-input"
						value={draft}
						maxLength={120}
						placeholder={user.hasCustomName ? "Your name" : user.name}
						onChange={(e) => setDraft(e.target.value)}
						onFocus={() => { editingName.current = true; }}
						onBlur={commitName}
						onKeyDown={(e) => {
							// Enter or Escape during IME composition belongs to the composition.
							if (e.nativeEvent.isComposing || e.keyCode === 229) return;
							if (e.key === "Enter") e.currentTarget.blur();
							if (e.key === "Escape") setDraft(committed);
						}}
					/>
				</div>

				<div className="set-row set-row--email">
					<span className="set-row-label">
						Email
						<span className="set-row-note">
							{user.emailVerified
								? "Verified."
								: "Not verified. Check your inbox, or resend the link."}
						</span>
					</span>
					<span className="set-row-value" ref={emailValueRef} tabIndex={-1}>{user.email}</span>
					{!user.emailVerified && (
						<button
							type="button"
							className="set-btn"
							// Not disabled: that would drop keyboard focus from a
							// person who just pressed Enter on it. A second press
							// while one send is in flight is ignored instead.
							aria-disabled={sending || undefined}
							onFocus={() => { resendHadFocus.current = true; }}
							onBlur={(e) => { if (e.relatedTarget || document.hasFocus()) resendHadFocus.current = false; }}
							onClick={() => {
								if (sendingRef.current) return;
								sendingRef.current = true;
								setSending(true);
								run(async () => {
									try {
										const r = await sendVerification();
										// A send that failed is an error, not a confirmation: the
										// error banner stays up, the notice one clears itself.
										if (!r.sent && !r.alreadyVerified) {
											fail("Couldn't send the email. Try again in a minute.");
											return;
										}
										notify(
											r.alreadyVerified
												? "Your email is already verified."
												: "Verification email sent. Check your inbox."
										);
									} finally {
										sendingRef.current = false;
										setSending(false);
									}
								});
							}}
						>
							Resend
						</button>
					)}
				</div>

				<div className="set-row set-row--field">
					<label className="set-row-label" htmlFor="set-role">
						Role
						<span className="set-row-note">Optional. Doesn't affect what you can access.</span>
					</label>
					<select
						id="set-role"
						className="set-select"
						value={roleDraft ?? user.profile.accountType ?? ""}
						onChange={(e) => {
							const picked = e.target.value;
							const accountType = (picked || null) as AccountType | null;
							setRoleDraft(picked);
							run(async () => {
								try {
									track("account_set_account_type");
									await updateAccountProfile({ accountType });
									notify(
										accountType
											? `Your role is set to ${accountTypeLabel(accountType)}.`
											: "Your role has been cleared."
									);
								} finally {
									// Back to the account's value once this save is over,
									// unless a later pick has already replaced it.
									setRoleDraft((now) => (now === picked ? null : now));
								}
							}, "account-type");
						}}
					>
						<option value="">Not set</option>
						{ACCOUNT_TYPES.map((t) => (
							<option key={t.id} value={t.id}>{t.label}</option>
						))}
					</select>
				</div>
			</div>

			<div className="set-group">
				<h2 className="set-heading">Verified researcher profile</h2>

				<ProfileFieldRow
					id="set-organization"
					label="Organization"
					placeholder="Hospital, university or company"
					note="A verified email and a full profile unlock 10 scans a day."
					value={user.profile.organization}
					maxLength={200}
					onCommit={(next) =>
						run(async () => {
							await updateAccountProfile({ organization: next || null });
							notify(next ? "Your organization has been saved." : "Your organization has been cleared.");
						}, "organization")
					}
				/>

				<ProfileFieldRow
					id="set-occupation"
					label="Occupation"
					placeholder="For example, radiologist"
					value={user.profile.occupation}
					maxLength={120}
					onCommit={(next) =>
						run(async () => {
							await updateAccountProfile({ occupation: next || null });
							notify(next ? "Your occupation has been saved." : "Your occupation has been cleared.");
						}, "occupation")
					}
				/>

				<ProfileFieldRow
					id="set-role-description"
					label="About your work"
					placeholder="Needed for 10 scans a day"
					note="A line on what you do and what you'd use BodyMaps for. The verified tier needs this along with your organization and occupation."
					value={user.profile.roleDescription}
					maxLength={2000}
					onCommit={(next) =>
						run(async () => {
							await updateAccountProfile({ roleDescription: next || null });
							notify(next ? "Saved." : "Cleared.");
						}, "role-description")
					}
				/>
			</div>

			<div className="set-group">
				<h2 className="set-heading">Notifications</h2>

				<div className="set-row">
					<span className="set-row-label">Email me when a scan finishes</span>
					<button
						type="button"
						role="switch"
						aria-checked={user.emailNotifications}
						aria-label="Email me when a scan finishes"
						className={`set-switch${user.emailNotifications ? " set-switch--on" : ""}`}
						onClick={() => updatePreferences({ emailNotifications: !user.emailNotifications })}
					>
						<span className="set-switch-knob" />
					</button>
				</div>
			</div>

			<div className="set-group">
				<h2 className="set-heading">Session</h2>

				<div className="set-row">
					{/* Not "log out of all devices": /auth/logout revokes this session
					    only, so claiming otherwise would be a lie. */}
					<span className="set-row-label">Signed in on this browser</span>
					<button
						type="button"
						className="set-btn"
						onClick={() => { signOut(); navigate("/"); }}
					>
						Sign out
					</button>
				</div>
			</div>
		</>
	);
};

export default ProfileSettings;
