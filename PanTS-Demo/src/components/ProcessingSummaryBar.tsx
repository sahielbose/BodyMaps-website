import React from "react";
import { recentStatusColor } from "../helpers/recentUploads";

// One consolidated bar for all in-flight scans, instead of a card per scan.
// Shows a circular progress wheel (percent complete), a counter (done / total),
// and a status label. Batch total = running + completed + failed, so as scans
// complete the counter climbs while the total holds steady - a failure is
// counted and named, never silently dropped from the denominator (and the
// wheel tops out below 100% while failures exist).
type Props = {
	running: number; // scans still uploading / queued / running
	done: number; // scans finished in this batch
	failed?: number; // scans that failed - still part of the total
	cancelled?: number; // scans the person cancelled (or that were refused) - still part of the total, but not an error
	statusLabel: string; // dominant phase, e.g. "Running…"
	title?: string; // defaults to "Processing scans"
	buttonName?: string; // what the buttons say they act on; defaults to the title, but two batches can share one
	closeNote?: string; // e.g. "safe to close" - whether the tab is still needed
	closeReady?: boolean; // true once nothing is uploading (tints the note green)
	onViewDetails?: () => void; // per-scan status / view / download for the batch
	onCancelAll?: () => void;
};

// What a screen reader hears when a batch resolves; empty while scans still run.
// The bar remounts when a batch moves from in-flight to finished, so the page
// keeps one live region of its own and feeds this text into it.
export const batchAnnouncement = ({ title = "Processing scans", running, done, failed = 0, cancelled = 0 }: Pick<Props, "title" | "running" | "done" | "failed" | "cancelled">): string => {
	if (running > 0) return "";
	const total = running + done + failed + cancelled;
	return `${title}: ${done} of ${total} complete${failed ? `, ${failed} failed` : ""}${cancelled ? `, ${cancelled} cancelled` : ""}`;
};

const SIZE = 46;
const STROKE = 4;

const ProcessingSummaryBar: React.FC<Props> = ({ running, done, failed = 0, cancelled = 0, statusLabel, title = "Processing scans", buttonName = title, closeNote, closeReady, onViewDetails, onCancelAll }) => {
	const total = running + done + failed + cancelled;
	const pct = total > 0 ? Math.round((done / total) * 100) : 0;

	const r = (SIZE - STROKE) / 2;
	const circ = 2 * Math.PI * r;
	const offset = circ * (1 - pct / 100);

	return (
		<div className="proc-bar">
			<div className="proc-wheel" style={{ width: SIZE, height: SIZE }}>
				<svg width={SIZE} height={SIZE}>
					<circle
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={r}
						fill="none"
						stroke="rgba(0,45,114,0.12)"
						strokeWidth={STROKE}
					/>
					<circle
						cx={SIZE / 2}
						cy={SIZE / 2}
						r={r}
						fill="none"
						stroke="#002D72"
						strokeWidth={STROKE}
						strokeLinecap="round"
						strokeDasharray={circ}
						strokeDashoffset={offset}
						transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
						style={{ transition: "stroke-dashoffset 0.4s ease" }}
					/>
				</svg>
				<span className="proc-wheel-pct">{pct}%</span>
			</div>

			<div className="proc-info">
				<div className="proc-title">
					{title} <span className="proc-counter">{done}/{total}</span>
				</div>
				<div className="proc-sub">
					{/* The spin is "something is still happening" - once nothing is
					    running anymore it should stop, not keep spinning next to
					    "Inference complete" forever. */}
					{running > 0 ? (
						<span className="upload-spinner proc-spinner" />
					) : failed + cancelled === 0 ? (
						<span className="proc-done-icon" aria-hidden="true">
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
								<path d="M20 6 9 17l-5-5" />
							</svg>
						</span>
					) : (
						// Not everything finished cleanly, so no green tick: a neutral mark.
						<span className="proc-done-icon" aria-hidden="true" style={{ background: "rgba(180,83,9,0.14)", color: "#b45309" }}>
							<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 6v7M12 18h.01" />
							</svg>
						</span>
					)}
					{/* One text run, not sibling flex items - otherwise the row's gap
					    opens a hole before the note and wraps it onto its own line. */}
					<span>
						{/* Each dot is tied to the words before it (a no-break space), so a
						    wrapped line ends on a dot instead of starting with one. */}
						{statusLabel}
						{running > 0 && `\u00a0· ${running} in progress`}
						{failed > 0 && (
							<span style={{ color: recentStatusColor("Failed") }}>{`\u00a0· ${failed} failed`}</span>
						)}
						{cancelled > 0 && (
							<span style={{ color: "#b45309" }}>{`\u00a0· ${cancelled} cancelled`}</span>
						)}
						{closeNote && (
							<span className={`proc-close-note${closeReady ? " proc-close-note--ready" : ""}`}>
								{"\u00a0· "}{closeNote}
							</span>
						)}
					</span>
				</div>
			</div>

			{onViewDetails && (
				<button type="button" className="proc-details-btn" aria-label={`View details for ${buttonName}`} onClick={onViewDetails}>
					View details
				</button>
			)}
			{onCancelAll && (
				<button type="button" className="active-cancel-btn proc-cancel" aria-label={`Cancel all scans in ${buttonName}`} onClick={onCancelAll}>
					Cancel all
				</button>
			)}
		</div>
	);
};

export default ProcessingSummaryBar;
