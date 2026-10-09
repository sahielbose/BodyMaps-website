import { IconArrowRight, IconClock, IconCrosshair, IconRulerMeasure, IconSparkles } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ungzip } from "pako";
import MessagePage from "../components/MessagePage";
import { API_BASE } from "../helpers/constants";
import { appRootRelativeUrl } from "../liveRooms/protocol";
import VisualizationPage from "../routes/VisualizationPage";
import {
	clearSoloChallengeSession,
	readSoloChallengeSession,
	writeSoloChallengeSession,
} from "./soloChallengeSession";
import type { EducationAttempt, EducationChallenge, EducationResult, SoloChallengeController, SoloChallengeTutorMessage } from "./types";
import "./soloChallenge.css";

const CHALLENGE_ID = "pancreas-case-35";

const NETWORK_TEXT = "Could not reach the server. Check your connection and try again.";
// The answer overlay is retried quickly at first, then every REVEAL_RETRY_MAX_MS for
// as long as the page is open, so an outage of any length still recovers.
const REVEAL_RETRY_DELAYS_MS = [1000, 3000, 7000];
const REVEAL_RETRY_MAX_MS = 12000;
const REVEAL_TEXT = "The answer overlay could not be loaded yet. Trying again. Your score and review are still available.";
// Shown when the server says the overlay cannot be produced, so trying again would not help.
const REVEAL_UNAVAILABLE_TEXT = "The answer overlay is not available for this challenge. Your score and review are still available.";
const DEADLINE_TEXT = "Time ran out before your answer could be sent, so this attempt can't be graded. Start a new attempt to try again.";
// Shown when the server no longer has the attempt (it was cleaned up, or the key no longer fits).
const EXPIRED_TEXT = "This attempt has expired and can't be graded. Start a new attempt to try again.";
const EXPIRED_GRADE_TEXT = "This attempt has expired, so AI grading can't be retried. Your score and review are still available.";
// Shown when the server does not have the answer data the challenge is graded against.
const CHALLENGE_UNAVAILABLE_TEXT = "This challenge can't be started here because its answer data isn't installed on this server. You can still open the case and look through it.";

// The server answers 401, 404 or 410 once an attempt is gone, and repeating the request never helps.
function isAttemptGone(caught: unknown): boolean {
	const status = (caught as { status?: number } | null)?.status;
	return status === 401 || status === 404 || status === 410;
}

async function responseJson<T>(response: Response): Promise<T> {
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw Object.assign(new Error(body.error || "Something went wrong on our side. Try again in a moment."), { status: response.status, code: body.code });
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

// fetch rejects with a TypeError ("Failed to fetch", "Load failed") when the
// server can't be reached at all; say that in words instead of the raw text.
function failureText(caught: unknown, fallback: string): string {
	if (caught instanceof TypeError) return NETWORK_TEXT;
	return caught instanceof Error ? caught.message : fallback;
}

// The deadline is on the server's clock, so the countdown adds this offset to the
// device clock. A device that runs minutes fast or slow would otherwise start at
// 00:00 or see more time than the server allows. The start time the server just
// stamped on the attempt is the reference (the Date header is a fallback, though
// browsers hide it from cross-origin pages unless it is exposed).
function serverClockOffset(response: Response, attempt: EducationAttempt): number {
	for (const stamp of [attempt.started_at, response.headers.get("Date")]) {
		const server = stamp ? Date.parse(stamp) : Number.NaN;
		if (Number.isFinite(server)) return server - Date.now();
	}
	return 0;
}

// Why the challenge could not be loaded. The server's own strings ("Challenge
// not found") are for developers, so the screen words each case itself.
type LoadFailure = "missing" | "network" | "other";

function loadFailureOf(caught: unknown): LoadFailure {
	// fetch rejects with a TypeError when the server can't be reached at all.
	if (caught instanceof TypeError) return "network";
	const status = (caught as { status?: number } | null)?.status;
	return status === 404 || status === 410 ? "missing" : "other";
}

const LOAD_FAILURE_TEXT: Record<LoadFailure, string> = {
	missing: "The challenge may have been removed, or the link may be mistyped.",
	network: "We couldn't reach the server. Check your connection and try again.",
	other: "We couldn't load this challenge. Try again in a moment.",
};

export default function SoloChallengePage() {
	const { challengeId = CHALLENGE_ID } = useParams<{ challengeId: string }>();
	const [restoredSession] = useState(() => readSoloChallengeSession(challengeId));
	const [challenge, setChallenge] = useState<EducationChallenge | null>(null);
	const [attempt, setAttempt] = useState<EducationAttempt | null>(restoredSession?.attempt ?? null);
	const [loading, setLoading] = useState(true);
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Set when the server says the challenge cannot run at all, so "Try again" is not offered.
	const [startUnavailable, setStartUnavailable] = useState(false);
	// The start card's error message, which takes keyboard focus when the Start button goes away.
	const startErrorRef = useRef<HTMLDivElement>(null);
	const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
	const [now, setNow] = useState(Date.now());
	const [clockOffset, setClockOffset] = useState(restoredSession?.clockOffsetMs ?? 0);
	const [findingChoice, setFindingChoice] = useState(restoredSession?.findingChoice ?? "");
	const [impression, setImpression] = useState(restoredSession?.impression ?? "");
	const [marker, setMarker] = useState<[number, number, number] | null>(restoredSession?.marker ?? null);
	const [measurement, setMeasurement] = useState(restoredSession?.measurement ?? null);
	const [result, setResult] = useState<EducationResult | null>(restoredSession?.result ?? null);
	const [maskUrl, setMaskUrl] = useState<string | null>(null);
	// Why the answer overlay is missing; kept apart from `error`, which the results
	// panel shows under the AI rubric as if grading had failed.
	const [revealError, setRevealError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [retryingGrade, setRetryingGrade] = useState(false);
	const [taskDockOpen, setTaskDockOpen] = useState(true);
	// The tutor chat lives here, not in the results panel, so closing the panel
	// keeps the conversation, the draft and a reply that is still on its way.
	const [tutorQuestion, setTutorQuestion] = useState("");
	const [tutorMessages, setTutorMessages] = useState<SoloChallengeTutorMessage[]>([]);
	const [tutorSending, setTutorSending] = useState(false);
	// The submit window closed, so the attempt can't be graded any more.
	const [deadlineMissed, setDeadlineMissed] = useState(false);
	// A submit that failed without an answer may still have reached the server, so
	// the next one looks for a stored result before posting again.
	const submitMayHaveLanded = useRef(false);
	// Set once a failed timed-out auto-submit has opened the dock, so the automatic
	// retries that follow do not reopen it after the learner closes it.
	const timedOutDockOpened = useRef(false);
	// The attempt now on screen, so an AI grade retry for an earlier attempt can tell it is stale.
	const currentAttemptId = useRef<string | null>(attempt?.attempt_id ?? null);
	currentAttemptId.current = attempt?.attempt_id ?? null;
	// Bumped by "Try again" on the unavailable screen (offered for every failure
	// except a challenge that no longer exists) to fetch the challenge again.
	const [loadAttempt, setLoadAttempt] = useState(0);
	// True while "Try again" is fetching, so the unavailable card stays mounted
	// (and keeps keyboard focus) instead of giving way to the loading screen.
	const [retrying, setRetrying] = useState(false);

	useEffect(() => {
		fetch(`${API_BASE}/api/education/challenges/${challengeId}`)
			.then((response) => responseJson<EducationChallenge>(response))
			.then(setChallenge)
			.catch((caught) => {
				setError(caught instanceof Error ? caught.message : "Challenge unavailable");
				setLoadFailure(loadFailureOf(caught));
			})
			.finally(() => {
				setLoading(false);
				setRetrying(false);
			});
	}, [challengeId, loadAttempt]);

	// An unavailable challenge removes the Start button, which may have had focus. Focus
	// falls to the page body then, so it moves to the message that says why instead.
	useEffect(() => {
		if (!startUnavailable) return;
		const active = document.activeElement;
		if (!active || active === document.body) startErrorRef.current?.focus();
	}, [startUnavailable]);

	const reloadChallenge = useCallback(() => {
		if (retrying) return;
		setError(null);
		setRetrying(true);
		setLoading(true);
		setLoadAttempt((n) => n + 1);
	}, [retrying]);

	useEffect(() => {
		if (!attempt || result) return;
		const timer = window.setInterval(() => setNow(Date.now()), 250);
		return () => window.clearInterval(timer);
	}, [attempt, result]);

	useEffect(() => {
		if (!attempt) return;
		writeSoloChallengeSession(challengeId, {
			attempt,
			findingChoice,
			impression,
			marker,
			measurement,
			result,
			clockOffsetMs: clockOffset,
		});
	}, [attempt, challengeId, clockOffset, findingChoice, impression, marker, measurement, result]);

	// Drops the stored attempt and everything typed into it, which brings back the start card.
	const discardAttempt = useCallback(() => {
		clearSoloChallengeSession(challengeId);
		setAttempt(null);
		setFindingChoice("");
		setImpression("");
		setMarker(null);
		setMeasurement(null);
		setTutorQuestion("");
		setTutorMessages([]);
		setTutorSending(false);
		setRetryingGrade(false);
	}, [challengeId]);

	useEffect(() => {
		if (!attempt || result) return;
		let cancelled = false;
		void fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/result`, {
			headers: { "X-Attempt-Key": attempt.attempt_key },
		}).then(async (response) => {
			if (cancelled || response.status === 400) return;
			if ([401, 404, 410].includes(response.status)) {
				discardAttempt();
				return;
			}
			if (response.ok) setResult(await responseJson<EducationResult>(response));
		}).catch(() => {
			// A temporary result lookup failure should not discard recoverable local work.
		});
		return () => { cancelled = true; };
	}, [attempt, discardAttempt, result]);

	// Keyed on whether there is a result, not on the result object: Retry AI grade
	// swaps in a new object, and loading the mask again would reload the viewer and
	// lose the learner's pan, zoom and crosshair.
	const hasResult = result !== null;
	useEffect(() => {
		setRevealError(null);
		if (!attempt || !hasResult) {
			setMaskUrl(null);
			return;
		}
		let active = true;
		let ownedUrl: string | null = null;
		let timer: number | undefined;
		// settled: the overlay loaded or failed for good, so nothing more is scheduled.
		// generation: only the latest load may schedule a retry.
		let settled = false;
		let generation = 0;
		const load = async (tries: number) => {
			const mine = ++generation;
			try {
				const response = await fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/reveal-segmentation.nii.gz`, {
					headers: { "X-Attempt-Key": attempt.attempt_key },
				});
				if (!response.ok) {
					throw Object.assign(new Error(`Challenge reveal request failed with status ${response.status}`), { status: response.status });
				}
				const compressed = new Uint8Array(await response.arrayBuffer());
				const url = URL.createObjectURL(new Blob([new Uint8Array(ungzip(compressed))], {
					type: "application/octet-stream",
				}));
				if (!active || settled) {
					URL.revokeObjectURL(url);
					return;
				}
				settled = true;
				ownedUrl = url;
				setMaskUrl(url);
				setRevealError(null);
			} catch (caught) {
				console.error("Challenge reveal could not be loaded", caught);
				if (!active || settled || mine !== generation) return;
				if (!isRetryable(caught)) {
					settled = true;
					setRevealError(REVEAL_UNAVAILABLE_TEXT);
					return;
				}
				// Show the notice once the quick retries are spent; the slow ones continue.
				if (tries >= REVEAL_RETRY_DELAYS_MS.length) setRevealError(REVEAL_TEXT);
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
			if (ownedUrl) URL.revokeObjectURL(ownedUrl);
		};
	}, [attempt, hasResult]);

	const remainingSeconds = useMemo(() => {
		if (!attempt) return challenge?.time_limit_seconds ?? 300;
		return Math.max(0, Math.ceil((new Date(attempt.deadline_at).getTime() - (now + clockOffset)) / 1000));
	}, [attempt, challenge?.time_limit_seconds, clockOffset, now]);

	const start = async () => {
		setStarting(true);
		setError(null);
		setStartUnavailable(false);
		try {
			const response = await fetch(`${API_BASE}/api/education/challenges/${challengeId}/attempts`, { method: "POST" });
			setFindingChoice("");
			setImpression("");
			setMarker(null);
			setMeasurement(null);
			setResult(null);
			setMaskUrl(null);
			setDeadlineMissed(false);
			setTutorQuestion("");
			setTutorMessages([]);
			setTutorSending(false);
			setRetryingGrade(false);
			submitMayHaveLanded.current = false;
			const started = await responseJson<EducationAttempt>(response);
			setClockOffset(serverClockOffset(response, started));
			setAttempt(started);
			setNow(Date.now());
		} catch (caught) {
			if ((caught as { code?: string } | null)?.code === "challenge_unavailable") {
				setStartUnavailable(true);
				setError(CHALLENGE_UNAVAILABLE_TEXT);
			} else {
				setError(failureText(caught, "Could not start challenge"));
			}
		} finally {
			setStarting(false);
		}
	};

	// The stored result of this attempt, or null when there is none yet or it can't be read.
	const fetchResult = useCallback(async (): Promise<EducationResult | null> => {
		if (!attempt) return null;
		try {
			const response = await fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/result`, {
				headers: { "X-Attempt-Key": attempt.attempt_key },
			});
			return response.ok ? await responseJson<EducationResult>(response) : null;
		} catch {
			return null;
		}
	}, [attempt]);

	const submit = useCallback(async (measurement: Parameters<SoloChallengeController["submit"]>[0], timedOut = false) => {
		if (!attempt || result || submitting || deadlineMissed) return;
		setSubmitting(true);
		setError(null);
		try {
			if (submitMayHaveLanded.current) {
				const landed = await fetchResult();
				if (landed) {
					submitMayHaveLanded.current = false;
					setResult(landed);
					setTaskDockOpen(true);
					return;
				}
			}
			const fallbackImpression = "No impression was submitted before the time limit expired.";
			const response = await fetch(`${API_BASE}/api/education/attempts/${attempt.attempt_id}/submit`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Attempt-Key": attempt.attempt_key },
				body: JSON.stringify({
					finding_choice: findingChoice || "no_focal_lesion",
					marker_lps: marker,
					measurement: measurement ? { points: measurement.points } : null,
					impression: impression.trim() || (timedOut ? fallbackImpression : "No impression submitted."),
				}),
			});
			setResult(await responseJson<EducationResult>(response));
			submitMayHaveLanded.current = false;
			setTaskDockOpen(true);
		} catch (caught) {
			const { code, status } = (caught ?? {}) as { code?: string; status?: number };
			if (code === "attempt_already_submitted") {
				// An earlier submit was graded but its reply never arrived: show that result.
				const landed = await fetchResult();
				if (landed) {
					submitMayHaveLanded.current = false;
					setResult(landed);
					setTaskDockOpen(true);
					return;
				}
			}
			if (code === "attempt_deadline_passed") {
				console.error("Solo challenge submit window closed", caught);
				setDeadlineMissed(true);
				setError(DEADLINE_TEXT);
				setTaskDockOpen(true);
				return;
			}
			if (isAttemptGone(caught)) {
				console.error("Solo challenge attempt is gone", caught);
				setDeadlineMissed(true);
				setError(EXPIRED_TEXT);
				setTaskDockOpen(true);
				return;
			}
			submitMayHaveLanded.current = caught instanceof TypeError || (status ?? 0) >= 500;
			setError(failureText(caught, "Could not submit challenge"));
			// The error lives in the dock, so a timed-out auto-submit that failed must open it,
			// once. The automatic retries leave it as the learner set it.
			if (timedOut && !timedOutDockOpened.current) {
				timedOutDockOpened.current = true;
				setTaskDockOpen(true);
			}
		} finally {
			setSubmitting(false);
		}
	}, [attempt, deadlineMissed, fetchResult, findingChoice, impression, marker, result, submitting]);

	const startOver = useCallback(() => {
		discardAttempt();
		setResult(null);
		setMaskUrl(null);
		setError(null);
		setDeadlineMissed(false);
		setTaskDockOpen(true);
		submitMayHaveLanded.current = false;
		timedOutDockOpened.current = false;
	}, [discardAttempt]);

	const retryGrade = useCallback(async () => {
		if (!attempt || !result || result.status !== "provisional" || retryingGrade) return;
		const retriedId = attempt.attempt_id;
		setRetryingGrade(true);
		setError(null);
		try {
			const response = await fetch(`${API_BASE}/api/education/attempts/${retriedId}/retry-grade`, {
				method: "POST",
				headers: { "X-Attempt-Key": attempt.attempt_key },
			});
			const regraded = await responseJson<EducationResult>(response);
			// The learner started over while this was grading; the answer belongs to the old attempt.
			if (currentAttemptId.current !== retriedId) return;
			setResult(regraded);
		} catch (caught) {
			if (currentAttemptId.current !== retriedId) return;
			setError(isAttemptGone(caught) ? EXPIRED_GRADE_TEXT : failureText(caught, "AI grading remains unavailable"));
		} finally {
			if (currentAttemptId.current === retriedId) setRetryingGrade(false);
		}
	}, [attempt, result, retryingGrade]);

	const clearSession = useCallback(() => {
		clearSoloChallengeSession(challengeId);
	}, [challengeId]);

	if (loading && !retrying) return <ChallengeLoading />;
	// Only a failed load lands here. A failed start keeps the start card, which
	// shows the error and lets the learner try again (it used to swap in this
	// screen, with an endless spinner and no way to retry short of a reload).
	if (!challenge) {
		const failure = loadFailure ?? "other";
		return (
			<MessagePage
				eyebrow="Solo challenge"
				title="This challenge isn't available"
				actions={[{ label: "Browse the dataset", to: "/dashboard" }]}
				alert
			>
				<p>{retrying ? "Trying again…" : LOAD_FAILURE_TEXT[failure]}</p>
				{failure !== "missing" && (
					// aria-disabled, not disabled, so the button keeps focus while it retries.
					<button type="button" className="edu-load-retry" aria-disabled={retrying} onClick={reloadChallenge}>
						{retrying ? "Trying again…" : "Try again"}
					</button>
				)}
			</MessagePage>
		);
	}

	if (!attempt) {
		return (
			<main className="edu-start">
				<div className="edu-start__scan" aria-hidden="true" />
				<section className="edu-start__card">
					<span className="edu-kicker">{challenge.eyebrow}</span>
					<h1>{challenge.title}</h1>
					<p>{challenge.prompt}</p>
					<div className="edu-start__facts">
						<span><IconClock size={18} /> Five minutes</span>
						<span><IconCrosshair size={18} /> 3D localization</span>
						<span><IconRulerMeasure size={18} /> Axial diameter</span>
						<span><IconSparkles size={18} /> Post-submit AI tutor</span>
					</div>
					<ol>{challenge.requirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ol>
					<div className="edu-start__notice">The answer overlay and BodyMaps AI stay locked until submission. This is a low-stakes educational exercise, not clinical diagnosis.</div>
					{error && (
						<div className="edu-error" role="alert" ref={startErrorRef} tabIndex={startUnavailable ? -1 : undefined}>
							{error}
						</div>
					)}
					{!startUnavailable && (
						<button type="button" onClick={() => void start()} disabled={starting}>
							{starting ? "Preparing case…" : error ? "Try again" : "Start solo challenge"} <IconArrowRight size={19} />
						</button>
					)}
					<a className="edu-start__back" href={appRootRelativeUrl(`/case/${challenge.case_id}`)}>Return to case {challenge.case_id}</a>
				</section>
			</main>
		);
	}

	const controller: SoloChallengeController = {
		challenge,
		attempt,
		remainingSeconds,
		findingChoice,
		setFindingChoice,
		impression,
		setImpression,
		marker,
		setMarker,
		measurement,
		setMeasurement,
		result,
		maskUrl,
		submitting,
		retryingGrade,
		error,
		submit,
		retryGrade,
		taskDockOpen,
		setTaskDockOpen,
		clearSession,
		deadlineMissed,
		startOver,
		revealError,
		tutor: {
			question: tutorQuestion,
			setQuestion: setTutorQuestion,
			messages: tutorMessages,
			setMessages: setTutorMessages,
			sending: tutorSending,
			setSending: setTutorSending,
		},
	};
	// Keyed by attempt so a new attempt always gets a fresh viewer: the viewer's timed-out
	// auto-submit guards belong to one attempt and must not carry over to the next.
	return <VisualizationPage key={attempt.attempt_id} soloChallenge={controller} />;
}

function ChallengeLoading() {
	return (
		<main className="edu-start edu-start--state" role="status">
			<div>
				<span className="edu-loading" />
				<h1>Loading challenge…</h1>
			</div>
		</main>
	);
}
