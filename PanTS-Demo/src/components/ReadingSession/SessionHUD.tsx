import { IconCamera, IconMicrophone, IconMicrophoneOff } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import type { ReadingSession } from "../../helpers/readingSession";
import { countLabel, formatClock } from "../../helpers/sessionReport";
import "./ReadingSession.css";

type Props = {
	session: ReadingSession;
	onSnapshot: () => void;
	onStop: () => void;
	/** The slice views are not on screen (the report owns the layout), so a key
	 *  image cannot be taken. The button stays in the Tab ring but reads as off. */
	snapshotUnavailable?: boolean;
};

// REC pill shown in the toolbar while a reading session records: elapsed time, live
// event/key image counts, a manual key-image button, and Stop.
function SessionHUD({ session, onSnapshot, onStop, snapshotUnavailable = false }: Props) {
	// The session mutates its own arrays; a light ticker keeps the pill current.
	const [, setTick] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setTick((n) => n + 1), 500);
		return () => window.clearInterval(id);
	}, []);

	// Dictation hands the audio to the browser's speech service, which may send it to
	// its provider, so the tooltip says so wherever that service is running.
	const micText = session.micLost
		? "The microphone stopped, so narration is no longer recorded"
		: session.micGranted
		? session.dictating
			? "Narration is being recorded. Your browser's speech service transcribes it and may send the audio to its provider."
			: "Narration is being recorded"
		: "No microphone, so this session records events only";

	// Spoken once on start and once per key image. Not the pill itself, which ticks.
	const shotCount = session.shots.length;
	const [announcement, setAnnouncement] = useState("");
	const lastShots = useRef(shotCount);
	useEffect(() => {
		if (shotCount === lastShots.current) return;
		lastShots.current = shotCount;
		setAnnouncement(`Key image captured. ${shotCount} so far.`);
	}, [shotCount]);
	const micLost = session.micLost;
	useEffect(() => {
		if (micLost) setAnnouncement("The microphone stopped, so narration is no longer recorded.");
	}, [micLost]);
	useEffect(() => {
		// A pill that remounts mid-session (after the report preview) is not a new start.
		if (session.elapsedMs < 3000) setAnnouncement("Recording started.");
	}, []);

	return (
		// A group, not a status: a status region is live, so the whole pill was
		// read out again each second as the clock ticked.
		<div className="vp-rec" role="group" aria-label="Reading session recording">
			<span className="sr-only" role="status">{announcement}</span>
			<span className="vp-rec__dot" aria-hidden="true" />
			<span className="vp-rec__title">Rec</span>
			<span className="vp-rec__clock" role="timer">{formatClock(session.elapsedMs)}</span>
			<span className="vp-rec__counts">
				{countLabel(session.events.length, "event")} · {countLabel(session.shots.length, "key image")}
			</span>
			<span
				className="vp-rec__mic"
				role="img"
				aria-label={micText}
				title={micText}
			>
				{session.micGranted && !micLost ? <IconMicrophone size={14} /> : <IconMicrophoneOff size={14} />}
			</span>
			<button
				type="button"
				className="vp-rec__btn"
				onClick={onSnapshot}
				aria-disabled={snapshotUnavailable || undefined}
				title={snapshotUnavailable ? "Key images are taken from the slice views. Close the report to capture" : "Capture key image (S)"}
				aria-label="Capture key image"
			>
				<IconCamera size={15} />
				{/* Keyed on the count so each capture replays the pop; only shown at tablet and phone widths, where the text counts are hidden. */}
				<span className="vp-rec__shots" key={session.shots.length} aria-hidden="true">{session.shots.length}</span>
			</button>
			<button type="button" className="vp-rec__stop" onClick={onStop}>
				<span className="vp-rec__stopsquare" aria-hidden="true" />
				Stop
			</button>
		</div>
	);
}

export default SessionHUD;
