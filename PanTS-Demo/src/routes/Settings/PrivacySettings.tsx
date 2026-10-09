import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { adoptLegacyRuns } from "../../helpers/adoptLegacyRuns";
import { loadRecentUploads, persistRecentUploads, runsOf } from "../../helpers/recentUploads";
import { useSettings } from "./context";

// Privacy: export, and the two destructive actions.
//
// There is no red "danger zone" panel any more. Claude puts "Delete account"
// in a plain row like any other and saves the weight for the confirmation —
// which is the right split: a warning you scroll past every visit stops
// registering, and the moment that actually matters is the click.
//
// Export is deliberately narrow: the account fields you can see on this
// page, nothing internal (no ids, no job rows with server paths). Scans and
// results are not part of it.
const PrivacySettings: React.FC = () => {
	const navigate = useNavigate();
	const { user, exportData, deleteScanHistory, deleteAccount } = useAuth();
	const { busy, run, notify } = useSettings();

	const [confirming, setConfirming] = useState<"history" | "account" | null>(null);
	const [typed, setTyped] = useState("");

	const word = confirming === "account" ? "DELETE" : "CLEAR";
	// The word is shown in capitals, but any case is accepted: a phone keyboard
	// capitalises only the first letter.
	const armed = typed.trim().toUpperCase() === word;

	// Closing the confirmation (Cancel, Escape, or a finished history delete)
	// removes the control that had focus, so focus goes back to the Delete
	// button that opened it, unless it has already moved somewhere else.
	const historyButton = useRef<HTMLButtonElement>(null);
	const accountButton = useRef<HTMLButtonElement>(null);
	const refocus = useRef<"history" | "account" | null>(null);
	useEffect(() => {
		if (confirming || !refocus.current) return;
		const opener = refocus.current === "history" ? historyButton : accountButton;
		const now = document.activeElement;
		if (!now || now === document.body) opener.current?.focus();
		refocus.current = null;
	}, [confirming]);

	const start = (which: "history" | "account") => {
		setConfirming(which);
		setTyped("");
	};

	const close = () => {
		refocus.current = confirming;
		setConfirming(null);
		setTyped("");
	};

	// Escape closes the confirmation, as it does on People.
	useEffect(() => {
		if (!confirming) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			refocus.current = confirming;
			setConfirming(null);
			setTyped("");
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [confirming]);

	const confirm = () =>
		run(async () => {
			if (confirming === "history") {
				// The Upload page and History render from the localStorage list,
				// which is disjoint from the server's jobs record (see
				// HistorySettings) - clear both, or the UI keeps listing scans
				// this action just promised were gone.
				// Only this account's runs are in that list to clear: it is per
				// browser, and another account's runs are theirs.
				const userId = user?.id ?? null;
				// Runs saved before entries carried an owner are this account's
				// when the server says so. The server's records go with the
				// delete below, so they are taken up first: after it nothing
				// could tell they were this account's, and they would be left
				// showing (results gone) to the next signed-out visitor. If the
				// server cannot be asked, nothing is deleted: it is better to
				// say so than to delete and leave those behind.
				if (userId && (await adoptLegacyRuns(userId)) === null) {
					throw new Error(
						"Couldn't check which of the scans saved in this browser are yours, so nothing was deleted. Try again."
					);
				}
				const localCount = runsOf(loadRecentUploads(), userId).length;
				const count = await deleteScanHistory();
				const mine = new Set(runsOf(loadRecentUploads(), userId).map((u) => u.sessionId));
				persistRecentUploads(loadRecentUploads().filter((u) => !mine.has(u.sessionId)));
				close();
				// The two records overlap but neither contains the other, so the
				// larger of the two counts is the honest lower bound.
				const total = Math.max(count, localCount);
				notify(
					total === 0
						? "You had no scans to delete."
						: `Removed ${total} scan${total === 1 ? "" : "s"} and their results.`
				);
				return;
			}
			await deleteAccount();
			navigate("/", { replace: true });
		});

	// The confirmation opens under the row that asked for it.
	const confirmation = (
		<div
			className="set-confirm"
			role="alertdialog"
			aria-label={confirming === "history" ? "Delete your scan history?" : "Delete your account?"}
		>
			<div className="set-confirm-text">
				<strong className="set-confirm-title">
					{confirming === "history" ? "Delete your scan history?" : "Delete your account?"}
				</strong>
				<div className="set-confirm-body">
					{confirming === "history" ? (
						<>
							This removes the scans and results shown in your history, along with
							the working files and masks we can associate with them. It doesn't
							remove a <span className="set-nowrap">de-identified</span> contribution already separated from your
							account, and copies may persist for a time in backups. Your account
							stays. It can't be undone.
						</>
					) : (
						<>
							This signs you out everywhere and schedules your account and its data
							for removal after 30 days. Sign back in before then and everything is
							restored. Removal isn't guaranteed on a specific day, and <span className="set-nowrap">de-identified</span>{" "}
							contributions already separated from your account may remain.
						</>
					)}
				</div>
				<div className="set-confirm-prompt">
					Type <strong>{word}</strong> to confirm.
				</div>
			</div>
			{/* A form so Enter confirms once the word is typed. The submit button is
			    aria-disabled until then (not disabled, so it keeps focus while busy),
			    and the submit guard keeps Enter from doing anything early. */}
			<form
				className="set-confirm-actions"
				onSubmit={(e) => {
					e.preventDefault();
					if (armed && !busy) confirm();
				}}
			>
				<input
					className="set-input"
					value={typed}
					autoFocus
					autoComplete="off"
					autoCapitalize="off"
					spellCheck={false}
					aria-label={`Type ${word} to confirm`}
					onChange={(e) => setTyped(e.target.value)}
				/>
				<button
					type="submit"
					className="set-btn set-btn--danger"
					aria-disabled={busy || !armed || undefined}
				>
					{busy ? "Working…" : "Confirm"}
				</button>
				<button
					type="button"
					className="set-btn"
					onClick={close}
				>
					Cancel
				</button>
			</form>
		</div>
	);

	return (
		<>
			<div className="set-group">
				<div className="set-head">
					<h2 className="set-heading">Your data</h2>
				</div>

				<div className="set-row">
					<span className="set-row-label">Export account details</span>
					<button type="button" className="set-btn" aria-disabled={busy || undefined} aria-label="Export account details" onClick={() => {
						// aria-disabled keeps focus on the button while it works.
						if (busy) return;
						run(async () => {
							await exportData();
							notify("Your account details have been downloaded.");
						});
					}}>
						Export
					</button>
				</div>

				<div className="set-row-block">
					<div className={`set-row${confirming === "history" ? " set-row--open" : ""}`}>
						<span className="set-row-label">Delete scan history</span>
						<button
							ref={historyButton}
							type="button"
							className="set-btn set-btn--danger"
							aria-label="Delete scan history"
							aria-expanded={confirming === "history"}
							onClick={() => start("history")}
						>
							Delete
						</button>
					</div>
					{confirming === "history" && confirmation}
				</div>

				<div className="set-row-block">
					<div className={`set-row${confirming === "account" ? " set-row--open" : ""}`}>
						<span className="set-row-label">Delete account</span>
						<button
							ref={accountButton}
							type="button"
							className="set-btn set-btn--danger"
							aria-label="Delete account"
							aria-expanded={confirming === "account"}
							onClick={() => start("account")}
						>
							Delete
						</button>
					</div>
					{confirming === "account" && confirmation}
				</div>
			</div>
		</>
	);
};

export default PrivacySettings;
