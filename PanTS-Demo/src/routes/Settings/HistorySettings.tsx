import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import { fetchListedRuns, useRunsAdoptedVersion } from "../../helpers/adoptLegacyRuns";
import {
	formatRelativeTime,
	groupUploads,
	isGroupInFlight,
	loadRecentUploads,
	mergeServerRuns,
	persistRecentUploads,
	removeRecentUpload,
	runsOf,
	scanAccessibleName,
	scanSourceName,
	splitByAge,
	type RecentUpload,
	type UploadGroup,
} from "../../helpers/recentUploads";
import MetaParts from "./MetaParts";

const groupKey = (g: UploadGroup) => (g.kind === "single" ? g.upload.sessionId : g.batchId);

// History: every scan that's either already been viewed, or has sat unviewed
// for more than a day. The Upload page only keeps unviewed, recent scans so
// it stays a workbench rather than a filing cabinet; everything else lives
// here (see splitByAge).
//
// Reads the same localStorage list the Upload page does, so labels and batch
// grouping carry over, and shows the signed-in account's own runs from it (see
// runsOf): the list is per browser, and another account's runs are not this
// one's to see or remove. The list is per-browser, so on a browser that never ran
// a scan the runs from the server's per-account list (GET /api/me/runs) are added
// here too, the way the Upload page adds them, without opening it first.
// GET /api/me/jobs is only written by the queue path, not the one the Upload
// page actually uses, so it would show an empty list here.
const HistorySettings: React.FC = () => {
	const navigate = useNavigate();
	const { user, loading } = useAuth();
	const [uploads, setUploads] = useState<RecentUpload[]>(() => loadRecentUploads());
	// Runs from before entries carried an owner are stamped once sign-in
	// settles (see adoptLegacyRuns); a list read before that is read again.
	const adoptedVersion = useRunsAdoptedVersion();
	const [seenVersion, setSeenVersion] = useState(adoptedVersion);
	if (seenVersion !== adoptedVersion) {
		setSeenVersion(adoptedVersion);
		setUploads(loadRecentUploads());
	}

	// Another browser or device, or cleared site data, leaves the local list
	// without scans the account has. Add the ones it lacks, as the Upload page
	// does; what is already here is left as it is.
	const userId = user?.id ?? null;
	useEffect(() => {
		if (!userId) return;
		const controller = new AbortController();
		(async () => {
			try {
				const runs = await fetchListedRuns(userId);
				if (runs === null || controller.signal.aborted) return;
				// Read now, not before the request: the list may have changed meanwhile.
				const { list, added } = mergeServerRuns(loadRecentUploads(), runs, userId);
				if (added.length === 0) return;
				persistRecentUploads(list);
				setUploads(list);
			} catch {
				// Best effort: the local list is all there is until the next visit.
			}
		})();
		return () => controller.abort();
	}, [userId]);

	const finished = groupUploads(runsOf(uploads, user?.id ?? null, !loading)).filter((g) => !isGroupInFlight(g));
	const { older } = splitByAge(finished);

	// Two scans of one model on one day share their default name, so a screen
	// reader or voice control would hear the same "Remove ..." on several rows,
	// and Remove acts at once. A name that more than one row shares gets the time
	// the scan started, and a count where even that matches (as batchButtonNames
	// does for batches on the Upload page). Names that are already unique are left as they are.
	const buttonNames = new Map<string, string>();
	{
		const labelOf = (g: UploadGroup) => (g.kind === "single" ? g.upload.label : g.label);
		const shared = new Map<string, number>();
		older.forEach((g) => shared.set(labelOf(g), (shared.get(labelOf(g)) ?? 0) + 1));
		const seen = new Map<string, number>();
		older.forEach((g) => {
			const label = labelOf(g);
			if ((shared.get(label) ?? 0) < 2) {
				buttonNames.set(groupKey(g), label);
				return;
			}
			const time = new Date(g.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
			const base = `${label} at ${time}`;
			const n = (seen.get(base) ?? 0) + 1;
			seen.set(base, n);
			buttonNames.set(groupKey(g), n === 1 ? base : `${base} (${n})`);
		});
	}

	// Removing a row unmounts the button that had focus, which would drop it to
	// the page. The row to land on is chosen before the removal and focused
	// once the list has re-rendered: the next row's Remove, else the previous
	// one's, else the empty message.
	const removeButtons = useRef(new Map<string, HTMLButtonElement>());
	const emptyNote = useRef<HTMLDivElement>(null);
	const focusAfter = useRef<string | null>(null);
	useEffect(() => {
		const key = focusAfter.current;
		if (key === null) return;
		focusAfter.current = null;
		(key === "" ? emptyNote.current : removeButtons.current.get(key))?.focus();
	}, [uploads]);

	const remove = (group: UploadGroup) => {
		const at = older.indexOf(group);
		const neighbour = older[at + 1] ?? older[at - 1];
		focusAfter.current = neighbour ? groupKey(neighbour) : "";
		const ids =
			group.kind === "single" ? [group.upload.sessionId] : group.uploads.map((u) => u.sessionId);
		let next = uploads;
		ids.forEach((id) => { next = removeRecentUpload(id); });
		setUploads(next);
	};

	const open = (u: RecentUpload) =>
		navigate(`/${u.isReconstruction ? "reconstruction" : "session"}/${u.sessionId}`);

	return (
		<div className="set-group">
			<div className="set-head">
				<h2 className="set-heading">History</h2>
				<p className="set-sub">
					Scans you've already opened, and any older than a day. Newer scans you
					haven't opened yet stay on the Upload page.
				</p>
			</div>

			{older.length === 0 ? (
				<div className="set-empty" ref={emptyNote} tabIndex={-1}>Nothing here yet.</div>
			) : (
				<div className="set-history-list">
					{older.map((g) => {
						const label = g.kind === "single" ? g.upload.label : g.label;
						const when = formatRelativeTime(g.timestamp);
						const buttonName = buttonNames.get(groupKey(g)) ?? label;
						// Scans of one model on one day share their default name, so a
						// single row leads with the file it came from, as the Upload page does.
						const meta =
							g.kind === "single"
								? [scanSourceName(g.upload), g.upload.model, g.upload.status, when]
								: [`${g.uploads.filter((u) => u.status === "Completed").length} of ${g.uploads.length} completed`, when];
						const isViewable = (u: RecentUpload) => u.status !== "Failed" && u.status !== "Cancelled";
						return (
							<div key={groupKey(g)} className="set-history-row">
								<div className="set-history-main">
									<div className="set-history-name">{label}</div>
									<div className="set-history-meta">
										<MetaParts parts={meta.map((text, i) => text && { text, wrap: g.kind === "single" && i === 0 })} />
									</div>
								</div>
								{/* A batch opens one scan at a time, so each of its scans
								    gets its own row and its own View. */}
								{g.kind === "batch" && (
									<ul className="set-history-scans">
										{g.uploads.map((u, i) => {
											// The scans of a batch share a default name, so the file each came
											// from is what tells the rows, and their View buttons, apart. With
											// no file on record, a scan named like its batch is numbered.
											const source = scanSourceName(u);
											const numbered = !source && u.label === g.label;
											const shown = numbered ? `Scan ${i + 1}` : u.label;
											const name = numbered ? shown : scanAccessibleName(u, g.uploads);
											return (
												<li key={u.sessionId} className="set-history-scan">
													<span className="set-history-scan-name">
														{shown}
														{source && <span className="set-history-scan-source">{source}</span>}
														<span className="set-history-scan-status">{u.status}</span>
													</span>
													{isViewable(u) && (
														<button
															type="button" className="set-btn"
															aria-label={`View ${name} in ${buttonName}`}
															onClick={() => open(u)}
														>
															View
														</button>
													)}
												</li>
											);
										})}
									</ul>
								)}
								<div className="set-history-actions">
									{/* Named after the scan, so a screen reader doesn't hear
									    "View, Remove" on every row. */}
									{g.kind === "single" && isViewable(g.upload) && (
										<button type="button" className="set-btn" aria-label={`View ${buttonName}`} onClick={() => open(g.upload)}>
											View
										</button>
									)}
									<button
										type="button" className="set-btn" aria-label={`Remove ${buttonName}`}
										ref={(el) => {
											if (el) removeButtons.current.set(groupKey(g), el);
											else removeButtons.current.delete(groupKey(g));
										}}
										onClick={() => remove(g)}
									>
										Remove
									</button>
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

export default HistorySettings;
