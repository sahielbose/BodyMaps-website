import { IconUsersGroup } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import MessagePage from "../components/MessagePage";
import VisualizationPage from "../routes/VisualizationPage";
import { appRootRelativeUrl, bootstrapLiveRoom, getLiveRoomParticipantCredential, LiveRoomRequestError, readLiveRoomSession, roomKeyFromFragment, writeLiveRoomSession } from "./protocol";
import type { LiveQuizHostCredential, LiveQuizState, LiveRoomDurableState, LiveRoomMetadata } from "./types";
import { useLiveRoom } from "./useLiveRoom";
import "./liveRooms.css";

type Bootstrap = {
	metadata: LiveRoomMetadata;
	state: LiveRoomDurableState;
	maskUrl: string;
	snapshotSequence: number;
	quiz: LiveQuizState | null;
};

type LiveRoomNavigationState = {
	liveRoomCreation?: {
		creatorName?: string;
		quizHostCredential?: LiveQuizHostCredential;
	};
};

function JoinDialog({ initialName, onJoin }: { initialName: string; onJoin: (name: string) => void }) {
	const [name, setName] = useState(initialName);
	return (
		<main className="lr-page lr-page--center">
			<form className="lr-modal lr-join" onSubmit={(event) => {
				event.preventDefault();
				if (name.trim()) onJoin(name.trim());
			}}>
				<div className="lr-join__mark"><IconUsersGroup size={24} /></div>
				<span className="lr-eyebrow">BodyMaps live room</span>
				<h1>Join live room</h1>
				<p>Enter a display name to join synchronized scan review or a private-answer quiz.</p>
				<label className="lr-field">
					<span>Display name</span>
					<input autoFocus maxLength={32} value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
				</label>
				<button className="lr-button lr-button--primary lr-button--wide" disabled={!name.trim()}>Join room</button>
				<small>Temporary name stays in this browser tab for reconnect only.</small>
			</form>
		</main>
	);
}

/** What went wrong, as far as the person holding the link can act on it. */
type RoomFailure = "expired" | "link" | "key" | "unavailable";

function roomFailure(error: Error): RoomFailure {
	const status = error instanceof LiveRoomRequestError ? error.status : null;
	if (status === 410 || /expired|deleted/i.test(error.message)) return "expired";
	// No such room (404) or a wrong key (401): the link is incomplete, or the room
	// is gone (cleanup deletes it after 24 hours, so a 404 is usually that).
	// Anything else (a server that's down, a network failure) is not.
	if (status === 404 || status === 401) return "link";
	return "unavailable";
}

// A branded site page rather than a bare dark card. The way back is a full page load
// (plain href), so nothing from the failed room lingers in memory.
function LiveRoomErrorPage({ message, failure, roomId, onRetry }: { message: string; failure: RoomFailure; roomId: string; onRetry?: () => void }) {
	const caseId = readLiveRoomSession(`bodymaps.live-room.${roomId}.case-id`);
	const expired = failure === "expired";
	const detail = /[.!?]$/.test(message) ? message : `${message}.`;
	const wholeLink = "Check that you have the whole link, including the part after the #.";
	return (
		<MessagePage
			eyebrow="Live room"
			title={expired ? "This live room has expired" : "This live room isn't available"}
			actions={[
				// Only a transient failure is worth another attempt; an expired room or a bad link is final.
				...(failure === "unavailable" && onRetry ? [{ label: "Try again", onClick: onRetry }] : []),
				caseId
					? { label: `Back to case ${caseId}`, href: appRootRelativeUrl(`/case/${caseId}`) }
					: { label: "Browse the dataset", href: appRootRelativeUrl("/dashboard") },
				...(caseId ? [{ label: "Browse the dataset", href: appRootRelativeUrl("/dashboard") }] : []),
			]}
			alert
		>
			<p>
				{expired
					? "Room data is deleted 24 hours after the room is created. Ask the host to start a new room."
					: failure === "link"
						? `This room may have expired (rooms are deleted 24 hours after they are created) or the link may be incomplete. ${wholeLink}`
						: failure === "key"
							? `${detail} ${wholeLink}`
							: "We couldn't load this room. Try again in a moment."}
			</p>
		</MessagePage>
	);
}

function ConnectedRoom({ bootstrap, roomKey, name, quizHostCredential, onQuizHostCredentialAccepted }: {
	bootstrap: Bootstrap;
	roomKey: string;
	name: string;
	quizHostCredential?: LiveQuizHostCredential;
	onQuizHostCredentialAccepted: () => void;
}) {
	const controller = useLiveRoom({
		metadata: bootstrap.metadata,
		roomKey,
		name,
		maskUrl: bootstrap.maskUrl,
		snapshotSequence: bootstrap.snapshotSequence,
		initialState: bootstrap.state,
		initialQuiz: bootstrap.quiz,
		quizHostCredential,
		onQuizHostCredentialAccepted,
		onAuthoritativeResync: () => window.location.reload(),
	});
	return <VisualizationPage liveRoom={controller} />;
}

function BootstrappingRoom({ roomId, roomKey, name, quizHostCredential, onQuizHostCredentialAccepted }: {
	roomId: string;
	roomKey: string;
	name: string;
	quizHostCredential?: LiveQuizHostCredential;
	onQuizHostCredentialAccepted: () => void;
}) {
	const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
	const [error, setError] = useState<Error | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let active = true;
		let ownedMaskUrl: string | null = null;
		setBootstrap(null);
		setError(null);
		bootstrapLiveRoom(roomId, roomKey).then((result) => {
			if (!active) {
				URL.revokeObjectURL(result.maskUrl);
				return;
			}
			ownedMaskUrl = result.maskUrl;
			writeLiveRoomSession(`bodymaps.live-room.${roomId}.case-id`, result.metadata.case_id);
			setBootstrap(result);
		}).catch((caught) => {
			if (active) setError(caught instanceof Error ? caught : new Error("Room unavailable"));
		});
		return () => {
			active = false;
			if (ownedMaskUrl) URL.revokeObjectURL(ownedMaskUrl);
		};
	}, [roomId, roomKey, attempt]);

	if (error) return <LiveRoomErrorPage message={error.message} failure={roomFailure(error)} roomId={roomId} onRetry={() => setAttempt((value) => value + 1)} />;
	if (!bootstrap) return (
		<main>
			<div className="lr-page lr-page--center" role="status">
				<div className="lr-loading-ring" />
				<p>Loading shared scan…</p>
			</div>
		</main>
	);
	return <ConnectedRoom key={`${roomId}:${roomKey}`} bootstrap={bootstrap} roomKey={roomKey} name={name} quizHostCredential={quizHostCredential} onQuizHostCredentialAccepted={onQuizHostCredentialAccepted} />;
}

export default function LiveRoomPage() {
	const { roomId = "" } = useParams();
	const location = useLocation();
	const navigate = useNavigate();
	const roomKey = roomKeyFromFragment();
	const storedName = readLiveRoomSession("bodymaps.live-room.name") || "";
	const navigationState = location.state as LiveRoomNavigationState | null;
	const creation = navigationState?.liveRoomCreation;
	const [name, setName] = useState<string | null>(() => {
		if (creation?.creatorName) return creation.creatorName;
		return storedName && getLiveRoomParticipantCredential(roomId) ? storedName : null;
	});
	const [quizHostCredential, setQuizHostCredential] = useState(creation?.quizHostCredential);
	const clearQuizHostCredential = () => {
		setQuizHostCredential(undefined);
		navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
	};

	useEffect(() => {
		document.querySelector('meta[name="referrer"]')?.setAttribute("content", "no-referrer");
	}, []);

	if (!roomKey) return <LiveRoomErrorPage message="Room link is missing its secret key." failure="key" roomId={roomId} />;
	if (!name) return <JoinDialog initialName={storedName} onJoin={(value) => {
		writeLiveRoomSession("bodymaps.live-room.name", value);
		setName(value);
	}} />;
	return <BootstrappingRoom key={`${roomId}:${roomKey}`} roomId={roomId} roomKey={roomKey} name={name} quizHostCredential={quizHostCredential} onQuizHostCredentialAccepted={clearQuizHostCredential} />;
}
