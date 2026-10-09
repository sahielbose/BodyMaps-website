import React, { useEffect, useId, useRef, type RefObject } from "react";
import { formatRelativeTime, recentStatusColor, scanAccessibleName, scanSourceName, type RecentUpload } from "../helpers/recentUploads";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDialogFocus";
import "./BatchDetailsModal.css";

// Popup listing every scan in a batch, each with its own status / View / Download,
// the same affordances an individual completed upload gets. Takes up most of
// the screen (not all) and closes via the X or a backdrop click / Esc.
type Props = {
	label: string;
	uploads: RecentUpload[];
	onClose: () => void;
	onView: (upload: RecentUpload) => void;
	onDownloadScan: (upload: RecentUpload) => void;
	onDownloadAll: () => void;
	// Keys of the downloads still going (a scan's session id, or the batch id),
	// so a second press on the same button does nothing and shows it is busy.
	busyDownloads?: string[];
	// The batch's own id, the key its Download all goes under.
	batchId?: string;
	// What a Download just did ("Preparing...", "Download failed..."), shown
	// inside the popup because the page's own notice sits behind the backdrop.
	note?: string;
	// Where focus goes on close when the button that opened the popup is gone
	// (the finished-batch bar unmounts as the popup mounts).
	restoreFocusRef?: RefObject<HTMLElement | null>;
};

// Only a finished scan can be viewed/downloaded; a still-processing one just
// shows its status (this modal is now reachable from a live batch too).
const isDone = (s: RecentUpload["status"]) => s === "Completed";

const BatchDetailsModal: React.FC<Props> = ({
	label,
	uploads,
	onClose,
	onView,
	onDownloadScan,
	onDownloadAll,
	busyDownloads = [],
	batchId,
	note,
	restoreFocusRef,
}) => {
	// Focus moves in on open, Tab stays inside, Escape closes, and focus
	// returns to the "View details" button that opened it.
	const panelRef = useRef<HTMLDivElement>(null);
	useDialogFocus(true, panelRef, { onEscape: onClose });
	const backdrop = useBackdropDismiss(onClose);
	const titleId = useId();

	// Runs after useDialogFocus's own cleanup: if that found no opener to
	// return to, focus is on <body> and would restart the page from the top.
	useEffect(() => {
		const panel = panelRef.current;
		return () => {
			const now = document.activeElement;
			const lost = !now || now === document.body || !!panel?.contains(now);
			const fallback = restoreFocusRef?.current;
			if (lost && fallback && fallback.isConnected) fallback.focus({ preventScroll: true });
		};
		// Only the unmount matters; the ref object is stable.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const done = uploads.filter((u) => u.status === "Completed").length;
	const busyStyle = { opacity: 0.6, cursor: "progress" } as const;
	const allBusy = !!batchId && busyDownloads.includes(batchId);

	return (
		<div className="bdm-backdrop" {...backdrop}>
			<div
				ref={panelRef}
				className="bdm-panel"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
			>
				<div className="bdm-header">
					<div className="bdm-header-text">
						<h2 className="bdm-title" id={titleId}>{label}</h2>
						<div className="bdm-subtitle">
							{done}/{uploads.length} complete
						</div>
					</div>
					<div className="bdm-header-actions">
						<button
							type="button"
							className="bdm-download-all"
							disabled={done === 0}
							aria-busy={allBusy || undefined}
							style={allBusy ? busyStyle : undefined}
							onClick={onDownloadAll}
						>
							Download all
						</button>
						<button type="button" className="bdm-close" aria-label="Close" onClick={onClose}>
							×
						</button>
					</div>
				</div>

				<div className="bdm-note" role="status">{note}</div>

				<div className="bdm-list">
					{uploads.map((u) => {
						const done = isDone(u.status);
						const name = scanAccessibleName(u, uploads);
						const source = scanSourceName(u);
						return (
							<div key={u.sessionId} className="bdm-row">
								<div className="bdm-row-main">
									<div className="bdm-row-title">{u.label}</div>
									<div className="bdm-row-sub">
										{source && <span style={{ overflowWrap: "anywhere" }}>{source} · </span>}
										{u.model ? `${u.model} · ` : ""}
										{formatRelativeTime(u.timestamp)}
									</div>
								</div>
								<div className="bdm-row-actions">
									<span className="bdm-status" style={{ color: recentStatusColor(u.status) }}>
										{u.status}
									</span>
									{done && (
										<>
											<button type="button" className="bdm-btn" aria-label={`View ${name}`} onClick={() => onView(u)}>
												View
											</button>
											<button
												type="button"
												className="bdm-btn"
												aria-label={`Download ${name}`}
												aria-busy={busyDownloads.includes(u.sessionId) || undefined}
												style={busyDownloads.includes(u.sessionId) ? busyStyle : undefined}
												onClick={() => onDownloadScan(u)}
											>
												Download
											</button>
										</>
									)}
								</div>
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
};

export default BatchDetailsModal;
