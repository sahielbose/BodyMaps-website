import { IconDownload, IconFileText, IconMicrophone, IconPackage } from "@tabler/icons-react";
import { useEffect, useId, useMemo, useRef, useState, type SyntheticEvent } from "react";
import {
	buildSessionBundle,
	downloadBlob,
	downloadText,
	type SessionResult,
} from "../../helpers/readingSession";
import {
	buildReportHtml,
	buildReportMarkdown,
	caseDisplayName,
	caseFileSlug,
	countLabel,
	formatClock,
	type ReportInput,
	type ReportMeasurement,
} from "../../helpers/sessionReport";
import { focusableWithin, useDialogFocus } from "../../hooks/useDialogFocus";
import "./ReadingSession.css";

type Props = {
	result: SessionResult;
	measurements: ReportMeasurement[];
	onDiscard: () => void;
	// Called once a file made from this session (the bundle, or the report as HTML or
	// Markdown) has been handed to the browser's downloads.
	onSaved?: () => void;
	// True after such a download: the recording lives on disk now, so closing the
	// summary loses nothing and does not ask.
	saved?: boolean;
};

// MediaRecorder webm files carry no duration, so the player reports Infinity and cannot
// seek. Seeking far past the end makes the browser read the whole file and learn the
// real length; the next time update puts the playhead back at the start.
function fixRecorderDuration(e: SyntheticEvent<HTMLAudioElement>) {
	const audio = e.currentTarget;
	if (audio.duration !== Infinity) return;
	audio.addEventListener(
		"timeupdate",
		() => {
			audio.currentTime = 0;
		},
		{ once: true }
	);
	audio.currentTime = 1e101;
}

// Post-session dialog ("Reading session captured"): play back the narration,
// open the template-built draft report, download the full session bundle, or
// discard. The app uploads nothing; the result stays in the browser.
function SessionSummary({ result, measurements, onDiscard, onSaved, saved = false }: Props) {
	const [showReport, setShowReport] = useState(false);
	const [bundling, setBundling] = useState(false);
	const [bundleError, setBundleError] = useState(false);
	const [bundleNote, setBundleNote] = useState("");
	// Closing the summary throws the recording away, so both routes to it
	// (the X and the Discard link) ask once first.
	const [confirmingDiscard, setConfirmingDiscard] = useState(false);
	const keepRef = useRef<HTMLButtonElement>(null);
	const discardRef = useRef<HTMLButtonElement>(null);
	const openReportRef = useRef<HTMLButtonElement>(null);
	const wasConfirming = useRef(false);
	const askId = useId();
	// A saved session closes straight away; an unsaved one asks first.
	const requestClose = () => (saved ? onDiscard() : setConfirmingDiscard(true));
	// Both views render into the same backdrop node, so one focus trap covers
	// them. Escape backs out of the report preview or the discard question;
	// on the summary itself it would mean discarding the recording, which
	// stays an explicit click.
	const backdropRef = useRef<HTMLDivElement>(null);
	useDialogFocus(true, backdropRef, {
		onEscape: showReport
			? () => setShowReport(false)
			: confirmingDiscard
				? () => setConfirmingDiscard(false)
				: undefined,
	});
	// A download made while the question is up (the bundle button stays on screen, and the
	// report can be opened and downloaded from) saves the session, so the question about
	// throwing it away no longer holds and the footer goes back to Close.
	useEffect(() => {
		if (saved) setConfirmingDiscard(false);
	}, [saved]);
	useEffect(() => {
		// The button that was pressed unmounts as the question swaps in (and back).
		// Focus may scroll: the X sits at the top of a card that scrolls on a
		// short screen, and the question is at the bottom.
		// A download that saved the session also closes the question, but the
		// Download button it was made from stays mounted, so focus stays there.
		if (confirmingDiscard) keepRef.current?.focus();
		else if (wasConfirming.current && (!document.activeElement || document.activeElement === document.body)) {
			discardRef.current?.focus();
		}
		wasConfirming.current = confirmingDiscard;
	}, [confirmingDiscard]);

	// Switching views unmounts the focused button; put focus on the new view.
	const viewSwitched = useRef(false);
	useEffect(() => {
		if (!viewSwitched.current) {
			viewSwitched.current = true;
			return;
		}
		// Coming back from the report, the button that opened it gets focus again.
		if (!showReport && openReportRef.current) {
			openReportRef.current.focus({ preventScroll: true });
			return;
		}
		const root = backdropRef.current;
		if (root) focusableWithin(root)[0]?.focus({ preventScroll: true });
	}, [showReport]);

	const reportInput: ReportInput = useMemo(
		() => ({
			caseId: result.caseId,
			startedAt: result.startedAt,
			durationMs: result.durationMs,
			events: result.events,
			shots: result.shots,
			transcript: result.transcript,
			measurements,
			hasAudio: result.audio != null,
		}),
		[result, measurements]
	);
	const reportHtml = useMemo(() => (showReport ? buildReportHtml(reportInput) : ""), [showReport, reportInput]);

	const audioUrl = useMemo(
		() => (result.audio ? URL.createObjectURL(result.audio) : null),
		[result.audio]
	);
	useEffect(() => {
		return () => {
			if (audioUrl) URL.revokeObjectURL(audioUrl);
		};
	}, [audioUrl]);

	const downloadBundle = async () => {
		// aria-disabled, not disabled, so the focused button keeps focus while it zips.
		if (bundling) return;
		setBundling(true);
		setBundleError(false);
		setBundleNote("Zipping the session bundle");
		try {
			const blob = await buildSessionBundle(result, measurements);
			downloadBlob(blob, `${caseFileSlug(result.caseId)}_reading-session.zip`);
			setBundleNote("Session bundle downloaded");
			onSaved?.();
		} catch (err) {
			console.error("Session bundle failed", err);
			setBundleError(true);
			setBundleNote("");
		} finally {
			setBundling(false);
		}
	};

	if (showReport) {
		return (
			<div ref={backdropRef} className="vp-session-backdrop" role="dialog" aria-modal="true" aria-label="Draft reading report">
				<div className="vp-report">
					<div className="vp-report__bar">
						<span className="vp-report__title">Draft report for {caseDisplayName(result.caseId)}</span>
						<div className="vp-report__actions">
							<button
								type="button"
								className="vp-session__btn"
								aria-label="Download HTML"
								onClick={() => {
									downloadText(reportHtml, `${caseFileSlug(result.caseId)}_report.html`, "text/html");
									onSaved?.();
								}}
							>
								<IconDownload size={15} /> HTML
							</button>
							<button
								type="button"
								className="vp-session__btn"
								aria-label="Download Markdown"
								onClick={() => {
									downloadText(buildReportMarkdown(reportInput), `${caseFileSlug(result.caseId)}_report.md`, "text/markdown");
									onSaved?.();
								}}
							>
								<IconDownload size={15} /> Markdown
							</button>
							<button type="button" className="vp-session__close" onClick={() => setShowReport(false)} aria-label="Back to session summary">
								×
							</button>
						</div>
					</div>
					<iframe
						className="vp-report__frame"
						title="Draft reading report"
						srcDoc={reportHtml}
						// Keys pressed inside the frame never reach the dialog's own listener,
						// so Escape is forwarded from the frame's window (it goes with the frame),
						// and so is a forward Tab off the end of the frame: it wraps to the first
						// control, since the browser would step out of the dialog instead.
						onLoad={(e) => {
							const frame = e.currentTarget;
							frame.contentWindow?.addEventListener("keydown", (ev) => {
								if (ev.key === "Escape") setShowReport(false);
								else if (ev.key === "Tab" && !ev.shiftKey) {
									const doc = frame.contentDocument;
									const inner = doc ? Array.from(doc.querySelectorAll("a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])")) : [];
									if (inner.length > 0 && doc?.activeElement !== inner[inner.length - 1]) return;
									const root = backdropRef.current;
									if (!root) return;
									ev.preventDefault();
									focusableWithin(root)[0]?.focus({ preventScroll: true });
								}
							});
						}}
					/>
				</div>
			</div>
		);
	}

	return (
		<div ref={backdropRef} className="vp-session-backdrop" role="dialog" aria-modal="true" aria-label="Reading session captured">
			<div className="vp-session">
				<div className="vp-session__head">
					<span className="vp-session__micbadge">
						<IconMicrophone size={18} />
					</span>
					<div className="vp-session__headtext">
						<div className="vp-session__title">Reading session captured</div>
						<div className="vp-session__sub">
							{formatClock(result.durationMs)} · {countLabel(result.events.length, "event")} · {countLabel(result.shots.length, "key image")}
							{result.transcript.length > 0 && <> · {countLabel(result.transcript.length, "dictation segment")}</>}
						</div>
					</div>
					<button type="button" className="vp-session__close" onClick={requestClose} aria-label={saved ? "Close summary" : "Close and discard session"}>
						×
					</button>
				</div>

				{result.micLostAtMs != null && (
					<div className="vp-session__noaudio" role="note">
						The microphone stopped at {formatClock(result.micLostAtMs)}, so the narration after that is not recorded.
					</div>
				)}
				{audioUrl ? (
					<audio
						className="vp-session__audio"
						controls
						src={audioUrl}
						aria-label="Session narration"
						onLoadedMetadata={fixRecorderDuration}
					/>
				) : (
					<div className="vp-session__noaudio">
						No narration audio was recorded{result.micGranted ? "." : " (microphone unavailable or denied)."}
					</div>
				)}

				{result.transcript.length > 0 && (
					<div className="vp-session__transcript">
						{result.transcript.slice(0, 3).map((seg, i) => (
							<div key={i}>
								<span className="vp-session__t">[{formatClock(seg.t)}]</span> {seg.text}
							</div>
						))}
						{result.transcript.length > 3 && (
							<div className="vp-session__more">…and {result.transcript.length - 3} more in the report</div>
						)}
					</div>
				)}

				<div className="vp-session__actions">
					<button
						ref={openReportRef}
						type="button"
						className="vp-session__btn vp-session__btn--primary"
						onClick={() => setShowReport(true)}
					>
						<IconFileText size={16} /> Open draft report
					</button>
					<button type="button" className="vp-session__btn" onClick={downloadBundle} aria-disabled={bundling || undefined}>
						<IconPackage size={16} /> {bundling ? "Zipping…" : "Download session bundle"}
					</button>
				</div>
				<span className="sr-only" role="status">{bundleNote}</span>
				<p className="vp-session__note">
					The bundle has {audioUrl ? "the audio, " : ""}the event timeline, key images and the draft report.
				</p>
				{bundleError && (
					<p className="vp-session__note" role="alert">
						Could not build the bundle. Try again, or open the draft report and download it instead.
					</p>
				)}

				<div className="vp-session__foot">
					{confirmingDiscard ? (
						<>
							<span className="vp-session__ask" id={askId}>Discard this recording? It cannot be brought back.</span>
							<button ref={keepRef} type="button" className="vp-session__btn" aria-describedby={askId} onClick={() => setConfirmingDiscard(false)}>
								Keep
							</button>
							<button type="button" className="vp-session__btn vp-session__btn--danger" aria-describedby={askId} onClick={onDiscard}>
								Discard
							</button>
						</>
					) : (
						<button ref={discardRef} type="button" className="vp-session__discard" onClick={requestClose}>
							{saved ? "Close" : "Discard session"}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

export default SessionSummary;
