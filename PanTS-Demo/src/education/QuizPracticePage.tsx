import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ungzip } from "pako";
import { useParams } from "react-router-dom";
import MessagePage from "../components/MessagePage";
import { API_BASE } from "../helpers/constants";
import VisualizationPage from "../routes/VisualizationPage";
import type {
	QuizPracticeController,
	QuizPracticePack,
	QuizPracticeResult,
} from "./types";
import "../liveRooms/liveRooms.css";
import "./quizPractice.css";

type Attempt = {
	attempt_id: string;
	attempt_key: string;
	pack: QuizPracticePack;
};

// Server messages are written for developers ("Quiz pack is unavailable"). The common
// ones get a plain explanation; anything else (a rate limit, say) is shown as sent.
function quizUnavailableText(message: string, retryable: boolean): string {
	// A server hiccup ("Service unavailable") says nothing about the quiz itself.
	if (!retryable && /unavailable|not found|not approved|invalid/i.test(message)) {
		return "The quiz may have been removed or not approved yet, or the link may be mistyped.";
	}
	return /[.!?]$/.test(message) ? message : `${message}.`;
}

const NETWORK_TEXT = "Could not reach the server. Check your connection and try again.";
const EXPIRED_TEXT = "This quiz session expired. Start it again to try a new set of questions.";

async function responseJson<T>(response: Response): Promise<T> {
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw Object.assign(new Error(body.error || "Something went wrong on our side. Try again in a moment."), { status: response.status });
	}
	return body as T;
}

// Whether trying the same request again could work: the server could not be
// reached, had a fault of its own, or asked the learner to slow down.
function isRetryable(caught: unknown): boolean {
	if (caught instanceof TypeError) return true;
	const status = (caught as { status?: number } | null)?.status;
	return status == null || status >= 500 || status === 429;
}

// The overlay is retried quickly at first, then every REVEAL_RETRY_MAX_MS for as
// long as the page is open, so an outage of any length still recovers.
const REVEAL_RETRY_DELAYS_MS = [1000, 3000, 7000];
const REVEAL_RETRY_MAX_MS = 12000;
const REVEAL_TEXT = "The lesion overlay could not be loaded yet. Trying again. Your score and review are still available.";
// Shown when the server says the overlay cannot be produced, so trying again would not help.
const REVEAL_UNAVAILABLE_TEXT = "The lesion overlay is not available for this quiz. Your score and review are still available.";

// fetch rejects with a TypeError ("Failed to fetch", "Load failed") when the
// server can't be reached at all; say that in words instead of the raw text.
function failureText(caught: unknown, fallback: string): string {
	if (caught instanceof TypeError) return NETWORK_TEXT;
	return caught instanceof Error ? caught.message : fallback;
}

export default function QuizPracticePage() {
	const { packId = "" } = useParams<{ packId: string }>();
	const [attempt, setAttempt] = useState<Attempt | null>(null);
	const [questionIndex, setQuestionIndex] = useState(0);
	const [answers, setAnswers] = useState<Record<string, string>>({});
	const [result, setResult] = useState<QuizPracticeResult | null>(null);
	const [maskUrl, setMaskUrl] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// A failed submit has its own state too: it belongs to the answers as they were
	// when Submit was pressed, so it goes as soon as they or the question change
	// instead of following the learner through the quiz.
	const [submitError, setSubmitError] = useState<string | null>(null);
	// True when loading the pack failed in a way a second try could fix (the server
	// was unreachable or had a fault); the dead end then offers Try again, which
	// bumps loadAttempt to fetch again.
	const [retryable, setRetryable] = useState(false);
	// A content report has its own state: sharing `error` left a failed report's
	// banner up for good and let it overwrite the overlay notice. The recorded flag
	// lives here so closing and reopening the panel cannot file the report twice.
	const [reportRecorded, setReportRecorded] = useState(false);
	const [reportError, setReportError] = useState<string | null>(null);
	const reportInFlight = useRef(false);
	const [loadAttempt, setLoadAttempt] = useState(0);
	// True while "Try again" is posting, so the dead-end card stays mounted (and
	// keeps keyboard focus) instead of giving way to the loading ring.
	const [retrying, setRetrying] = useState(false);
	const retryRequested = useRef(false);
	// On a phone the question panel is a bottom sheet over the scan, so it starts
	// closed and the Questions button opens it.
	const [dockOpen, setDockOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 520);
	// A submit that failed without an answer may still have reached the server, so
	// the next one looks for the stored result before posting again.
	const submitMayHaveLanded = useRef(false);

	useEffect(() => {
		let active = true;
		setAttempt(null);
		setQuestionIndex(0);
		setAnswers({});
		setResult(null);
		setMaskUrl(null);
		// A retry keeps the failure on screen until the new request answers.
		const isRetry = retryRequested.current;
		retryRequested.current = false;
		if (!isRetry) {
			setError(null);
			setRetryable(false);
		}
		setRetrying(isRetry);
		setSubmitError(null);
		setReportRecorded(false);
		setReportError(null);
		reportInFlight.current = false;
		submitMayHaveLanded.current = false;
		fetch(`${API_BASE}/api/education/quiz-packs/${encodeURIComponent(packId)}/attempts`, {
			method: "POST",
		}).then((response) => responseJson<Attempt>(response)).then((value) => {
			if (!active) return;
			setAttempt(value);
			setError(null);
			setRetryable(false);
			setRetrying(false);
		}).catch((caught) => {
			if (!active) return;
			setRetrying(false);
			setRetryable(isRetryable(caught));
			setError(failureText(caught, "Quiz practice unavailable"));
		});
		return () => { active = false; };
	}, [packId, loadAttempt]);

	useEffect(() => () => {
		if (maskUrl) URL.revokeObjectURL(maskUrl);
	}, [maskUrl]);

	// The graded result of this attempt, or null when there is none yet or it can't be read.
	const fetchResult = useCallback(async (): Promise<QuizPracticeResult | null> => {
		if (!attempt) return null;
		try {
			const response = await fetch(`${API_BASE}/api/education/quiz-attempts/${attempt.attempt_id}/result`, {
				headers: { "X-Quiz-Attempt-Key": attempt.attempt_key },
			});
			return response.ok ? await responseJson<QuizPracticeResult>(response) : null;
		} catch {
			return null;
		}
	}, [attempt]);

	const submit = useCallback(async () => {
		if (!attempt || submitting || result) return;
		setSubmitting(true);
		setError(null);
		setSubmitError(null);
		try {
			if (submitMayHaveLanded.current) {
				const landed = await fetchResult();
				if (landed) {
					submitMayHaveLanded.current = false;
					setResult(landed);
					setQuestionIndex(0);
					return;
				}
			}
			const response = await fetch(`${API_BASE}/api/education/quiz-attempts/${attempt.attempt_id}/submit`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Quiz-Attempt-Key": attempt.attempt_key,
				},
				body: JSON.stringify({ answers }),
			});
			const completed = await responseJson<QuizPracticeResult>(response);
			submitMayHaveLanded.current = false;
			setResult(completed);
			// The score card and consistency notice sit above the first question's review.
			setQuestionIndex(0);
		} catch (caught) {
			// The server has no separate code for this (and answers 400), so it is told by its message.
			if (caught instanceof Error && !(caught instanceof TypeError) && /already submitted/i.test(caught.message)) {
				// An earlier submit was graded but its reply never arrived: show that result.
				const landed = await fetchResult();
				if (landed) {
					submitMayHaveLanded.current = false;
					setResult(landed);
					setQuestionIndex(0);
					return;
				}
			}
			const status = (caught as { status?: number } | null)?.status;
			if (status === 401 || status === 404 || status === 410) {
				// The server dropped this attempt (it expired or was cleaned up), so every
				// further submit would fail the same way. Offer a fresh one instead.
				setAttempt(null);
				setRetryable(true);
				setError(EXPIRED_TEXT);
				return;
			}
			submitMayHaveLanded.current = isRetryable(caught);
			setSubmitError(failureText(caught, "Quiz could not be submitted"));
		} finally {
			setSubmitting(false);
		}
	}, [answers, attempt, fetchResult, result, submitting]);

	// The answer overlay loads once the attempt is graded. It is its own step so a
	// dropped connection here can be retried: the attempt has no persistence, so a
	// reload would start a new one and lose the score and review.
	useEffect(() => {
		if (!attempt || !result) return;
		let active = true;
		let timer: number | undefined;
		// settled: the overlay loaded or failed for good, so nothing more is scheduled.
		// generation: only the latest load may schedule a retry.
		let settled = false;
		let generation = 0;
		const load = async (tries: number) => {
			const mine = ++generation;
			try {
				const response = await fetch(
					`${API_BASE}/api/education/quiz-attempts/${attempt.attempt_id}/reveal-segmentation.nii.gz`,
					{ headers: { "X-Quiz-Attempt-Key": attempt.attempt_key } },
				);
				if (!response.ok) {
					throw Object.assign(new Error(`Quiz reveal request failed with status ${response.status}`), { status: response.status });
				}
				// Blob URLs have no `.gz` suffix, so Cornerstone cannot infer gzip handling.
				// Expose raw NIfTI bytes, matching live-room reveal-mask handling.
				const compressedMask = new Uint8Array(await response.arrayBuffer());
				const url = URL.createObjectURL(new Blob([
					new Uint8Array(ungzip(compressedMask)),
				], { type: "application/octet-stream" }));
				if (!active || settled) {
					URL.revokeObjectURL(url);
					return;
				}
				settled = true;
				setMaskUrl(url);
				setError((current) => (current === REVEAL_TEXT ? null : current));
			} catch (caught) {
				console.error("Quiz reveal could not be loaded", caught);
				if (!active || settled || mine !== generation) return;
				if (!isRetryable(caught)) {
					settled = true;
					setError(REVEAL_UNAVAILABLE_TEXT);
					return;
				}
				// Show the notice once the quick retries are spent; the slow ones continue.
				if (tries >= REVEAL_RETRY_DELAYS_MS.length) setError(REVEAL_TEXT);
				timer = window.setTimeout(
					() => void load(tries + 1),
					REVEAL_RETRY_DELAYS_MS[tries] ?? REVEAL_RETRY_MAX_MS,
				);
			}
		};
		// The connection coming back skips the wait for the next scheduled try.
		const onOnline = () => {
			if (settled) return;
			window.clearTimeout(timer);
			void load(0);
		};
		window.addEventListener("online", onOnline);
		void load(0);
		return () => {
			active = false;
			window.clearTimeout(timer);
			window.removeEventListener("online", onOnline);
		};
	}, [attempt, result]);

	const next = useCallback(() => {
		if (!attempt) return;
		if (result) {
			setQuestionIndex((current) => Math.min(attempt.pack.questions.length - 1, current + 1));
			return;
		}
		const question = attempt.pack.questions[questionIndex];
		if (!answers[question.id]) return;
		if (questionIndex === attempt.pack.questions.length - 1) {
			void submit();
		} else {
			setSubmitError(null);
			setQuestionIndex((current) => current + 1);
		}
	}, [answers, attempt, questionIndex, result, submit]);

	const reportContent = useCallback(async (category: string) => {
		if (!attempt || reportRecorded || reportInFlight.current) return;
		reportInFlight.current = true;
		setReportError(null);
		try {
			const response = await fetch(`${API_BASE}/api/education/quiz-packs/${encodeURIComponent(attempt.pack.pack_id)}/reports`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ category, mode: "solo" }),
			});
			await responseJson(response);
			setReportRecorded(true);
		} catch (caught) {
			setReportError(failureText(caught, "Content report could not be recorded"));
			throw caught;
		} finally {
			reportInFlight.current = false;
		}
	}, [attempt, reportRecorded]);

	const controller = useMemo<QuizPracticeController | null>(() => attempt ? ({
		pack: attempt.pack,
		questionIndex,
		answers,
		result,
		maskUrl,
		submitting,
		error: error ?? submitError,
		dockOpen,
		setDockOpen,
		selectAnswer: (choiceId) => {
			// Locked while the submit is in flight, which carries the answers as they were.
			if (result || submitting) return;
			const question = attempt.pack.questions[questionIndex];
			setSubmitError(null);
			setAnswers((current) => ({ ...current, [question.id]: choiceId }));
		},
		previous: () => {
			setSubmitError(null);
			setQuestionIndex((current) => Math.max(0, current - 1));
		},
		next,
		reportContent,
		reportRecorded,
		reportError,
	}) : null, [answers, attempt, dockOpen, error, submitError, maskUrl, next, questionIndex, reportContent, reportError, reportRecorded, result, submitting]);

	// The label stays "Try again" (MessagePage keys its buttons by label, so a new
	// label would remount the button and drop focus); the text above says it is working.
	const retryLoad = () => {
		if (retrying) return;
		retryRequested.current = true;
		setRetrying(true);
		setLoadAttempt((n) => n + 1);
	};
	if ((error || retrying) && !attempt) return (
		<MessagePage
			eyebrow="Quiz practice"
			title="This quiz can't be opened"
			actions={[
				...(retryable ? [{ label: "Try again", onClick: retryLoad }] : []),
				{ label: "Browse the dataset", to: "/dashboard" },
				{ label: "Go to the overview", to: "/" },
			]}
			alert
		>
			<p>{retrying ? "Trying again…" : quizUnavailableText(error ?? "", retryable)}</p>
		</MessagePage>
	);
	if (!controller) return <main className="lr-page lr-page--center" role="status"><div className="lr-loading-ring" /><p>Preparing quiz pack…</p></main>;
	return <VisualizationPage quizPractice={controller} />;
}
