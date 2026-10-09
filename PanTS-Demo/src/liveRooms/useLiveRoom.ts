import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadBlob } from "../helpers/readingSession";
import {
	LIVE_ROOM_PROTOCOL,
	LIVE_ROOM_SEQUENCE_GAP_CLOSE_CODE,
	LIVE_ROOM_SEQUENCE_GAP_MS,
	MAX_LIVE_ROOM_BUFFERED_EVENTS,
	MAX_LIVE_ROOM_REPLAY_EVENTS,
	applyCommittedEvent,
	chunkMaskRanges,
	getLiveRoomParticipantCredential,
	liveRoomApiUrl,
	liveRoomParticipantStorageKey,
	liveRoomShareUrl,
	liveRoomWebSocketUrl,
	loadLiveQuizRevealMask,
	sanitizeLiveRoomPresence,
	sanitizeLiveRoomView,
	writeLiveRoomSession,
} from "./protocol";
import type {
	LiveRoomConnectionState,
	LiveRoomController,
	LiveRoomDurableCallbacks,
	LiveRoomDurableState,
	LiveRoomEvent,
	LiveRoomEventDelivery,
	LiveRoomMaskPatch,
	LiveRoomMetadata,
	LiveRoomParticipant,
	LiveQuizHostCredential,
	LiveQuizState,
	LiveQuizSubmission,
} from "./types";

type Options = {
	metadata: LiveRoomMetadata;
	roomKey: string;
	name: string;
	maskUrl: string;
	snapshotSequence: number;
	initialState: LiveRoomDurableState;
	initialQuiz: LiveQuizState | null;
	quizHostCredential?: LiveQuizHostCredential;
	onQuizHostCredentialAccepted?: () => void;
	onAuthoritativeResync?: () => void;
};

type IncomingMessage = {
	type?: string;
	participants?: LiveRoomParticipant[];
	participant?: Partial<LiveRoomParticipant> & Pick<LiveRoomParticipant, "participant_id">;
	participant_id?: string;
	snapshot?: { state?: LiveRoomDurableState };
	events?: LiveRoomEvent[];
	event?: LiveRoomEvent;
	ok?: boolean;
	partial?: boolean;
	reverted?: number;
	total?: number;
	reason?: string;
	message?: string;
	code?: string;
	fatal?: boolean;
	self?: LiveRoomParticipant;
	quiz?: LiveQuizState | {
		state?: LiveQuizState;
		own_submissions?: Record<string, LiveQuizSubmission>;
		eligible?: boolean;
	};
	submission?: LiveQuizSubmission;
	question_id?: string;
	resume_credential?: string;
	event_id?: string;
	latest_seq?: number;
	resync_required?: boolean;
	at?: string;
};

// Set on every socket error and only cleared by room.ready, so a stop that follows
// a dropped connection (expired, refused) has to clear it or it reads as "still trying".
const CONNECTION_LOST_ERROR = "Connection lost. Reconnecting…";
const REVEAL_OVERLAY_ERROR = "Could not load the lesion overlay. Trying again.";
const REVEAL_OVERLAY_GAVE_UP = "Could not load the lesion overlay. Reload the page to try again.";
const MAX_REVEAL_ATTEMPTS = 4;

type TransientMessageType = "presence.update" | "view.update";

type OutboxItem = {
	frames: Record<string, unknown>[];
	promise: Promise<boolean>;
	resolve: (committed: boolean) => void;
	callbacks?: LiveRoomDurableCallbacks;
};

function mergeParticipant(
	current: LiveRoomParticipant,
	incoming: Partial<LiveRoomParticipant> & Pick<LiveRoomParticipant, "participant_id">
): LiveRoomParticipant {
	const next = { ...current, ...incoming };
	if (current.view && incoming.view && typeof incoming.view === "object") {
		const incomingCameras = (incoming.view as { cameras?: Record<string, Record<string, unknown>> }).cameras;
		const cameras: Record<string, unknown> = { ...current.view.cameras };
		if (incomingCameras) {
			for (const [pane, camera] of Object.entries(incomingCameras)) {
				cameras[pane] = { ...(current.view.cameras[pane as keyof typeof current.view.cameras] ?? {}), ...camera };
			}
		}
		next.view = { ...current.view, ...incoming.view, cameras } as LiveRoomParticipant["view"];
	}
	return next;
}

function validQuizRevision(quiz: LiveQuizState | null | undefined): number | null {
	return quiz && Number.isSafeInteger(quiz.revision) && quiz.revision! >= 0 ? quiz.revision! : null;
}

function isSameQuizStep(current: LiveQuizState, incoming: LiveQuizState): boolean {
	return current.phase === incoming.phase
		&& current.question_index === incoming.question_index
		&& current.current_question?.id === incoming.current_question?.id;
}

export const ROOM_FULL_ERROR = "This room is full.";
export const ROOM_IDENTITY_LIMIT_ERROR = "This room has had too many visitors to admit anyone new. Ask the host to start a new room.";

/** The next step after a stopped connection. Reloading cannot get anyone into a room that refuses newcomers, so those reasons stand alone. */
export function rejoinHint(reason: string): string {
	return reason === ROOM_FULL_ERROR || reason === ROOM_IDENTITY_LIMIT_ERROR ? "" : " Reload to rejoin.";
}

/** Server validation text is written for developers; the cases a person can hit get plain wording, anything else passes through. */
export function friendlyServerError(serverMessage: string, rejectedEvent: boolean): string {
	if (/rate limit/i.test(serverMessage)) return "You are going too fast. Wait a moment and try again.";
	if (/already has \d+ participants/i.test(serverMessage)) return ROOM_FULL_ERROR;
	if (/identity limit/i.test(serverMessage)) return ROOM_IDENTITY_LIMIT_ERROR;
	if (rejectedEvent) return "That change could not be saved. Try again.";
	return serverMessage;
}

export function useLiveRoom(options: Options): LiveRoomController {
	const { metadata, roomKey, name, maskUrl: initialMaskUrl, snapshotSequence, initialState, initialQuiz } = options;
	const initialCredential = useMemo(() => getLiveRoomParticipantCredential(metadata.room_id), [metadata.room_id]);
	const [participantId, setParticipantId] = useState(initialCredential?.participantId ?? "");
	const [connectionState, setConnectionState] = useState<LiveRoomConnectionState>("connecting");
	const [participants, setParticipants] = useState<LiveRoomParticipant[]>([]);
	const [state, setState] = useState<LiveRoomDurableState>(initialState);
	const [pendingEvents, setPendingEvents] = useState<LiveRoomEventDelivery[]>([]);
	const [followingId, setFollowingId] = useState<string | null>(null);
	const [revealAttempt, setRevealAttempt] = useState(0);
	const [error, setError] = useState<string | null>(null);
	const [undoNotice, setUndoNotice] = useState<string | null>(null);
	const [maskUrl, setMaskUrl] = useState(initialMaskUrl);
	const [quiz, setQuiz] = useState<LiveQuizState | null>(initialQuiz);
	const [quizOwnSubmissions, setQuizOwnSubmissions] = useState<Record<string, LiveQuizSubmission>>({});
	const [quizEligible, setQuizEligible] = useState(false);
	// Server time minus this device's time, so deadlines stamped on the server's clock count down correctly.
	const [clockOffsetMs, setClockOffsetMs] = useState(0);
	const [selfRole, setSelfRole] = useState<LiveRoomParticipant["role"]>(metadata.mode === "quiz" ? "student" : "reviewer");
	const websocketRef = useRef<WebSocket | null>(null);
	const participantCredentialRef = useRef(initialCredential);
	const participantIdRef = useRef(initialCredential?.participantId ?? "");
	const lastSeqRef = useRef(snapshotSequence);
	const reconnectAttemptRef = useRef(0);
	const reconnectTimerRef = useRef<number | null>(null);
	const stoppedRef = useRef(false);
	const followingIdRef = useRef<string | null>(null);
	const revealFailuresRef = useRef(0);
	const lastTransientRef = useRef<Partial<Record<TransientMessageType, number>>>({});
	const pendingTransientRef = useRef<Partial<Record<TransientMessageType, Record<string, unknown>>>>({});
	// The server builds a fresh Peer, with no presence or view, on every (re)join, so the
	// merged latest payload per type is kept to repopulate it when room.ready arrives.
	const lastPayloadRef = useRef<Partial<Record<TransientMessageType, Record<string, unknown>>>>({});
	const transientTimerRef = useRef<Partial<Record<TransientMessageType, number>>>({});
	const undoTimerRef = useRef<number | null>(null);
	const errorTimerRef = useRef<number | null>(null);
	const sequenceGapTimerRef = useRef<number | null>(null);
	const bufferedEventsRef = useRef(new Map<number, LiveRoomEventDelivery>());
	const quizRevealMaskRef = useRef<string | null>(null);
	const outboxRef = useRef(new Map<string, OutboxItem>());
	const quizRef = useRef(initialQuiz);
	const quizRevisionRef = useRef(validQuizRevision(initialQuiz));
	const quizHostCredentialRef = useRef(options.quizHostCredential);
	const quizHostModeRef = useRef(options.quizHostCredential?.mode ?? null);
	const authoritativeResyncRequestedRef = useRef(false);
	const onQuizHostCredentialAcceptedRef = useRef(options.onQuizHostCredentialAccepted);
	const onAuthoritativeResyncRef = useRef(options.onAuthoritativeResync);
	onQuizHostCredentialAcceptedRef.current = options.onQuizHostCredentialAccepted;
	onAuthoritativeResyncRef.current = options.onAuthoritativeResync;
	const isHost = selfRole === "host";
	const collaborationLocked = metadata.mode === "quiz" && Boolean(
		quiz && ["question_open", "question_closed"].includes(quiz.phase)
	);

	const noteServerTime = useCallback((at: unknown) => {
		const serverTime = typeof at === "string" ? Date.parse(at) : Number.NaN;
		if (Number.isFinite(serverTime)) setClockOffsetMs(serverTime - Date.now());
	}, []);

	const sendFrame = useCallback((message: Record<string, unknown>): boolean => {
		const socket = websocketRef.current;
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		try {
			socket.send(JSON.stringify(message));
			return true;
		} catch {
			return false;
		}
	}, []);

	const requestAuthoritativeResync = useCallback(() => {
		if (authoritativeResyncRequestedRef.current) return;
		authoritativeResyncRequestedRef.current = true;
		onAuthoritativeResyncRef.current?.();
	}, []);

	const applyQuizState = useCallback((incoming: LiveQuizState, orderedEvent = false): "full" | "compatible" | "ignored" => {
		const incomingRevision = validQuizRevision(incoming);
		const currentRevision = quizRevisionRef.current;
		if (incomingRevision !== null) {
			if (currentRevision !== null && incomingRevision < currentRevision) return "ignored";
			if (currentRevision === null || incomingRevision > currentRevision) {
				quizRevisionRef.current = incomingRevision;
				quizRef.current = incoming;
				setQuiz(incoming);
				return "full";
			}
			return quizRef.current && isSameQuizStep(quizRef.current, incoming) ? "compatible" : "ignored";
		}

		if (orderedEvent && currentRevision === null) {
			quizRef.current = incoming;
			setQuiz(incoming);
			return "full";
		}
		if (currentRevision !== null) return "ignored";
		const current = quizRef.current;
		if (!current || !isSameQuizStep(current, incoming)) return "ignored";
		const next = {
			...current,
			response_count: incoming.response_count,
			eligible_count: incoming.eligible_count,
		};
		quizRef.current = next;
		setQuiz(next);
		return "compatible";
	}, []);

	const acknowledgeQuizHostClaim = useCallback(() => {
		if (quizHostModeRef.current === "modern") sendFrame({ type: "host.claim_ack" });
		if (quizHostModeRef.current === "legacy" && quizHostCredentialRef.current) {
			quizHostCredentialRef.current = undefined;
			onQuizHostCredentialAcceptedRef.current?.();
		}
	}, [sendFrame]);

	const flushOutbox = useCallback(() => {
		for (const item of outboxRef.current.values()) {
			for (const frame of item.frames) sendFrame(frame);
		}
	}, [sendFrame]);

	const rejectOutboxItem = useCallback((item: OutboxItem, recover: boolean) => {
		item.resolve(false);
		if (recover) item.callbacks?.onRejected?.();
	}, []);

	const failOutbox = useCallback((recover = true) => {
		for (const item of outboxRef.current.values()) rejectOutboxItem(item, recover);
		outboxRef.current.clear();
	}, [rejectOutboxItem]);

	const flushTransient = useCallback((type: TransientMessageType) => {
		const payload = pendingTransientRef.current[type];
		if (!payload || !sendFrame({ type, payload })) return;
		delete pendingTransientRef.current[type];
		lastTransientRef.current[type] = performance.now();
	}, [sendFrame]);

	const sendTransient = useCallback((type: TransientMessageType, payload: Record<string, unknown>) => {
		pendingTransientRef.current[type] = {
			...pendingTransientRef.current[type],
			...payload,
		};
		// A pointer position is stale by the time a reconnect lands, so it is not kept.
		const durable = { ...lastPayloadRef.current[type], ...payload };
		delete durable.cursor;
		lastPayloadRef.current[type] = durable;
		const elapsed = performance.now() - (lastTransientRef.current[type] ?? -Infinity);
		const remaining = Math.max(0, 50 - elapsed);
		if (remaining === 0) {
			const timer = transientTimerRef.current[type];
			if (timer !== undefined) {
				window.clearTimeout(timer);
				delete transientTimerRef.current[type];
			}
			flushTransient(type);
			return;
		}
		if (transientTimerRef.current[type] !== undefined) return;
		transientTimerRef.current[type] = window.setTimeout(() => {
			delete transientTimerRef.current[type];
			flushTransient(type);
		}, remaining);
	}, [flushTransient]);

	// A participant who leaves takes their Follow toggle with them, so a stale id would
	// keep this tab from sharing its own view with nobody left to undo it.
	const dropFollowIfGone = useCallback((remaining: LiveRoomParticipant[]) => {
		const followed = followingIdRef.current;
		if (!followed || remaining.some((item) => item.participant_id === followed)) return;
		followingIdRef.current = null;
		setFollowingId(null);
		sendTransient("presence.update", { following: null });
	}, [sendTransient]);

	const clearSequenceGapTimer = useCallback(() => {
		if (sequenceGapTimerRef.current !== null) window.clearTimeout(sequenceGapTimerRef.current);
		sequenceGapTimerRef.current = null;
	}, []);

	const scheduleSequenceGapRecovery = useCallback(() => {
		if (sequenceGapTimerRef.current !== null || stoppedRef.current) return;
		sequenceGapTimerRef.current = window.setTimeout(() => {
			sequenceGapTimerRef.current = null;
			bufferedEventsRef.current.clear();
			setError("The live room missed an update. Resynchronizing…");
			const socket = websocketRef.current;
			if (socket) socket.close(LIVE_ROOM_SEQUENCE_GAP_CLOSE_CODE, "Sequence gap resync");
		}, LIVE_ROOM_SEQUENCE_GAP_MS);
	}, []);

	const acceptCommittedEvents = useCallback((events: LiveRoomEvent[], replayed: boolean) => {
		for (const event of events) {
			const queued = outboxRef.current.get(event.event_id);
			if (queued) {
				outboxRef.current.delete(event.event_id);
				queued.resolve(true);
			}
			if (event.seq <= lastSeqRef.current) continue;
			const existing = bufferedEventsRef.current.get(event.seq);
			bufferedEventsRef.current.set(event.seq, {
				event,
				replayed: replayed || Boolean(existing?.replayed),
			});
		}
		const contiguous: LiveRoomEventDelivery[] = [];
		let nextSequence = lastSeqRef.current + 1;
		while (bufferedEventsRef.current.has(nextSequence)) {
			const delivery = bufferedEventsRef.current.get(nextSequence);
			if (!delivery) break;
			bufferedEventsRef.current.delete(nextSequence);
			contiguous.push(delivery);
			nextSequence += 1;
		}
		if (contiguous.length) {
			lastSeqRef.current = contiguous[contiguous.length - 1].event.seq;
			for (const { event } of contiguous) {
				const eventQuiz = (event.payload as { quiz?: LiveQuizState }).quiz;
				if (eventQuiz) applyQuizState(eventQuiz, true);
			}
			setState((current) => contiguous.reduce(
				(next, delivery) => applyCommittedEvent(next, delivery.event),
				current
			));
			setPendingEvents((current) => [...current, ...contiguous]);
		}
		if (bufferedEventsRef.current.size > MAX_LIVE_ROOM_BUFFERED_EVENTS) {
			clearSequenceGapTimer();
			bufferedEventsRef.current.clear();
			requestAuthoritativeResync();
			return;
		}
		if (!contiguous.length) {
			if (bufferedEventsRef.current.size) scheduleSequenceGapRecovery();
			return;
		}
		if (bufferedEventsRef.current.size) scheduleSequenceGapRecovery();
		else clearSequenceGapTimer();
	}, [applyQuizState, clearSequenceGapTimer, requestAuthoritativeResync, scheduleSequenceGapRecovery]);

	const acknowledgeEvents = useCallback((throughSequence: number) => {
		setPendingEvents((current) => current.filter((delivery) => delivery.event.seq > throughSequence));
	}, []);

	const connect = useCallback(() => {
		if (stoppedRef.current) return;
		setConnectionState(reconnectAttemptRef.current ? "reconnecting" : "connecting");
		const socket = new WebSocket(liveRoomWebSocketUrl(metadata.room_id));
		websocketRef.current = socket;

		socket.addEventListener("open", () => {
			socket.send(JSON.stringify({
				type: "hello",
				protocol: LIVE_ROOM_PROTOCOL,
				room_key: roomKey,
				...(participantCredentialRef.current
					? {
						participant_id: participantCredentialRef.current.participantId,
						resume_credential: participantCredentialRef.current.resumeCredential,
					}
					: {}),
				name,
				last_seq: lastSeqRef.current,
				...(metadata.mode === "quiz" && !participantCredentialRef.current && quizHostCredentialRef.current
					? quizHostCredentialRef.current.mode === "modern"
						? { quiz_host_claim: quizHostCredentialRef.current.value }
						: { quiz_host_secret: quizHostCredentialRef.current.value }
					: {}),
			}));
		});

		socket.addEventListener("message", (messageEvent) => {
			let message: IncomingMessage;
			try {
				message = JSON.parse(String(messageEvent.data)) as IncomingMessage;
			} catch {
				setError("The live room sent a message this page could not read.");
				return;
			}
			if (message.type === "pong") {
				noteServerTime(message.at);
				return;
			}
			if (message.type === "room.ready") {
				reconnectAttemptRef.current = 0;
				setConnectionState("connected");
				// The first interval ping is 20 s away, so ask for the server time now.
				noteServerTime(message.at);
				sendFrame({ type: "ping" });
				setError(null);
				if (revealFailuresRef.current > 0) {
					revealFailuresRef.current = 0;
					setRevealAttempt((attempt) => attempt + 1);
				}
				if (Array.isArray(message.participants)) {
					setParticipants((current) => JSON.stringify(current) === JSON.stringify(message.participants) ? current : message.participants!);
					dropFollowIfGone(message.participants);
				}
				if (message.self?.participant_id) {
					participantIdRef.current = message.self.participant_id;
					setParticipantId(message.self.participant_id);
					if (message.resume_credential) {
						const credential = {
							participantId: message.self.participant_id,
							resumeCredential: message.resume_credential,
						};
						participantCredentialRef.current = credential;
						writeLiveRoomSession(liveRoomParticipantStorageKey(metadata.room_id), JSON.stringify(credential));
					}
				}
				if (message.self?.role) {
					setSelfRole(message.self.role);
					if (message.self.role === "host") acknowledgeQuizHostClaim();
				}
				if (message.resync_required) {
					if (metadata.mode === "review") {
						requestAuthoritativeResync();
						return;
					}
					bufferedEventsRef.current.clear();
					clearSequenceGapTimer();
					setPendingEvents([]);
					lastSeqRef.current = message.latest_seq ?? lastSeqRef.current;
					if (message.snapshot?.state) setState(message.snapshot.state);
					if (message.quiz && "state" in message.quiz && message.quiz.state) applyQuizState(message.quiz.state);
				}
				if (message.snapshot?.state) setState(message.snapshot.state);
				if (message.quiz && "state" in message.quiz) {
					const application = message.quiz.state ? applyQuizState(message.quiz.state) : "ignored";
					if (application !== "ignored") {
						setQuizOwnSubmissions(message.quiz.own_submissions ?? {});
						setQuizEligible(Boolean(message.quiz.eligible));
					}
				}
				const events = Array.isArray(message.events) ? message.events as LiveRoomEvent[] : [];
				if (events.length > MAX_LIVE_ROOM_REPLAY_EVENTS) {
					requestAuthoritativeResync();
					return;
				}
				if (!message.resync_required) acceptCommittedEvents([...events].sort((a, b) => a.seq - b.seq), true);
				if (message.latest_seq && message.latest_seq > lastSeqRef.current && events.length === 0) {
					scheduleSequenceGapRecovery();
				}
				flushOutbox();
				// Anything the last socket already delivered is gone with its Peer, so send
				// it again under whatever is still pending. A follower's view is the
				// leader's, so it is not re-sent while following.
				for (const type of ["presence.update", "view.update"] as const) {
					const last = lastPayloadRef.current[type];
					if (last && !(type === "view.update" && followingIdRef.current)) {
						pendingTransientRef.current[type] = { ...last, ...pendingTransientRef.current[type] };
					}
					flushTransient(type);
				}
				return;
			}
			if (message.type === "event.committed" && message.event) {
				acceptCommittedEvents([message.event as LiveRoomEvent], false);
				return;
			}
			if (message.type === "quiz.state" && message.quiz && !("state" in message.quiz)) {
				applyQuizState(message.quiz as LiveQuizState);
				return;
			}
			if (message.type === "quiz.personal" && message.quiz && "state" in message.quiz) {
				const application = message.quiz.state ? applyQuizState(message.quiz.state) : "ignored";
				if (application !== "ignored") {
					setQuizOwnSubmissions(message.quiz.own_submissions ?? {});
					setQuizEligible(Boolean(message.quiz.eligible));
				}
				return;
			}
			if (message.type === "quiz.answer.accepted" && message.question_id && message.submission) {
				setQuizOwnSubmissions((current) => ({ ...current, [message.question_id!]: message.submission! }));
				return;
			}
			if (message.type === "quiz.host.promoted") {
				if (message.quiz && !("state" in message.quiz)) applyQuizState(message.quiz as LiveQuizState);
				setSelfRole("host");
				return;
			}
			if (message.type === "quiz.host.claim.accepted") {
				setSelfRole("host");
				return;
			}
			if (message.type === "host.claim_acknowledged") {
				if (quizHostModeRef.current === "modern" && quizHostCredentialRef.current) {
					quizHostCredentialRef.current = undefined;
					onQuizHostCredentialAcceptedRef.current?.();
				}
				return;
			}
			if (message.type === "resync.required" || message.type === "room.resync_required") {
				requestAuthoritativeResync();
				return;
			}
			if (message.type === "presence.changed") {
				if (Array.isArray(message.participants)) {
					setParticipants((current) => JSON.stringify(current) === JSON.stringify(message.participants) ? current : message.participants!);
					const self = message.participants.find((item) => item.participant_id === participantIdRef.current);
					if (self?.role) setSelfRole(self.role);
					dropFollowIfGone(message.participants);
				} else if (message.participant?.participant_id) {
					const participant = message.participant;
					setParticipants((current) => {
						const index = current.findIndex((item) => item.participant_id === participant.participant_id);
						if (index < 0) {
							if (!participant.name || !participant.color || !participant.role) return current;
							return [...current, participant as LiveRoomParticipant];
						}
						const merged = mergeParticipant(current[index], participant);
						if (JSON.stringify(merged) === JSON.stringify(current[index])) return current;
						const next = [...current];
						next[index] = merged;
						return next;
					});
				} else if (message.participant_id) {
					if (message.participant_id === followingIdRef.current) dropFollowIfGone([]);
					setParticipants((current) => current.filter((item) => item.participant_id !== message.participant_id));
				}
				return;
			}
			if (message.type === "undo.result") {
				const notice = message.ok
					? message.partial
						? `Partial undo: restored ${message.reverted ?? 0} of ${message.total ?? 0} voxels`
						: "Your latest change was undone"
					: String(message.reason || "Nothing to undo");
				setUndoNotice(notice);
				if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
				undoTimerRef.current = window.setTimeout(() => {
					undoTimerRef.current = null;
					setUndoNotice(null);
				}, 5000);
				return;
			}
			// A tab that was offline past the expiry only learns it from the join error on reconnect.
			if (message.type === "room.expired" || (message.type === "error" && (message.code === "room_expired" || message.code === "room_not_found"))) {
				setConnectionState("expired");
				setError((current) => current === CONNECTION_LOST_ERROR ? null : current);
				stoppedRef.current = true;
				failOutbox(true);
				if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
				return;
			}
			if (message.type === "error") {
				const serverMessage = String(message.message || "Something went wrong in the live room.");
				const friendly = friendlyServerError(serverMessage, Boolean(message.event_id));
				if (friendly !== serverMessage) console.error("Live room error", serverMessage);
				setError(friendly);
				if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
				// A fatal error stays; anything else clears itself, and only if it is still the one showing.
				errorTimerRef.current = message.fatal ? null : window.setTimeout(() => {
					errorTimerRef.current = null;
					setError((current) => current === friendly ? null : current);
				}, 6000);
				if (message.event_id) {
					const queued = outboxRef.current.get(message.event_id);
					if (queued) {
						outboxRef.current.delete(message.event_id);
						rejectOutboxItem(queued, true);
					}
				}
				if (message.fatal) {
					failOutbox(true);
					stoppedRef.current = true;
					setConnectionState("error");
				}
			}
		});

		socket.addEventListener("close", (event) => {
			// A previous socket can finish closing after Strict Mode (or a fast
			// reconnect) has already installed its replacement.  Its delayed close
			// must not schedule another connection that would evict the live socket.
			if (websocketRef.current !== socket) return;
			websocketRef.current = null;
			if (stoppedRef.current) return;
			if (event.code === 4000 || event.code === 4001 || event.code === 4003) {
				stoppedRef.current = true;
				failOutbox(event.code !== 4000);
				if (event.code === 4000) {
					setConnectionState("disconnected");
					setError("This live room connection was replaced by another tab.");
				} else {
					setConnectionState(event.code === 4001 ? "expired" : "error");
					setError((current) => current === CONNECTION_LOST_ERROR ? null : current);
				}
				return;
			}
			setConnectionState("reconnecting");
			const delay = Math.min(10_000, 500 * 2 ** reconnectAttemptRef.current);
			reconnectAttemptRef.current += 1;
			reconnectTimerRef.current = window.setTimeout(connect, delay);
		});

		socket.addEventListener("error", () => {
			// A room that already stopped (expired or fatal) must not get the reconnect text back.
			if (websocketRef.current !== socket || stoppedRef.current) return;
			setError(CONNECTION_LOST_ERROR);
		});
	}, [acceptCommittedEvents, acknowledgeQuizHostClaim, applyQuizState, clearSequenceGapTimer, failOutbox, flushOutbox, flushTransient, metadata.mode, metadata.room_id, name, dropFollowIfGone, noteServerTime, sendFrame, rejectOutboxItem, requestAuthoritativeResync, roomKey, scheduleSequenceGapRecovery]);

	useEffect(() => {
		stoppedRef.current = false;
		const bufferedEvents = bufferedEventsRef.current;
		connect();
		const ping = window.setInterval(() => sendFrame({ type: "ping" }), 20_000);
		return () => {
			stoppedRef.current = true;
			window.clearInterval(ping);
			if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
			if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
			if (errorTimerRef.current !== null) window.clearTimeout(errorTimerRef.current);
			clearSequenceGapTimer();
			for (const timer of Object.values(transientTimerRef.current)) {
				if (timer !== undefined) window.clearTimeout(timer);
			}
			transientTimerRef.current = {};
			bufferedEvents.clear();
			failOutbox(false);
			websocketRef.current?.close(1000, "Page closed");
			websocketRef.current = null;
		};
	}, [clearSequenceGapTimer, connect, failOutbox, sendFrame]);

	useEffect(() => {
		const shouldReveal = Boolean(quiz?.reveal?.viewer_cue?.show_lesion_overlay);
		if (!shouldReveal) {
			// The host moved past the reveal: drop the retry state so the next reveal question starts fresh.
			revealFailuresRef.current = 0;
			setError((current) => current === REVEAL_OVERLAY_ERROR || current === REVEAL_OVERLAY_GAVE_UP ? null : current);
			return;
		}
		if (quizRevealMaskRef.current) return;
		let active = true;
		let retryTimer: number | null = null;
		void loadLiveQuizRevealMask(metadata.room_id, roomKey).then((url) => {
			if (!active) {
				URL.revokeObjectURL(url);
				return;
			}
			revealFailuresRef.current = 0;
			quizRevealMaskRef.current = url;
			setMaskUrl(url);
			setError((current) => current === REVEAL_OVERLAY_ERROR || current === REVEAL_OVERLAY_GAVE_UP ? null : current);
		}).catch((caught) => {
			if (!active) return;
			console.error("Live quiz reveal overlay failed", caught);
			revealFailuresRef.current += 1;
			// Retry on a short backoff; a reconnect also retries (room.ready bumps the attempt).
			if (revealFailuresRef.current < MAX_REVEAL_ATTEMPTS) {
				setError(REVEAL_OVERLAY_ERROR);
				retryTimer = window.setTimeout(() => setRevealAttempt((attempt) => attempt + 1), 3000 * revealFailuresRef.current);
			} else {
				setError(REVEAL_OVERLAY_GAVE_UP);
			}
		});
		return () => {
			active = false;
			if (retryTimer !== null) window.clearTimeout(retryTimer);
		};
	}, [metadata.room_id, quiz?.reveal?.viewer_cue?.show_lesion_overlay, roomKey, revealAttempt]);

	useEffect(() => () => {
		if (quizRevealMaskRef.current) URL.revokeObjectURL(quizRevealMaskRef.current);
	}, []);

	const sendDurable = useCallback<LiveRoomController["sendDurable"]>((type, payload, eventId, callbacks) => {
		if (["disconnected", "expired", "error"].includes(connectionState) || collaborationLocked) {
			callbacks?.onRejected?.();
			return Promise.resolve(false);
		}
		let frames: Record<string, unknown>[];
		let durableEventId = eventId || crypto.randomUUID();
		if (type === "mask.patch") {
			const patch = payload as unknown as LiveRoomMaskPatch;
			if (!patch.ranges.length) {
				callbacks?.onRejected?.();
				return Promise.resolve(false);
			}
			const chunks = chunkMaskRanges(patch.ranges);
			durableEventId = eventId || patch.operation_id || durableEventId;
			frames = chunks.map((ranges, chunkIndex) => ({
				type,
				event_id: durableEventId,
				payload: {
					...patch,
					operation_id: durableEventId,
					ranges,
					chunk_index: chunkIndex,
					chunk_count: chunks.length,
				},
			}));
		} else {
			frames = [{ type, event_id: durableEventId, payload }];
		}
		const existing = outboxRef.current.get(durableEventId);
		if (existing) return existing.promise;
		let resolve!: (committed: boolean) => void;
		const promise = new Promise<boolean>((done) => { resolve = done; });
		outboxRef.current.set(durableEventId, { frames, promise, resolve, callbacks });
		if (connectionState === "connected") {
			for (const frame of frames) sendFrame(frame);
		}
		return promise;
	}, [collaborationLocked, connectionState, sendFrame]);

	const sendChat = useCallback((text: string) => sendDurable("chat.add", {
		message: { id: crypto.randomUUID(), author: name, text },
	}), [name, sendDurable]);

	const addNote = useCallback((text: string, world: [number, number, number], plane: string, organLabel = "") =>
		sendDurable("note.upsert", {
			note: { id: crypto.randomUUID(), author: name, text, world, plane, organ_label: organLabel },
		}), [name, sendDurable]);

	const deleteNote = useCallback((id: string) => sendDurable("note.delete", { id }), [sendDurable]);

	const requestUndo = useCallback(() => {
		if (connectionState === "connected" && !collaborationLocked) sendFrame({ type: "undo.request" });
	}, [collaborationLocked, connectionState, sendFrame]);

	const follow = useCallback((id: string) => {
		followingIdRef.current = id;
		setFollowingId(id);
		sendTransient("presence.update", { following: id });
	}, [sendTransient]);

	const stopFollowing = useCallback(() => {
		followingIdRef.current = null;
		setFollowingId(null);
		sendTransient("presence.update", { following: null });
	}, [sendTransient]);

	const sendPresence = useCallback((payload: Record<string, unknown>) => {
		const clean = sanitizeLiveRoomPresence(payload);
		if (Object.keys(clean).length) sendTransient("presence.update", clean);
	}, [sendTransient]);

	const sendView = useCallback((payload: Record<string, unknown>) => {
		const clean = sanitizeLiveRoomView(payload);
		if (Object.keys(clean).length) sendTransient("view.update", clean);
	}, [sendTransient]);

	const copyShareLink = useCallback(async () => {
		const url = liveRoomShareUrl(metadata.room_id, roomKey);
		try {
			await navigator.clipboard.writeText(url);
			return true;
		} catch {
			window.prompt("Copy the live room link:", url);
			return false;
		}
	}, [metadata.room_id, roomKey]);

	const downloadExport = useCallback(async (kind: "zip" | "pdf") => {
		const suffix = kind === "zip" ? "/export.zip" : "/report.pdf";
		const response = await fetch(liveRoomApiUrl(metadata.room_id, suffix), {
			headers: { "X-Room-Key": roomKey },
		});
		if (!response.ok) {
			const body = await response.json().catch(() => ({}));
			throw new Error(body.error || `Export failed (${response.status})`);
		}
		downloadBlob(
			await response.blob(),
			kind === "zip" ? `bodymaps-live-room-${metadata.room_id}.zip` : `bodymaps-live-room-${metadata.room_id}.pdf`
		);
	}, [metadata.room_id, roomKey]);

	const startQuiz = useCallback(() => connectionState === "connected" && sendFrame({ type: "quiz.start" }), [connectionState, sendFrame]);
	const answerQuiz = useCallback((choiceId: string) => connectionState === "connected" && sendFrame({ type: "quiz.answer", choice_id: choiceId }), [connectionState, sendFrame]);
	const closeQuiz = useCallback(() => connectionState === "connected" && sendFrame({ type: "quiz.close" }), [connectionState, sendFrame]);
	const revealQuiz = useCallback(() => connectionState === "connected" && sendFrame({ type: "quiz.reveal" }), [connectionState, sendFrame]);
	const advanceQuiz = useCallback(() => connectionState === "connected" && sendFrame({ type: "quiz.advance" }), [connectionState, sendFrame]);

	return {
		metadata,
		roomKey,
		maskUrl,
		participantId,
		name,
		connectionState,
		clockOffsetMs,
		participants,
		state,
		pendingEvents,
		acknowledgeEvents,
		followingId,
		error,
		undoNotice,
		quiz,
		quizOwnSubmissions,
		quizEligible,
		isHost,
		collaborationLocked,
		sendDurable,
		sendPresence,
		sendView,
		sendChat,
		addNote,
		deleteNote,
		requestUndo,
		follow,
		stopFollowing,
		copyShareLink,
		downloadExport,
		startQuiz,
		answerQuiz,
		closeQuiz,
		revealQuiz,
		advanceQuiz,
	};
}
