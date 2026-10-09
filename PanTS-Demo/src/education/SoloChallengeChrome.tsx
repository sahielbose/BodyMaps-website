import {
	IconCheck,
	IconClock,
	IconCrosshair,
	IconMessageCircle,
	IconRefresh,
	IconRulerMeasure,
	IconSend,
	IconSparkles,
	IconTargetArrow,
	IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "../helpers/constants";
import type { MeasurementSummary, SharedMeasurement } from "../helpers/CornerstoneNifti2";
import { submitOnEnter } from "../liveRooms/composerHelpers";
import { appRootRelativeUrl } from "../liveRooms/protocol";
import type { SoloChallengeController, SoloChallengeTutor, SoloChallengeTutorMessage } from "./types";

function clock(seconds: number): string {
	const minutes = Math.floor(seconds / 60);
	return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

// Attempts whose challenge screen has gone (a new attempt replaced them, or the
// learner left). A tutor reply still on its way for one of them is dropped: the
// chat belongs to the page, so it would otherwise land in the next attempt's chat.
const endedAttempts = new Set<string>();

// The header toggle that reopens the dock; closing the dock hands focus to it.
const TASK_TOGGLE_ID = "edu-task-toggle";

export function SoloChallengeHeader({ controller }: { controller: SoloChallengeController }) {
	const attemptId = controller.attempt.attempt_id;
	// The header lasts as long as the attempt's screen (the dock comes and goes),
	// so its unmount is what marks the attempt as over.
	useEffect(() => {
		endedAttempts.delete(attemptId);
		return () => { endedAttempts.add(attemptId); };
	}, [attemptId]);
	const urgent = controller.remainingSeconds <= 60 && !controller.result;
	// The clock is a timer (never live), or a screen reader would read it out
	// every second. Only the last minute and time up are announced, once each,
	// from a separate status line whose text changes just at those moments.
	const announcement = controller.result
		? ""
		: controller.remainingSeconds === 0 ? "Time is up." : urgent ? "One minute remaining." : "";
	return (
		<header className="edu-header">
			<div className="edu-header__identity">
				<span className="edu-header__index">01</span>
				<div><strong>Solo challenge</strong><span>Case {controller.challenge.case_id} · Pancreas CT</span></div>
			</div>
			<div className="edu-header__prompt">Find · measure · interpret</div>
			<div className="edu-header__actions">
				<div className={`edu-timer ${urgent ? "is-urgent" : ""}`} role="timer">
					<IconClock size={17} />
					<strong>{controller.result ? clock(controller.result.elapsed_seconds) : clock(controller.remainingSeconds)}</strong>
					<span>{controller.result ? "elapsed" : "remaining"}</span>
				</div>
				<span className="sr-only" role="status">{announcement}</span>
				<button type="button" id={TASK_TOGGLE_ID} onClick={() => controller.setTaskDockOpen(!controller.taskDockOpen)} aria-expanded={controller.taskDockOpen}>
					<IconTargetArrow size={18} /> {controller.result ? "Results" : "Task"}
				</button>
			</div>
		</header>
	);
}

export function SoloChallengeDock({
	controller,
	crosshair,
	measurement,
	serializedMeasurement,
	onSetMarker,
	onActivateMeasure,
	onSubmit,
}: {
	controller: SoloChallengeController;
	crosshair: [number, number, number] | null;
	measurement: MeasurementSummary | null;
	serializedMeasurement: SharedMeasurement | null;
	onSetMarker: () => void;
	onActivateMeasure: () => void;
	onSubmit: () => void;
}) {
	const abnormalChoice = controller.findingChoice && controller.findingChoice !== "no_focal_lesion";
	// Once time is up a submit is accepted as it stands, so an incomplete form cannot strand the learner.
	const timedOut = controller.remainingSeconds === 0;
	const ready = Boolean(
		controller.findingChoice
		&& controller.impression.trim()
		&& (!abnormalChoice || controller.marker && serializedMeasurement),
	);
	// Submitting swaps the form (and the focused Submit button) for the results, so
	// focus moves to the results heading, which also announces them. A dock that
	// opens already holding a result (a restored session) leaves focus alone.
	const headingRef = useRef<HTMLElement>(null);
	const hadResult = useRef(Boolean(controller.result));
	useEffect(() => {
		if (controller.result && !hadResult.current) headingRef.current?.focus();
		hadResult.current = Boolean(controller.result);
	}, [controller.result]);
	// Submit is disabled while grading, which drops its focus to the page body. A
	// submit that fails leaves the form in place, so focus goes back to the button
	// for a retry; a success moves it to the results heading above instead.
	const submitRef = useRef<HTMLButtonElement>(null);
	const claimSubmitFocus = useRef(false);
	useEffect(() => {
		if (controller.submitting || !claimSubmitFocus.current) return;
		claimSubmitFocus.current = false;
		// Only when focus was dropped, so a reader who moved on is left where they are.
		const active = document.activeElement;
		if (!controller.result && (!active || active === document.body)) submitRef.current?.focus();
	}, [controller.submitting, controller.result]);
	// The dock unmounts on close, which would drop focus to the page body.
	const closeDock = () => {
		document.getElementById(TASK_TOGGLE_ID)?.focus();
		controller.setTaskDockOpen(false);
	};
	return (
		<aside className="edu-dock" aria-label={controller.result ? "Challenge results" : "Solo challenge task"}>
			<div className="edu-dock__head">
				<div><span className="edu-kicker">{controller.result ? "Attempt complete" : controller.challenge.eyebrow}</span><strong ref={headingRef} tabIndex={-1}>{controller.result ? "Review your result" : controller.challenge.title}</strong></div>
				<button type="button" aria-label="Close task panel" onClick={closeDock}><IconX size={18} /></button>
			</div>
			{controller.result ? <ChallengeResult controller={controller} /> : (
				<div className="edu-dock__body">
					<p className="edu-task-prompt">{controller.challenge.prompt}</p>
					<section className="edu-task-section">
						<div className="edu-task-section__label"><span>01</span><strong id="edu-finding-label">Classify the finding</strong></div>
						<div className="edu-findings" role="radiogroup" aria-labelledby="edu-finding-label">
							{controller.challenge.finding_choices.map((choice) => (
								<label key={choice.id} className={controller.findingChoice === choice.id ? "is-selected" : ""}>
									<input type="radio" name="finding" checked={controller.findingChoice === choice.id} onChange={() => controller.setFindingChoice(choice.id)} />
									<span>{choice.label}</span>
								</label>
							))}
						</div>
					</section>
					<section className="edu-task-section">
						<div className="edu-task-section__label"><span>02</span><strong>Place the 3D marker</strong>{controller.marker && <IconCheck size={16} />}</div>
						<p>Move the crosshair to the center of the finding, then lock that position.</p>
						<button type="button" className="edu-secondary-action" disabled={!crosshair} onClick={onSetMarker}>
							<IconCrosshair size={17} /> {controller.marker ? "Update finding marker" : "Set finding marker"}
						</button>
						{controller.marker && <code>{controller.marker.map((value) => Math.round(value)).join(", ")} mm</code>}
					</section>
					<section className="edu-task-section">
						<div className="edu-task-section__label"><span>03</span><strong>Measure the abnormal area</strong>{measurement && <IconCheck size={16} />}</div>
						<p>In the axial (top-down) CT view, draw a line across the widest part of the abnormal area. This records its size in millimeters.</p>
						<button type="button" className="edu-secondary-action" onClick={onActivateMeasure}><IconRulerMeasure size={17} /> Start measuring</button>
						{measurement && <code>{measurement.value}</code>}
					</section>
					<section className="edu-task-section">
						<label htmlFor="edu-impression"><span>04</span><strong>Radiology impression</strong></label>
						<textarea id="edu-impression" value={controller.impression} maxLength={2000} onChange={(event) => controller.setImpression(event.target.value)} placeholder="Write a concise finding, location, supporting observation, and calibrated conclusion…" />
						<small>{controller.impression.length}/2000</small>
					</section>
					{controller.error && <div className="edu-error" role="alert">{controller.error}</div>}
					{controller.deadlineMissed ? (
						<button type="button" className="edu-submit" onClick={() => controller.startOver?.()}>
							Start a new attempt <IconRefresh size={17} />
						</button>
					) : (
						<>
							<button ref={submitRef} type="button" className="edu-submit" disabled={(!ready && !timedOut) || controller.submitting} onClick={() => { claimSubmitFocus.current = true; onSubmit(); }}>
								{controller.submitting ? "Grading attempt…" : "Submit interpretation"} <IconSend size={17} />
							</button>
							<small className="edu-submit-note">Submission is final. BodyMaps AI remains locked until this attempt ends.</small>
						</>
					)}
				</div>
			)}
		</aside>
	);
}

const TUTOR_FAILED_TEXT = "Could not reach the tutor. Your question is still in the box, try again. You can also review the revealed overlay and the teaching points above.";

function ChallengeResult({ controller }: { controller: SoloChallengeController }) {
	const result = controller.result!;
	// The page holds the chat so it survives the panel closing; a bare controller
	// (no page above it) falls back to state of its own.
	const [localQuestion, setLocalQuestion] = useState("");
	const [localMessages, setLocalMessages] = useState<SoloChallengeTutorMessage[]>([]);
	const [localSending, setLocalSending] = useState(false);
	const tutor: SoloChallengeTutor = controller.tutor ?? {
		question: localQuestion,
		setQuestion: setLocalQuestion,
		messages: localMessages,
		setMessages: setLocalMessages,
		sending: localSending,
		setSending: setLocalSending,
	};
	const { question, setQuestion, messages, setMessages, sending, setSending } = tutor;
	const tutorUnavailable = result.status === "provisional";
	// Sending disables the textarea and the send button, which drops the focus the
	// learner had; once the reply is in, put it back so a follow-up can be typed.
	const questionRef = useRef<HTMLTextAreaElement>(null);
	const wasSending = useRef(false);
	useEffect(() => {
		if (wasSending.current && !sending) {
			// Only when focus was lost (or sits on the now idle send button), so a
			// reader who moved on elsewhere is left where they are.
			const active = document.activeElement;
			const form = questionRef.current?.form;
			if (!active || active === document.body || form?.contains(active)) questionRef.current?.focus();
		}
		wasSending.current = sending;
	}, [sending]);
	const scoreRows = useMemo(() => [
		["Localization", result.scores.localization.points, 35],
		["Measurement", result.scores.measurement.points, 15],
		["Finding", result.scores.finding.points, 10],
		["Impression", result.ai_grade.points, 40],
	] as const, [result]);

	const send = async () => {
		const text = question.trim();
		if (!text || sending) return;
		const attemptId = controller.attempt.attempt_id;
		const asked: SoloChallengeTutorMessage = { role: "student", text };
		setQuestion("");
		// A new send replaces any earlier failure line, so the log never says the
		// question is still in the box once it has gone out again.
		setMessages((current) => [...current.filter((message) => message.text !== TUTOR_FAILED_TEXT), asked]);
		setSending(true);
		try {
			const response = await fetch(`${API_BASE}/api/education/attempts/${attemptId}/tutor`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Attempt-Key": controller.attempt.attempt_key },
				body: JSON.stringify({ message: text, history: messages.filter((message) => message.text !== TUTOR_FAILED_TEXT).slice(-6) }),
			});
			const body = await response.json();
			if (!response.ok) throw new Error(body.error || "Tutor unavailable");
			if (endedAttempts.has(attemptId)) return;
			setMessages((current) => [...current, { role: "tutor", text: body.reply }]);
		} catch {
			if (endedAttempts.has(attemptId)) return;
			// The question goes back in the box to retry; its log line comes out so a retry does not repeat it.
			setQuestion(text);
			setMessages((current) => [...current.filter((message) => message !== asked), { role: "tutor", text: TUTOR_FAILED_TEXT }]);
		} finally {
			// A discarded attempt's late answer must not clear the new attempt's pending state.
			if (!endedAttempts.has(attemptId)) setSending(false);
		}
	};

	return (
		<div className="edu-result">
			<div className="edu-result__score">
				<div><strong>{result.total_points === null ? `${result.objective_points}` : result.total_points}</strong><span>/{result.total_points === null ? "60" : "100"}</span></div>
				<p>{result.status === "provisional" ? "Objective score · AI grade pending" : "Final accuracy score"}</p>
			</div>
			<div className="edu-score-list">
				{scoreRows.map(([label, points, maximum]) => (
					<div key={label}><span>{label}</span><div><i style={{ width: `${((points ?? 0) / maximum) * 100}%` }} /></div><strong>{typeof points === "number" ? `${points}/${maximum}` : "Pending"}</strong></div>
				))}
			</div>
			<section className="edu-result__truth">
				<span className="edu-kicker">Correct answer</span>
				<h3>{result.ground_truth.correct_finding_label}</h3>
				{controller.revealError && <div className="edu-error" role="alert">{controller.revealError}</div>}
				<div className="edu-truth-facts">
					<div><span>Location</span><strong>{result.ground_truth.location}</strong></div>
					<div><span>Widest size</span><strong>{result.ground_truth.reference_diameter_mm} mm</strong></div>
				</div>
				<h4>What to remember</h4>
				<ul>{result.ground_truth.teaching_points.map((point) => <li key={point}>{point}</li>)}</ul>
			</section>
			<section className="edu-result__feedback">
				<div><IconSparkles size={18} /><strong>BodyMaps AI rubric</strong></div>
				<p>{result.ai_grade.feedback || "AI grading is temporarily unavailable. Your objective result is preserved as provisional."}</p>
				{result.ai_grade.criteria && <div className="edu-rubric">{Object.entries(result.ai_grade.criteria).map(([criterion, points]) => <span key={criterion}><strong>{points}/10</strong>{criterion}</span>)}</div>}
				{result.status === "provisional" && (
					<button type="button" className="edu-retry" onClick={() => void controller.retryGrade()} disabled={controller.retryingGrade}>
						<IconRefresh size={15} /> {controller.retryingGrade ? "Retrying AI grade…" : "Retry AI grade"}
					</button>
				)}
				{controller.error && <div className="edu-error" role="alert">{controller.error}</div>}
			</section>
			<section className="edu-tutor">
				<div><IconMessageCircle size={18} /><strong>Discuss this case</strong></div>
				{/* A log that stays mounted, so each reply is announced when it lands; the
				    pending status below is removed again once the reply arrives. */}
				<div className="edu-tutor__log" role="log" aria-label="Conversation with the AI tutor">
					{messages.map((message, index) => (
						<p key={`${message.role}-${index}`} data-role={message.role}>
							<span className="sr-only">{message.role === "student" ? "You: " : "Tutor: "}</span>{message.text}
						</p>
					))}
				</div>
				{sending && (
					<p className="edu-tutor__pending" data-role="tutor" role="status" aria-label="AI tutor is thinking">
						<span aria-hidden="true"><i /><i /><i /></span>
					</p>
				)}
				<form onSubmit={(event) => { event.preventDefault(); void send(); }}>
					<textarea
						ref={questionRef}
						value={question}
						onChange={(event) => setQuestion(event.target.value)}
						maxLength={1000}
						onKeyDown={submitOnEnter}
						aria-label="Ask the AI tutor"
						placeholder={tutorUnavailable
							? "AI tutor becomes available after the impression grade is complete."
							: "Ask why the measurement or impression was scored this way…"}
						disabled={tutorUnavailable || sending}
					/>
					<button
						type="submit"
						aria-label="Send question to AI tutor"
						title="Send question"
						disabled={!question.trim() || tutorUnavailable || sending}
					>
						<IconSend size={16} />
					</button>
				</form>
			</section>
			{controller.startOver && (
				<button type="button" className="edu-submit" onClick={() => controller.startOver?.()}>
					Start a new attempt <IconRefresh size={17} />
				</button>
			)}
			<a className="edu-finish" href={appRootRelativeUrl(`/case/${controller.challenge.case_id}`)} onClick={controller.clearSession}>Exit to case {controller.challenge.case_id}</a>
		</div>
	);
}
