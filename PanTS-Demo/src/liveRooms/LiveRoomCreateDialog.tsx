import { IconArrowLeft, IconBolt, IconClipboardCheck, IconClockPlay, IconLink, IconUsersGroup, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "../helpers/constants";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDialogFocus";
import { liveRoomRoute, readLiveRoomSession, writeLiveRoomSession } from "./protocol";
import type { LiveQuizHostCredential } from "./types";
import "./liveRooms.css";

type Props = {
	caseId: string;
	open: boolean;
	onClose: () => void;
};

// A create request that has not answered by now is given up so the dialog can be dismissed.
const CREATE_TIMEOUT_MS = 30000;

type QuizPlaylist = {
	playlist_id: string;
	title: string;
	description: string;
	pack_count: number;
};

// Playlist titles arrive in Title Case; the UI is sentence case. Only plain
// capitalised words (and the parts after a hyphen) are lowered, so acronyms
// such as "CT" stay as they are.
function sentenceCase(title: string): string {
	return title.replace(/\s+/g, " ").split(" ").map((word, index) => index > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word.replace(/-([A-Z][a-z]+)/g, (_, part: string) => `-${part.toLowerCase()}`)).join(" ");
}

// The subline under a playlist title: its own description when the API has one,
// otherwise the pack count, but only when it says something ("1 pack" on every
// row does not).
function playlistNote(playlist: QuizPlaylist): string {
	const description = (playlist.description ?? "").trim();
	if (description) return description;
	if (playlist.pack_count === 0) return "No packs yet";
	return playlist.pack_count > 1 ? `${playlist.pack_count} packs` : "";
}

export default function LiveRoomCreateDialog({ caseId, open, onClose }: Props) {
	const navigate = useNavigate();
	const [name, setName] = useState(() => readLiveRoomSession("bodymaps.live-room.name") || "");
	const [resolution, setResolution] = useState<"low" | "full">("low");
	const [mode, setMode] = useState<"choose" | "review" | "quiz">("choose");
	const [quizTimer, setQuizTimer] = useState<"untimed" | "15" | "30" | "60">("30");
	const [quizSource, setQuizSource] = useState(() => String(caseId) === "35" ? "pack:radworld-case-35-v1" : "playlist:mixed-challenge-v1");
	const [playlists, setPlaylists] = useState<QuizPlaylist[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const createAbortRef = useRef<AbortController | null>(null);

	// Leaving the dialog (Back from the viewer, or closing it) must not let a slow
	// create answer later and pull the user into the new room.
	useEffect(() => {
		if (!open) return;
		return () => createAbortRef.current?.abort();
	}, [open]);

	useEffect(() => {
		if (!open) return;
		setMode("choose");
		setQuizSource(String(caseId) === "35" ? "pack:radworld-case-35-v1" : "playlist:mixed-challenge-v1");
		// A failed create keeps the dialog mounted, so a reopened one must not show its old error.
		setError(null);
		setSubmitting(false);
	}, [caseId, open]);

	// Both steps (mode menu and form) render into the same backdrop node, so
	// one focus trap covers them. Escape and a click on the backdrop close
	// the dialog, except while a room is being created.
	const backdropRef = useRef<HTMLDivElement>(null);
	const firstModeRef = useRef<HTMLButtonElement>(null);
	const dismiss = () => {
		if (!submitting) onClose();
	};
	useDialogFocus(open, backdropRef, { initialFocus: firstModeRef, onEscape: dismiss });
	const backdropDismiss = useBackdropDismiss(dismiss);
	// Back from a form (or reopening on the menu) puts focus on the first mode
	// card; the control that had it was just unmounted.
	useEffect(() => {
		if (open && mode === "choose") firstModeRef.current?.focus({ preventScroll: true });
	}, [mode, open]);

	useEffect(() => {
		if (!open) return;
		let active = true;
		fetch(`${API_BASE}/api/education/quiz-playlists`)
			.then((response) => response.ok ? response.json() : Promise.reject(new Error("Playlist request failed")))
			.then((body) => { if (active && Array.isArray(body.playlists)) setPlaylists(body.playlists); })
			.catch(() => { if (active) setPlaylists([]); });
		return () => { active = false; };
	}, [open]);

	if (!open) return null;

	if (mode === "choose") {
		const educationAvailable = String(caseId) === "35";
		return (
			<div ref={backdropRef} className="lr-modal-backdrop" role="presentation" {...backdropDismiss}>
				<section className="lr-modal lr-mode-menu" role="dialog" aria-modal="true" aria-labelledby="lr-mode-title">
					<div className="lr-modal__head">
						<div><span className="lr-eyebrow">Case {caseId}</span><h2 id="lr-mode-title">Live rooms</h2></div>
						<button type="button" className="lr-icon-button" onClick={onClose} aria-label="Close"><IconX size={20} /></button>
					</div>
					<p className="lr-modal__intro">Choose how you want to review this scan.</p>
					<div className="lr-mode-grid">
						<button ref={firstModeRef} type="button" className="lr-mode-card" onClick={() => { setError(null); setMode("review"); }}>
							<span><IconUsersGroup size={21} /></span><strong>Collaborative review</strong><small>Share one editable scan with up to eight people.</small>
						</button>
						<button type="button" className="lr-mode-card lr-mode-card--challenge" disabled={!educationAvailable} onClick={() => navigate("/live/challenge/pancreas-case-35")}>
							<span><IconClockPlay size={21} /></span><strong>Solo challenge</strong><small>{educationAvailable ? "Five-minute case: locate, measure, and interpret." : "The first curated challenge uses case 35."}</small>
						</button>
						<button type="button" className="lr-mode-card" onClick={() => { setError(null); setMode("quiz"); }}>
							<span><IconBolt size={21} /></span><strong>Individual race</strong><small>Live linked-question race with private answers.</small>
						</button>
						<button type="button" className="lr-mode-card lr-mode-card--quiz" disabled={!educationAvailable} onClick={() => navigate("/learn/quiz/radworld-case-35-v1")}>
							<span><IconClipboardCheck size={21} /></span><strong>Quiz practice</strong><small>{educationAvailable ? "Untimed linked-question pack with answer review." : "This pack uses case 35."}</small>
						</button>
					</div>
				</section>
			</div>
		);
	}

	const create = async (event: React.FormEvent) => {
		event.preventDefault();
		const cleanName = name.trim();
		if (!cleanName) {
			setError("Enter a display name.");
			return;
		}
		setSubmitting(true);
		setError(null);
		const controller = new AbortController();
		createAbortRef.current = controller;
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; controller.abort(); }, CREATE_TIMEOUT_MS);
		try {
			const response = await fetch(`${API_BASE}/api/live-rooms`, {
				method: "POST",
				signal: controller.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					case_id: caseId,
					resolution,
					mode: mode === "quiz" ? "quiz" : "review",
						...(mode === "quiz" ? {
							...(quizSource.startsWith("playlist:")
								? { quiz_playlist_id: quizSource.slice("playlist:".length), quiz_playlist_seed: crypto.randomUUID() }
								: { quiz_pack_id: quizSource.slice("pack:".length) }),
							quiz_timer_seconds: quizTimer === "untimed" ? null : Number(quizTimer),
					} : {}),
				}),
			});
			const body = await response.json().catch(() => ({}));
			if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
			if (!response.ok) {
				// The server's wording is for developers; keep it in the console.
				console.error("Live room create rejected", response.status, body.error);
				throw new Error(response.status === 429
					? "You have created several rooms recently. Try again in a little while."
					: mode === "quiz"
						? "We couldn't create a race room for this case. Try again, or pick another case."
						: "We couldn't create a room for this case. Try Fast preview or another case.");
			}
			const quizHostCredential: LiveQuizHostCredential | undefined = typeof body.quiz_host_claim === "string"
				? { mode: "modern", value: body.quiz_host_claim }
				: typeof body.quiz_host_secret === "string"
					? { mode: "legacy", value: body.quiz_host_secret }
					: undefined;
			writeLiveRoomSession("bodymaps.live-room.name", cleanName);
			writeLiveRoomSession(`bodymaps.live-room.${body.room_id}.case-id`, String(body.case_id));
			navigate(liveRoomRoute(String(body.room_id), String(body.room_key)), {
				state: {
					liveRoomCreation: {
						creatorName: cleanName,
						quizHostCredential,
					},
				},
			});
		} catch (caught) {
			// Aborted by leaving the dialog: nobody is waiting, so say nothing and stay put.
			if (controller.signal.aborted && !timedOut) return;
			console.error("Live room create failed", caught);
			if (timedOut) {
				setError("Creating the room is taking too long. Try again in a moment.");
				setSubmitting(false);
				return;
			}
			// fetch rejects with a TypeError when the request never reached the server.
			setError(caught instanceof TypeError
				? "Can't reach the server. Check your connection and try again."
				: caught instanceof Error && caught.message ? caught.message : "We couldn't create the room. Try again in a moment.");
			setSubmitting(false);
		} finally {
			clearTimeout(timer);
		}
	};

	return (
		<div ref={backdropRef} className="lr-modal-backdrop" role="presentation" {...backdropDismiss}>
			<form className="lr-modal lr-modal--form" role="dialog" aria-modal="true" aria-labelledby="lr-create-title" onSubmit={create}>
				<div className="lr-modal__head">
					<div className="lr-modal__title-row">
						<button type="button" className="lr-back-button" onClick={() => { setError(null); setMode("choose"); }} aria-label="Back to room modes" disabled={submitting}><IconArrowLeft size={18} /></button>
						<div>
						<span className="lr-eyebrow">Case {caseId}</span>
						<h2 id="lr-create-title">{mode === "quiz" ? "Start an individual race" : "Start a live room"}</h2>
						</div>
					</div>
					<button type="button" className="lr-icon-button" onClick={onClose} aria-label="Close" disabled={submitting}>
						<IconX size={20} />
					</button>
				</div>
				<div className="lr-modal__body">
					<p className="lr-modal__intro">{mode === "quiz" ? <>Host one <span className="lr-nowrap">private-answer</span> <span className="lr-nowrap">linked-question</span> race. No account required.</> : "Share a link so others can review this scan with you. No account required."}</p>
					<label className="lr-field">
						<span>Display name</span>
						<input autoFocus maxLength={32} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
					</label>
					<fieldset className="lr-resolution">
						<legend>Resolution</legend>
						<label className={resolution === "low" ? "is-selected" : ""}>
							<input type="radio" name="resolution" checked={resolution === "low"} onChange={() => setResolution("low")} />
							<span><strong>Fast preview</strong><small>Recommended for smooth collaboration</small></span>
						</label>
						<label className={resolution === "full" ? "is-selected" : ""}>
							<input type="radio" name="resolution" checked={resolution === "full"} onChange={() => setResolution("full")} />
							<span><strong>Full resolution</strong><small>Available when server copy exists</small></span>
						</label>
					</fieldset>
						{mode === "quiz" && (
							<>
							<fieldset className="lr-resolution lr-quiz-source">
								<legend>Quiz pack</legend>
								<label className={quizSource === "pack:radworld-case-35-v1" ? "is-selected" : ""}>
									<input type="radio" name="quiz-source" disabled={String(caseId) !== "35"} checked={quizSource === "pack:radworld-case-35-v1"} onChange={() => setQuizSource("pack:radworld-case-35-v1")} />
									<span><strong>Case 35</strong><small>{String(caseId) === "35" ? "Reviewed questions, the same every round" : "Open case 35 to use these questions"}</small></span>
								</label>
								{playlists.map((playlist) => (
									<label className={quizSource === `playlist:${playlist.playlist_id}` ? "is-selected" : ""} key={playlist.playlist_id}>
										<input type="radio" name="quiz-source" disabled={playlist.pack_count === 0} checked={quizSource === `playlist:${playlist.playlist_id}`} onChange={() => setQuizSource(`playlist:${playlist.playlist_id}`)} />
										<span><strong>{sentenceCase(playlist.title)}</strong>{playlistNote(playlist) && <small>{playlistNote(playlist)}</small>}</span>
									</label>
								))}
								{quizSource.startsWith("playlist:") && String(caseId) !== "35" && (
									<p className="lr-quiz-source__note">This race opens on the case its questions come from, which may not be Case {caseId}.</p>
								)}
							</fieldset>
							<fieldset className="lr-resolution lr-quiz-timer">
							<legend>Per-question timer</legend>
							{(["untimed", "15", "30", "60"] as const).map((value) => (
								<label className={quizTimer === value ? "is-selected" : ""} key={value}>
									<input type="radio" name="quiz-timer" value={value} checked={quizTimer === value} onChange={() => setQuizTimer(value)} />
									<span><strong>{value === "untimed" ? "Untimed" : `${value} seconds`}</strong></span>
								</label>
							))}
							</fieldset>
							</>
						)}
					<div className="lr-capability-note">
						<IconLink size={16} aria-hidden="true" />
						<span>{mode === "quiz" ? "The participant link never contains the host credential. Answers stay private until reveal." : "Anyone with the link can edit. Room supports 8 people and expires after 24 hours."}</span>
					</div>
				</div>
				{error && <div className="lr-error" role="alert">{error}</div>}
				<div className="lr-modal__actions">
					<button type="button" className="lr-button lr-button--secondary" onClick={onClose} disabled={submitting}>Cancel</button>
					<button className="lr-button lr-button--primary" disabled={submitting || !name.trim()}>
						{submitting ? "Creating…" : mode === "quiz" ? "Create race room" : "Create live room"}
					</button>
				</div>
			</form>
		</div>
	);
}
