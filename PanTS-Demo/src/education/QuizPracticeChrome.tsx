import { IconAlertTriangle, IconArrowLeft, IconArrowRight, IconCheck, IconFlag, IconLayoutSidebarRight, IconTrophy, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { appRootRelativeUrl } from "../liveRooms/protocol";
import type { QuizPracticeController } from "./types";

// The header toggle that reopens the dock; closing the dock hands focus to it.
const QUESTIONS_TOGGLE_ID = "edu-quiz-toggle";

export function QuizPracticeHeader({ controller }: { controller: QuizPracticeController }) {
	const progress = controller.result ? `${controller.result.score}/${controller.result.max_score}` : `${controller.questionIndex + 1}/${controller.pack.questions.length}`;
	return (
		<header className="lr-header edu-quiz-header">
			<div className="lr-header__identity">
				<span className="lr-live-dot" data-state="connected" />
				<div><strong>Quiz practice</strong><span>Case {controller.pack.case_id} · {controller.pack.difficulty}</span></div>
			</div>
			<div className="lr-header__warning">Untimed. Answers are checked when you submit.</div>
			<div className="lr-header__actions">
				<span className="lr-status" data-state="connected">{progress}</span>
				<a className="lr-header-button" href={appRootRelativeUrl(`/case/${controller.pack.case_id}`)} title="Leave practice and open this case in the CT viewer">
					<IconArrowLeft size={18} /> CT viewer
				</a>
				{/* Closed on a phone, this button is the only way in: it carries the
				    progress (the status chip is hidden there) and the accent fill. */}
				<button id={QUESTIONS_TOGGLE_ID} className={`lr-header-button${controller.dockOpen ? "" : " lr-header-button--primary"}`} onClick={() => controller.setDockOpen(!controller.dockOpen)} aria-expanded={controller.dockOpen}>
					<IconLayoutSidebarRight size={18} /> Questions <span className="edu-quiz-progress">{controller.result ? `Score ${progress}` : progress}</span>
				</button>
			</div>
		</header>
	);
}

const CONSISTENCY_TEXT = {
	consistent: "Your answers agree with each other.",
	inconsistent: "Some of your answers contradict each other.",
	incomplete: "Some questions were not answered.",
} as const;

export function QuizPracticeDock({ controller }: { controller: QuizPracticeController }) {
	const question = controller.pack.questions[controller.questionIndex];
	const reveal = controller.result?.reveals.find((item) => item.question_id === question.id);
	// Once graded, the picked choice is the one the server scored, not the local
	// copy, so the verdict can never disagree with the score.
	const selected = controller.result?.answers[question.id] ?? controller.answers[question.id];
	const isLast = controller.questionIndex === controller.pack.questions.length - 1;
	const reviewingLast = isLast && Boolean(controller.result);
	// Submitting removes the focused Submit button, so focus moves to the review
	// heading, which also announces the score. A dock that opens already graded
	// leaves focus alone.
	const headingRef = useRef<HTMLElement>(null);
	const hadResult = useRef(Boolean(controller.result));
	useEffect(() => {
		if (controller.result && !hadResult.current) headingRef.current?.focus();
		hadResult.current = Boolean(controller.result);
	}, [controller.result]);
	// Next and Previous change the question under the focused button, and either
	// may disable itself (no answer yet on the new question, index 0), which drops
	// focus and says nothing to a screen reader. Then focus goes to the new
	// question's heading, which also reads it. A button that is still usable keeps
	// focus, so pressing Previous again works, and the new question is announced.
	// Declared before the Back to case effect so that link keeps focus when it
	// replaces Next.
	const questionRef = useRef<HTMLHeadingElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const claimQuestionFocus = useRef(false);
	const [questionNote, setQuestionNote] = useState("");
	useEffect(() => {
		if (bodyRef.current) bodyRef.current.scrollTop = 0;
		if (!claimQuestionFocus.current) return;
		claimQuestionFocus.current = false;
		const active = document.activeElement as HTMLButtonElement | null;
		if (!active || active === document.body || active.disabled) {
			setQuestionNote("");
			questionRef.current?.focus({ preventScroll: true });
		} else {
			setQuestionNote(`Question ${controller.questionIndex + 1} of ${controller.pack.questions.length}: ${controller.pack.questions[controller.questionIndex]?.prompt ?? ""}`);
		}
	}, [controller.questionIndex, controller.pack]);
	// Submit is disabled while the answers are in flight, which drops focus too; a
	// failed submit hands it back so the learner can retry from the keyboard.
	const submitRef = useRef<HTMLButtonElement>(null);
	const claimSubmitFocus = useRef(false);
	useEffect(() => {
		if (controller.submitting || !claimSubmitFocus.current) return;
		claimSubmitFocus.current = false;
		// Only when focus was dropped, so a reader who moved on is left where they are.
		const active = document.activeElement;
		if (!controller.result && (!active || active === document.body)) submitRef.current?.focus();
	}, [controller.submitting, controller.result]);
	// Next on the second-to-last review question turns into the Back to case link,
	// which unmounts the focused button, so focus follows it onto the link.
	const backToCaseRef = useRef<HTMLAnchorElement>(null);
	const wasReviewingLast = useRef(reviewingLast);
	const hadResultBefore = useRef(Boolean(controller.result));
	useEffect(() => {
		if (reviewingLast && !wasReviewingLast.current && hadResultBefore.current) backToCaseRef.current?.focus();
		wasReviewingLast.current = reviewingLast;
		hadResultBefore.current = Boolean(controller.result);
	}, [reviewingLast, controller.result]);
	// The dock unmounts on close, which would drop focus to the page body.
	const closeDock = () => {
		document.getElementById(QUESTIONS_TOGGLE_ID)?.focus();
		controller.setDockOpen(false);
	};
	return (
		<aside className="lr-dock lr-quiz-dock" aria-label="Quiz practice">
			<div className="lr-dock__head lr-quiz-dock__head">
				<div><span className="lr-eyebrow">{controller.pack.title}</span><strong ref={headingRef} tabIndex={-1}>{controller.result ? "Review answers" : "Pick one answer for each question"}{controller.result && <span className="sr-only">. You scored {controller.result.score} out of {controller.result.max_score}.</span>}</strong></div>
				<button className="lr-dock__close" onClick={closeDock} aria-label="Close quiz panel"><IconX size={18} /></button>
			</div>
			<div ref={bodyRef} className="lr-dock__body lr-quiz-body">
				{controller.result && controller.questionIndex === 0 && (
					<section className="lr-quiz-complete">
						<div className="lr-quiz-mark"><IconTrophy size={25} /></div>
						<h2>{controller.result.score}/{controller.result.max_score} correct</h2>
						<p>{CONSISTENCY_TEXT[controller.result.consistency.status]}</p>
						{controller.result.consistency.status === "inconsistent" && controller.result.consistency.reasons.map((reason) => <p className="lr-quiz-consistency" key={reason}>{reason}</p>)}
					</section>
				)}
				<section className="lr-quiz-question">
					<span className="sr-only" role="status">{questionNote}</span>
					<div className="lr-quiz-kicker">Question {controller.questionIndex + 1} of {controller.pack.questions.length}</div>
					<h2 ref={questionRef} tabIndex={-1}>{question.prompt}</h2>
					<fieldset className="lr-quiz-choices" disabled={Boolean(controller.result) || controller.submitting}>
						<legend className="sr-only">Answer choices</legend>
						{question.choices.map((choice, index) => {
							const correct = reveal?.correct_choice_id === choice.id;
							const picked = selected === choice.id;
							return <button type="button" key={choice.id} className={`${picked ? "is-selected" : ""}${correct ? " is-correct" : ""}`} aria-pressed={picked} onClick={() => controller.selectAnswer(choice.id)}>
								<span>{String.fromCharCode(65 + index)}</span>{choice.label}{reveal && (picked || correct) && <b className="sr-only"> ({picked ? `your answer, ${correct ? "correct" : "incorrect"}` : "correct answer"})</b>}{(picked || correct) && <IconCheck size={17} aria-hidden="true" />}
							</button>;
						})}
					</fieldset>
					{reveal && <div className={`lr-quiz-personal ${selected === reveal.correct_choice_id ? "is-correct" : "is-incorrect"}`}>{selected === reveal.correct_choice_id ? "Correct" : "Incorrect"}</div>}
					{reveal?.source_label && <div className="lr-quiz-kicker">{reveal.source_label}</div>}
					{reveal && <p className="lr-quiz-explanation">{reveal.explanation}</p>}
					<div className="edu-quiz-nav">
						<button type="button" className="lr-button lr-button--secondary" onClick={() => { claimQuestionFocus.current = true; controller.previous(); }} disabled={controller.questionIndex === 0}><IconArrowLeft size={17} /> Previous</button>
						{reviewingLast ? (
							// Nothing follows the last question once graded, so the way on is back to the scan.
							<a ref={backToCaseRef} className="lr-button lr-button--primary" href={appRootRelativeUrl(`/case/${controller.pack.case_id}`)}>Back to case <IconArrowRight size={17} /></a>
						) : (
							<button ref={submitRef} type="button" className="lr-button lr-button--primary" onClick={() => {
								if (isLast && !controller.result) claimSubmitFocus.current = true;
								else claimQuestionFocus.current = true;
								controller.next();
							}} disabled={!controller.result && (!selected || controller.submitting)}>
								{controller.submitting ? "Submitting…" : isLast ? "Submit" : "Next"} <IconArrowRight size={17} />
							</button>
						)}
					</div>
				</section>
				{controller.result && (
					<section className="lr-export">
						<button disabled={controller.reportRecorded} onClick={() => void controller.reportContent("other").catch(() => undefined)}><IconFlag size={16} /> {controller.reportRecorded ? "Report recorded" : "Report content issue"}</button>
						<small>No scan data or personal information is included.</small>
						{controller.reportError && <div className="lr-error" role="alert"><IconAlertTriangle size={16} /> {controller.reportError}</div>}
					</section>
				)}
				{controller.error && <div className="lr-error" role="alert"><IconAlertTriangle size={16} /> {controller.error}</div>}
			</div>
		</aside>
	);
}
