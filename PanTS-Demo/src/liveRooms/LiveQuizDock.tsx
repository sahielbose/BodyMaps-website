import { IconCheck, IconClock, IconCloudDownload, IconCrown, IconFileTypePdf, IconMessage, IconPlayerPlay, IconTrophy, IconUsersGroup, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { nameInitial, refocusComposer, submitOnEnter, useRoomExport, useSendOnce } from "./composerHelpers";
import type { LiveQuizConsistency, LiveRoomController } from "./types";
import { rejoinHint } from "./useLiveRoom";


function formatTimer(deadline: string | null, pausedSeconds: number | null, now: number): string {
	if (!deadline) return pausedSeconds == null ? "Untimed" : `${Math.max(0, Math.ceil(pausedSeconds))}s`;
	return `${Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000))}s`;
}

/** The backend's chain-consistency status, as a plain phrase for the own leaderboard row. */
const CONSISTENCY_LABEL: Record<LiveQuizConsistency["status"], string> = {
	consistent: "Linked answers agree",
	inconsistent: "Linked answers conflict",
	incomplete: "More questions to go",
};

/** "incomplete" after the race means questions were left unanswered, not still to come. */
const consistencyLabel = (status: LiveQuizConsistency["status"], completed: boolean) =>
	completed && status === "incomplete" ? "Some questions unanswered" : CONSISTENCY_LABEL[status];

/** How long after the user's own step a phase change still counts as its result. */
const REFOCUS_WINDOW_MS = 3000;

/** The unsent chat text. The page holds it (see useDockDrafts) because the chat
 *  unmounts whenever a question opens and the whole dock unmounts when closed. */
type ChatDraft = { chat: string; setChat: Dispatch<SetStateAction<string>> };

function QuizChat({ room, offline, message, setMessage }: { room: LiveRoomController; offline: boolean; message: string; setMessage: Dispatch<SetStateAction<string>> }) {
	const send = useSendOnce();
	const listRef = useRef<HTMLDivElement>(null);
	// Keyed on the newest id as well as the length: the room keeps only the last
	// 500 messages, so the length stops changing once it is full.
	// A reader who has scrolled up keeps their place: new messages follow only from
	// near the bottom, or when they are the reader's own.
	const lastChat = room.state.chat[room.state.chat.length - 1];
	const lastChatId = lastChat?.id;
	const lastChatOwn = lastChat?.author === room.name;
	const atBottom = useRef(true);
	useEffect(() => {
		const list = listRef.current;
		if (list && (atBottom.current || lastChatOwn)) list.scrollTop = list.scrollHeight;
		// lastChatOwn comes from the same message as lastChatId.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [room.state.chat.length, lastChatId]);
	return (
		<section className="lr-quiz-chat" aria-label="Room chat">
			<div className="lr-quiz-section-title"><IconMessage size={15} /> Room chat</div>
			<div ref={listRef} className="lr-chat-list" aria-live="polite" onScroll={(event) => {
				const list = event.currentTarget;
				atBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
			}}>
				{room.state.chat.length === 0 ? <div className="lr-empty">No messages yet.</div> : room.state.chat.slice(-30).map((item) => (
					<article className="lr-message" key={item.id}>
						<div><strong>{item.author}</strong>{item.timestamp && <time>{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div>
						<p>{item.text}</p>
					</article>
				))}
			</div>
			<form className="lr-chat-compose" onSubmit={async (event) => {
				event.preventDefault();
				if (!message.trim()) return;
				const sent = message.trim();
				// The field stays editable while the message is in flight; clear it only if nothing new was typed.
				if (await send.run(() => room.sendChat(sent))) setMessage((current) => current.trim() === sent ? "" : current);
				refocusComposer("lr-quiz-chat");
			}}>
				<label htmlFor="lr-quiz-chat">Room message</label>
				<textarea id="lr-quiz-chat" maxLength={2000} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={submitOnEnter} disabled={offline} placeholder={room.connectionState === "reconnecting" ? "Reconnecting…" : "Message everyone…"} />
				<button disabled={!message.trim() || offline || send.sending}>Send</button>
			</form>
		</section>
	);
}

export default function LiveQuizDock({ room, onClose, drafts }: { room: LiveRoomController; onClose: () => void; drafts?: ChatDraft }) {
	const quiz = room.quiz;
	const [ownChat, setOwnChat] = useState("");
	const chatDraft = drafts ?? { chat: ownChat, setChat: setOwnChat };
	const bodyRef = useRef<HTMLDivElement>(null);
	// Set by the host's step buttons and by answering. Each of them unmounts (or
	// disables) the very button that was focused, which drops focus to the page
	// body, so the next phase's heading takes it once the step has landed. The
	// frame is sent before the server agrees, so a rejected step must not leave
	// the claim open: it lapses, and a later phase change caused by someone else
	// leaves focus alone.
	const refocusUntil = useRef(0);
	const claimFocus = () => {
		refocusUntil.current = Date.now() + REFOCUS_WINDOW_MS;
	};
	const step = (action: () => boolean) => () => {
		if (action()) claimFocus();
	};
	const [now, setNow] = useState(Date.now());
	const [pendingChoice, setPendingChoice] = useState<string | null>(null);
	const roomExport = useRoomExport(room.downloadExport);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(timer);
	}, []);
	useEffect(() => setPendingChoice(null), [quiz?.current_question?.id]);
	useEffect(() => {
		if (room.error) setPendingChoice(null);
	}, [room.error]);
	// A frame sent just before a drop may never have been recorded; the reconnect's
	// quiz.personal is the truth about what was locked, so the local guess goes.
	useEffect(() => {
		if (room.connectionState !== "connected") setPendingChoice(null);
	}, [room.connectionState]);

	// The body is one scroll container that stays mounted while its children change
	// from phase to phase, so a viewer who had scrolled down to the leaderboard or
	// chat would land below the next question. A claimed step brings its own
	// heading into view through the focus below, so only the others reset here.
	useEffect(() => {
		const body = bodyRef.current;
		if (body && Date.now() > refocusUntil.current) body.scrollTop = 0;
	}, [quiz?.phase, quiz?.question_index]);

	// The last control inside the dock that took focus. When a phase swaps the
	// section it sat in (the question's heading or a choice, replaced by the
	// result), the browser drops focus to the page body without any step of this
	// viewer's own, so a keyboard viewer who had already answered would restart
	// from the top of the page. Losing focus that way hands it to the new heading.
	// A blur from a node still in the page (a click on the scan, a heading left on
	// purpose) is the viewer's own move and is forgotten; only a removed node counts.
	const lastFocused = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const claimed = Date.now() <= refocusUntil.current;
		const lost = lastFocused.current && !lastFocused.current.isConnected
			&& (!document.activeElement || document.activeElement === document.body);
		if (!claimed && !lost) return;
		const heading = bodyRef.current?.querySelector<HTMLElement>("[data-lr-quiz-focus]");
		if (!heading) return;
		refocusUntil.current = 0;
		lastFocused.current = null;
		heading.focus();
	}, [quiz?.phase, quiz?.question_index, pendingChoice]);

	if (!quiz) return <aside id="lr-dock" className="lr-dock lr-quiz-dock" aria-label="Live quiz"><div className="lr-empty">Loading quiz…</div></aside>;
	// answerQuiz, closeQuiz, revealQuiz, advanceQuiz and chat all refuse to send
	// unless the socket is connected, so the controls pause instead of no-oping.
	const offline = room.connectionState !== "connected";
	// One notice while offline. The socket's own error text ("Connection lost.
	// Reconnecting…") says the same thing, so only a stopped connection lets the
	// server's reason (another tab took over, a fatal error) replace the fallback.
	// The reason is followed by the next step, as in the review dock; server reasons
	// arrive with or without a full stop, so add one first. An expired room has its
	// own overlay, so its reason stands alone.
	const stoppedReason = room.error || "Connection lost.";
	const offlineNotice = ["connecting", "reconnecting"].includes(room.connectionState)
		? "Reconnecting. Answers and host controls are paused."
		: room.connectionState === "expired" && room.error
			? room.error
			: `${/[.!?…]$/.test(stoppedReason) ? stoppedReason : `${stoppedReason}.`}${rejoinHint(stoppedReason)}`;
	const question = quiz.current_question;
	const ownSubmission = question ? room.quizOwnSubmissions[question.id] : undefined;
	const submittedChoice = ownSubmission?.choice_id ?? pendingChoice;
	const chatAllowed = ["lobby", "question_revealed", "completed"].includes(quiz.phase);
	const totalRevealed = quiz.reveal ? Object.values(quiz.reveal.distribution).reduce((sum, count) => sum + count, 0) : 0;
	// The pause has its own visible banner below, which is the status region for it.
	const statusText = quiz.phase === "question_open"
		? `Question ${quiz.question_index + 1} open. ${quiz.response_count} of ${quiz.eligible_count} answered.`
		: quiz.phase.replaceAll("_", " ");
	const personalCorrect = Boolean(ownSubmission && quiz.reveal && ownSubmission.choice_id === quiz.reveal.correct_choice_id);
	// The counts belong to a question; the lobby has none yet and the finished race has no current one.
	const answerCountShown = ["question_open", "question_closed", "question_revealed"].includes(quiz.phase);
	const timerLength = room.metadata.quiz_timer_seconds ?? null;
	const selfRow = quiz.leaderboard.find((item) => item.participant_id === room.participantId);
	const exportsAvailable = quiz.phase === "completed" || (
		quiz.phase === "question_revealed" && quiz.question_index + 1 === quiz.question_count
	);

	return (
		<aside id="lr-dock" className="lr-dock lr-quiz-dock" aria-label="Live quiz">
			<div className="lr-dock__head lr-quiz-dock__head">
				<div>
					<span className="lr-eyebrow">Individual race · Case {room.metadata.case_id}</span>
					<strong>{room.isHost ? <><IconCrown size={15} /> You are host</> : "Private answer room"}</strong>
				</div>
				<button className="lr-dock__close" onClick={onClose} aria-label="Close quiz panel"><IconX size={18} /></button>
			</div>

			{/* Only the status sentence is live: it changes when someone answers or
			    the phase moves (a closed question is the time-up moment). The
			    countdown is a timer, which is never live; inside the old atomic
			    region it re-read the whole block every second. */}
			<div className="lr-quiz-status">
				{quiz.phase === "lobby"
					? <span><IconClock size={16} /> {quiz.remaining_seconds == null ? "Untimed" : `${Math.max(0, Math.ceil(quiz.remaining_seconds))} ${Math.ceil(quiz.remaining_seconds) === 1 ? "second" : "seconds"} per question`}</span>
					: quiz.phase === "question_open"
						? <span role="timer"><IconClock size={16} /> {formatTimer(quiz.deadline_at, quiz.remaining_seconds, now + (room.clockOffsetMs ?? 0))}</span>
						// The server zeroes remaining_seconds when a question closes, so only an open question has a countdown to read.
						: <span><IconClock size={16} /> {quiz.phase === "question_closed" ? "Closed" : timerLength == null ? "Untimed" : `${timerLength} ${timerLength === 1 ? "second" : "seconds"} per question`}</span>}
				{answerCountShown && <span>{quiz.response_count}/{quiz.eligible_count} answered</span>}
				<span className="sr-only" role="status">{statusText}</span>
			</div>
			{offline && <div className="lr-banner lr-banner--warning" role="status">{offlineNotice}</div>}
			{quiz.timer_paused && <div className="lr-banner lr-banner--warning" role="status">Timer paused while the host reconnects. Answers resume when they are back.</div>}
			{!offline && room.error && <div className="lr-error lr-quiz-error" role="alert">{room.error}</div>}
			{/* The header hides this notice while the panel is open, so an undo result or refusal is shown here. */}
			{room.undoNotice && <div className="lr-banner" role="status">{room.undoNotice}</div>}

			<div
				ref={bodyRef}
				className="lr-dock__body lr-quiz-body"
				onFocus={(event) => { lastFocused.current = event.target; }}
				onBlur={(event) => { if (event.relatedTarget || event.target.isConnected) lastFocused.current = null; }}
			>
				{quiz.phase === "lobby" && (
					<section className="lr-quiz-lobby">
						<div className="lr-quiz-mark"><IconTrophy size={25} /></div>
						<h2 tabIndex={-1} data-lr-quiz-focus>{quiz.question_count} linked questions</h2>
						<p>One point per correct answer. Ties use total response time; logical consistency is reported separately.</p>
						{room.isHost ? (
							<button className="lr-button lr-button--primary lr-button--wide" onClick={step(room.startQuiz)} disabled={offline}>
								<IconPlayerPlay size={17} /> Start race
							</button>
						) : <div className="lr-banner">Waiting for the host to start.</div>}
					</section>
				)}

				{question && ["question_open", "question_closed"].includes(quiz.phase) && (
					<section className="lr-quiz-question">
						<div className="lr-quiz-kicker">Question {quiz.question_index + 1} of {quiz.question_count}</div>
						<h2 tabIndex={-1} data-lr-quiz-focus>{question.prompt}</h2>
						{quiz.phase === "question_open" && !room.isHost && !room.quizEligible && (
							<div className="lr-banner">You joined during this question. Observe now; you become eligible on the next one.</div>
						)}
						<fieldset className="lr-quiz-choices" disabled={quiz.phase !== "question_open" || room.isHost || !room.quizEligible || Boolean(ownSubmission || pendingChoice) || quiz.timer_paused || offline}>
							<legend className="sr-only">Answer choices</legend>
							{question.choices.map((choice, index) => (
								<button
									type="button"
									key={choice.id}
									className={submittedChoice === choice.id ? "is-selected" : ""}
									aria-pressed={submittedChoice === choice.id}
									onClick={() => {
										if (!room.answerQuiz(choice.id)) return;
										claimFocus();
										setPendingChoice(choice.id);
									}}
								>
									<span>{String.fromCharCode(65 + index)}</span>{choice.label}
									{submittedChoice === choice.id && <IconCheck size={17} />}
								</button>
							))}
						</fieldset>
						{ownSubmission && <div className="lr-quiz-locked" role="status"><IconCheck size={16} /> Answer locked privately</div>}
						{room.isHost && quiz.phase === "question_open" && (
							<button className="lr-button lr-button--secondary lr-button--wide" onClick={step(room.closeQuiz)} disabled={offline}>Close question early</button>
						)}
						{room.isHost && quiz.phase === "question_closed" && (
							<button className="lr-button lr-button--primary lr-button--wide" onClick={step(room.revealQuiz)} disabled={offline}>Reveal result</button>
						)}
						{!room.isHost && quiz.phase === "question_closed" && <div className="lr-banner">Question closed. Waiting for the host to reveal.</div>}
					</section>
				)}

				{question && quiz.phase === "question_revealed" && quiz.reveal && (
					<section className="lr-quiz-reveal">
						<div className="lr-quiz-kicker">Result · Question {quiz.question_index + 1}</div>
						<h2 tabIndex={-1} data-lr-quiz-focus>{question.prompt}</h2>
						<div className={`lr-quiz-personal ${ownSubmission ? (personalCorrect ? "is-correct" : "is-incorrect") : ""}`}>
							{room.isHost ? "Host view" : ownSubmission ? (personalCorrect ? "Your answer is correct" : "Your answer is incorrect") : "No answer recorded"}
						</div>
						{quiz.reveal.source_label && <div className="lr-quiz-kicker">{quiz.reveal.source_label}</div>}
						<p className="lr-quiz-explanation">{quiz.reveal.explanation}</p>
						<div className="lr-quiz-distribution" role="list" aria-label="Answer distribution">
							{question.choices.map((choice) => {
								const count = quiz.reveal?.distribution[choice.id] ?? 0;
								const percent = totalRevealed ? Math.round(count / totalRevealed * 100) : 0;
								const correct = choice.id === quiz.reveal?.correct_choice_id;
								return <div key={choice.id} role="listitem" className={correct ? "is-correct" : ""}>
									<span>{choice.label}{correct && <>{" "}<span className="lr-quiz-correct-mark"><IconCheck size={12} aria-hidden="true" /> Correct answer</span></>}</span><strong>{count}</strong>
									<i style={{ width: `${percent}%` }} />
								</div>;
							})}
						</div>
						{room.isHost && <button className="lr-button lr-button--primary lr-button--wide" onClick={step(room.advanceQuiz)} disabled={offline}>
							{quiz.question_index + 1 === quiz.question_count ? "Finish race" : "Next question"}
						</button>}
					</section>
				)}

				{quiz.phase === "completed" && (
					<section className="lr-quiz-complete">
						<div className="lr-quiz-mark"><IconTrophy size={25} /></div>
						<h2 tabIndex={-1} data-lr-quiz-focus>Race complete</h2>
						<p>Create a new room to run another round.</p>
					</section>
				)}

				{quiz.leaderboard.length > 0 && ["question_revealed", "completed"].includes(quiz.phase) && (
					<section className="lr-quiz-leaderboard">
						<div className="lr-quiz-section-title"><IconTrophy size={15} /> Leaderboard</div>
						{quiz.leaderboard.map((row) => <div className={row.participant_id === room.participantId ? "is-self" : ""} key={row.participant_id}>
							<b>#{row.rank}</b><span>{row.name}</span><strong>{row.score}/{row.max_score}</strong><small>{(row.total_response_ms / 1000).toFixed(1)}s{row.participant_id === room.participantId && ` · ${consistencyLabel(row.consistency.status, quiz.phase === "completed")}`}</small>
						</div>)}
						{/* Mid-race "incomplete" only means later questions are not asked yet, which the row label already says. */}
						{selfRow && (selfRow.consistency.status !== "incomplete" || quiz.phase === "completed") && selfRow.consistency.reasons.map((reason) => <p className="lr-quiz-consistency" key={reason}>{reason}</p>)}
					</section>
				)}

				<section className="lr-quiz-people">
					<div className="lr-quiz-section-title"><IconUsersGroup size={15} /> {room.participants.length} connected</div>
					{room.participants.map((participant) => <div key={participant.participant_id}><span className="lr-avatar" style={{ background: participant.color }}>{nameInitial(participant.name)}</span><strong>{participant.name}{participant.participant_id === room.participantId ? " (you)" : ""}</strong><small>{participant.role}</small></div>)}
				</section>

				{chatAllowed && <QuizChat room={room} offline={offline} message={chatDraft.chat} setMessage={chatDraft.setChat} />}
				{!chatAllowed && <div className="lr-banner"><IconMessage size={15} /> Chat and editing return after reveal.</div>}
				{exportsAvailable && <section className="lr-export" aria-label="Quiz exports">
					<button onClick={() => void roomExport.run("zip")} disabled={roomExport.exporting !== null} aria-busy={roomExport.exporting === "zip"}><IconCloudDownload size={16} /> {roomExport.exporting === "zip" ? "Exporting…" : "Export quiz ZIP"}</button>
					<button onClick={() => void roomExport.run("pdf")} disabled={roomExport.exporting !== null} aria-busy={roomExport.exporting === "pdf"}><IconFileTypePdf size={16} /> {roomExport.exporting === "pdf" ? "Exporting…" : "PDF"}</button>
					{roomExport.error && <div className="lr-error" role="alert">{roomExport.error}</div>}
					<small>For research and education use only. Room deletes after 24 hours.</small>
				</section>}
			</div>
		</aside>
	);
}
