import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { loadRecentUploads, persistRecentUploads } from "../../helpers/recentUploads";
import { useSettings } from "./context";

// Privacy: export, and the two destructive actions.
//
// There is no red "danger zone" panel any more. Claude puts "Delete account"
// in a plain row like any other and saves the weight for the confirmation —
// which is the right split: a warning you scroll past every visit stops
// registering, and the moment that actually matters is the click.
const PrivacySettings: React.FC = () => {
	const navigate = useNavigate();
	const { exportData, deleteScanHistory, deleteAccount } = useAuth();
	const { busy, run, notify } = useSettings();

	const [confirming, setConfirming] = useState<"history" | "account" | null>(null);
	const [typed, setTyped] = useState("");

	const word = confirming === "account" ? "DELETE" : "CLEAR";

	const start = (which: "history" | "account") => {
		setConfirming(which);
		setTyped("");
	};

	const confirm = () =>
		run(async () => {
			if (confirming === "history") {
				// The Upload page and History render from the localStorage list,
				// which is disjoint from the server's jobs record (see
				// HistorySettings) - clear both, or the UI keeps listing scans
				// this action just promised were gone.
				const localCount = loadRecentUploads().length;
				const count = await deleteScanHistory();
				persistRecentUploads([]);
				setConfirming(null);
				setTyped("");
				// The two records overlap but neither contains the other, so the
				// larger of the two counts is the honest lower bound.
				const total = Math.max(count, localCount);
				notify(
					total === 0
						? "You had no scans to delete."
						: `Deleted ${total} scan${total === 1 ? "" : "s"} and their results.`
				);
				return;
			}
			await deleteAccount();
			navigate("/", { replace: true });
		});

	return (
		<>
			<div className="set-group">
				<h2 className="set-heading">Your data</h2>

				<div className="set-row">
					<span className="set-row-label">Export data</span>
					<button type="button" className="set-btn" disabled={busy} onClick={() =>
						run(async () => {
							await exportData();
							notify("Your data has been downloaded.");
						})
					}>
						Export
					</button>
				</div>

				<div className="set-row">
					<span className="set-row-label">Delete scan history</span>
					<button type="button" className="set-btn set-btn--danger" onClick={() => start("history")}>
						Delete
					</button>
				</div>

				<div className="set-row">
					<span className="set-row-label">Delete account</span>
					<button type="button" className="set-btn set-btn--danger" onClick={() => start("account")}>
						Delete
					</button>
				</div>

				{confirming && (
					<div className="set-confirm" role="alertdialog" aria-label="Confirm">
						<div className="set-confirm-text">
							{confirming === "history" ? (
								<>
									This permanently deletes every scan you've uploaded and every
									segmentation produced from them. Your account stays. It can't be undone.
								</>
							) : (
								<>
									This signs you out everywhere and schedules your account and all your
									scans for deletion. You have 30 days to change your mind — sign back in
									and everything is restored.
								</>
							)}
							<br />
							Type <strong>{word}</strong> to confirm.
						</div>
						<div className="set-confirm-actions">
							<input
								className="set-input"
								value={typed}
								autoFocus
								aria-label={`Type ${word} to confirm`}
								onChange={(e) => setTyped(e.target.value)}
							/>
							<button
								type="button"
								className="set-btn set-btn--danger"
								disabled={busy || typed.trim() !== word}
								onClick={confirm}
							>
								{busy ? "Working…" : "Confirm"}
							</button>
							<button
								type="button"
								className="set-btn"
								onClick={() => { setConfirming(null); setTyped(""); }}
							>
								Cancel
							</button>
						</div>
					</div>
				)}
			</div>
		</>
	);
};

export default PrivacySettings;
