import {
	IconArrowLeft,
	IconCheck,
	IconCloudDownload,
	IconFileTypePdf,
	IconMessage,
	IconNote,
	IconShare,
	IconUsersGroup,
	IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CinePane } from "../helpers/CornerstoneNifti2";
import { appRootRelativeUrl } from "./protocol";
import type { LiveRoomController } from "./types";
import { rejoinHint } from "./useLiveRoom";
import LiveQuizDock from "./LiveQuizDock";
import { measurementToolName } from "../helpers/measurementTools";
import { nameInitial, refocusComposer, submitOnEnter, useRoomExport, useSendOnce } from "./composerHelpers";

type DockTab = "people" | "notes" | "chat";

const DOCK_TABS: { id: DockTab; label: string; Icon: typeof IconUsersGroup }[] = [
	{ id: "people", label: "People", Icon: IconUsersGroup },
	{ id: "notes", label: "Notes", Icon: IconNote },
	{ id: "chat", label: "Chat", Icon: IconMessage },
];

// Presence carries raw tool ids: the Cornerstone measurement tool names, or the mask edit modes.
/** How far from the end of the chat still counts as reading the newest messages. */
const CHAT_BOTTOM_SLACK_PX = 48;

const EDIT_TOOL_NAMES: Record<string, string> = {
	crosshair: "Crosshair",
	pan: "Pan",
	brush: "Brush",
	eraser: "Eraser",
	smartfill: "Grow from seeds",
	lasso: "Lasso",
};

function toolLabel(tool: string): string {
	return EDIT_TOOL_NAMES[tool] ?? measurementToolName(tool);
}

function planeLabel(plane: string): string {
	return plane.charAt(0).toUpperCase() + plane.slice(1);
}

function formatCountdown(expiresAt: string, now: number): string {
	const remaining = Math.max(0, new Date(expiresAt).getTime() - now);
	const hours = Math.floor(remaining / 3_600_000);
	const minutes = Math.floor((remaining % 3_600_000) / 60_000);
	const seconds = Math.floor((remaining % 60_000) / 1_000);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function LiveRoomHeader({ room, dockOpen, onToggleDock }: {
	room: LiveRoomController;
	dockOpen: boolean;
	onToggleDock: () => void;
}) {
	const [now, setNow] = useState(Date.now());
	const [copied, setCopied] = useState(false);
	const copiedTimerRef = useRef<number | null>(null);
	useEffect(() => () => {
		if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
	}, []);
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);
	const statusLabel = {
		connecting: "Connecting",
		connected: "Live",
		reconnecting: "Reconnecting",
		disconnected: "Offline",
		expired: "Expired",
		error: "Error",
	}[room.connectionState];
	return (
		<header className="lr-header lr-header--room">
			<div className="lr-header__identity">
				<span className="lr-live-dot" data-state={room.connectionState} role="img" aria-label={statusLabel} />
				<div><strong>{room.metadata.mode === "quiz" ? "Live quiz" : "Live room"}</strong><span>Case {room.metadata.case_id} · {room.metadata.resolution === "full" ? "Full resolution" : "Fast preview"}</span><span className="lr-header__access-short">{room.metadata.mode === "quiz" ? "Private answers" : "Link holders can edit"}</span></div>
			</div>
			<div className="lr-header__warning">{room.metadata.mode === "quiz" ? "Private answers · reveal together" : "Anyone with the link can edit"}</div>
			<div className="lr-header__actions">
				<div className="lr-header__state">
					<span className="lr-status" data-state={room.connectionState}>{statusLabel}</span>
					<span className="lr-countdown" title="Room deletes automatically at expiration">Expires in {formatCountdown(room.metadata.expires_at, now + (room.clockOffsetMs ?? 0))}</span>
				</div>
				<a
					className="lr-header-button"
					href={appRootRelativeUrl(`/case/${room.metadata.case_id}`)}
					title="Leave the room and open this case in the normal viewer"
				>
					<IconArrowLeft size={18} /> Leave
				</a>
				<button
					type="button"
					className="lr-header-button"
					onClick={onToggleDock}
					id="lr-dock-toggle"
					aria-expanded={dockOpen}
					aria-controls={dockOpen ? "lr-dock" : undefined}
					title={`${dockOpen ? "Hide" : "Show"} ${room.metadata.mode === "quiz" ? "quiz" : "room"} panel`}
					aria-label={`${room.metadata.mode === "quiz" ? "Quiz" : "People"} ${room.participants.length}/8 connected`}
				>
					<IconUsersGroup size={18} aria-hidden="true" /> {room.metadata.mode === "quiz" ? "Quiz" : "People"} {room.participants.length}/8
				</button>
				<button type="button" className="lr-header-button lr-header-button--primary" onClick={() => {
					void room.copyShareLink().then((ok) => {
						// false means the clipboard write failed and only the prompt was shown.
						if (ok === false) return;
						setCopied(true);
						if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
						copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1800);
					});
				}}>
					{copied ? <IconCheck size={18} aria-hidden="true" /> : <IconShare size={18} aria-hidden="true" />} {copied ? "Copied" : "Share"}
				</button>
				{/* Always mounted so the copy is announced; the button's own name change is not reliably read. */}
				<span className="sr-only" role="status">{copied ? "Link copied" : ""}</span>
			</div>
			{/* Always mounted, and only filled while the dock is closed: the dock
			    shows the same notice or error in its own banner when it is open.
			    A dropped connection is left to the status word, which already says it;
			    an error in any other state (another tab took the room, a fatal server
			    message) is the only place the closed dock tells the user why. */}
			<div className="lr-header__notice" role="status">{dockOpen ? "" : room.undoNotice || (room.connectionState === "connecting" || room.connectionState === "reconnecting" ? "" : room.error) || ""}</div>
		</header>
	);
}

/** The review dock's selected tab and unsent drafts. The dock unmounts when it
 *  is closed, so the page holds these to keep them for when it reopens. */
export function useDockDrafts() {
	const [tab, setTab] = useState<DockTab>("people");
	const [chat, setChat] = useState("");
	const [note, setNote] = useState("");
	return { tab, setTab, chat, setChat, note, setNote };
}

export function LiveRoomDock(props: {
	room: LiveRoomController;
	crosshair: [number, number, number] | null;
	activePlane: CinePane;
	onClose: () => void;
	drafts?: ReturnType<typeof useDockDrafts>;
}) {
	// The dock unmounts with its focused Close button, which would drop focus to
	// the page body; hand it to the header toggle that reopens the dock first.
	const onClose = () => {
		document.getElementById("lr-dock-toggle")?.focus();
		props.onClose();
	};
	if (props.room.metadata.mode === "quiz") {
		return <LiveQuizDock room={props.room} onClose={onClose} drafts={props.drafts} />;
	}
	return <ReviewLiveRoomDock {...props} onClose={onClose} />;
}

function ReviewLiveRoomDock({ room, crosshair, activePlane, onClose, drafts }: {
	room: LiveRoomController;
	crosshair: [number, number, number] | null;
	activePlane: CinePane;
	onClose: () => void;
	drafts?: ReturnType<typeof useDockDrafts>;
}) {
	const ownDrafts = useDockDrafts();
	const { tab, setTab, chat, setChat, note, setNote } = drafts ?? ownDrafts;
	const roomExport = useRoomExport(room.downloadExport);
	const bodyRef = useRef<HTMLDivElement>(null);
	const chatSend = useSendOnce();
	const noteSend = useSendOnce();
	const notes = useMemo(() => Object.values(room.state.notes).sort((a, b) => (a._seq ?? 0) - (b._seq ?? 0)), [room.state.notes]);
	const editingDisabled = room.connectionState !== "connected";
	// The Delete button unmounts with its note, which would drop focus to the page
	// body and let the viewer's shortcuts fire. The note field (or the panel, when
	// it is disabled) takes focus once the delete has been accepted.
	const deleteNote = async (id: string) => {
		if (!(await room.deleteNote(id))) return;
		const field = document.getElementById("lr-note");
		const target = field instanceof HTMLTextAreaElement && !field.disabled ? field : bodyRef.current;
		target?.focus();
	};
	const reconnecting = room.connectionState === "reconnecting";
	// Saying nothing is right while the first connection is still opening: the fields
	// are disabled and the wording would only alarm. A stopped connection needs a next
	// step, and an expired room has its own overlay.
	const stopped = editingDisabled && !["connecting", "reconnecting", "expired"].includes(room.connectionState);
	// Server reasons arrive with or without a full stop, so add one before the next step.
	const stoppedReason = room.error || "Connection lost.";
	const banner = room.undoNotice
		|| (reconnecting ? "Reconnecting. Edits are paused."
			: stopped ? `${/[.!?…]$/.test(stoppedReason) ? stoppedReason : `${stoppedReason}.`}${rejoinHint(stoppedReason)}`
				: room.error);
	// Newest message and the composer under it, on open and as messages arrive.
	// The room keeps only the last 500 messages, so the length stops changing once
	// it is full; the newest id is what moves then. A reader who has scrolled up
	// keeps their place: new messages follow only from near the bottom, or when
	// they are the reader's own.
	const lastChat = room.state.chat[room.state.chat.length - 1];
	const lastChatId = lastChat?.id;
	const lastChatOwn = lastChat?.author === room.name;
	const chatAtBottom = useRef(true);
	useEffect(() => {
		const body = bodyRef.current;
		if (tab !== "chat" || !body) return;
		body.scrollTop = body.scrollHeight;
		chatAtBottom.current = true;
	}, [tab]);
	useEffect(() => {
		const body = bodyRef.current;
		if (tab === "chat" && body && (chatAtBottom.current || lastChatOwn)) body.scrollTop = body.scrollHeight;
		// Tab changes are handled by the [tab] effect, and lastChatOwn comes from the same message as lastChatId.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [room.state.chat.length, lastChatId]);
	// The panel body is shared by the tabs, so People and Notes would open at the
	// chat's scroll depth, with the Pin note form above the fold.
	useEffect(() => {
		if (tab !== "chat" && bodyRef.current) bodyRef.current.scrollTop = 0;
	}, [tab]);
	return (
		<aside id="lr-dock" className="lr-dock" aria-label="Live room collaboration">
			<div className="lr-dock__head">
				<div><span className="lr-eyebrow">Collaborate</span><strong>{room.participants.length} connected</strong></div>
				<button type="button" className="lr-dock__close" onClick={onClose} aria-label="Close collaboration panel"><IconX size={18} /></button>
			</div>
			{/* Tabs in the ARIA pattern: only the selected tab is in the Tab
			    order, arrow keys (and Home/End) move between them, and each
			    controls the one panel below. */}
			<div className="lr-tabs" role="tablist" aria-label="Room sections" onKeyDown={(event) => {
				const index = DOCK_TABS.findIndex((item) => item.id === tab);
				const next = event.key === "ArrowRight" ? (index + 1) % DOCK_TABS.length
					: event.key === "ArrowLeft" ? (index - 1 + DOCK_TABS.length) % DOCK_TABS.length
						: event.key === "Home" ? 0
							: event.key === "End" ? DOCK_TABS.length - 1
								: -1;
				if (next < 0) return;
				event.preventDefault();
				// The viewer's window-level shortcuts also take Home and End (first and
				// last slice); stop the event here so only the tab moves.
				event.stopPropagation();
				setTab(DOCK_TABS[next].id);
				document.getElementById(`lr-tab-${DOCK_TABS[next].id}`)?.focus();
			}}>
				{DOCK_TABS.map(({ id, label, Icon }) => (
					<button
						key={id}
						type="button"
						role="tab"
						id={`lr-tab-${id}`}
						aria-selected={tab === id}
						aria-controls="lr-tabpanel"
						tabIndex={tab === id ? 0 : -1}
						onClick={() => setTab(id)}
					>
						<Icon size={16} aria-hidden="true" /> {label}
					</button>
				))}
			</div>
			{banner && (
				<div className={`lr-banner ${editingDisabled ? "lr-banner--warning" : ""}`} role="status">
					{banner}
				</div>
			)}
			<div ref={bodyRef} className="lr-dock__body" role="tabpanel" tabIndex={-1} id="lr-tabpanel" aria-labelledby={`lr-tab-${tab}`} onScroll={(event) => {
				const body = event.currentTarget;
				chatAtBottom.current = body.scrollHeight - body.scrollTop - body.clientHeight < CHAT_BOTTOM_SLACK_PX;
			}}>
				{tab === "people" && (
					<div className="lr-people">
						{room.participants.length === 0 && <div className="lr-empty">No one is connected yet.</div>}
						{room.participants.map((participant) => {
							const self = participant.participant_id === room.participantId;
							const following = room.followingId === participant.participant_id;
							return (
								<div className="lr-person" key={participant.participant_id}>
									<span className="lr-avatar" style={{ background: participant.color }}>{nameInitial(participant.name)}</span>
									<div><strong>{participant.name}{self ? " (you)" : ""}</strong><span>{participant.plane ? planeLabel(participant.plane) : "Reviewing scan"}{participant.active_tool ? ` · ${toolLabel(participant.active_tool)}` : ""}</span></div>
									{/* A toggle: the name stays "Follow <name>" and
									    aria-pressed says whether it is on. */}
									{!self && (
										<button
											type="button"
											className={following ? "is-following" : ""}
											aria-pressed={following}
											aria-label={`Follow ${participant.name}`}
											onClick={() => following ? room.stopFollowing() : room.follow(participant.participant_id)}
										>
											{following && <IconCheck size={15} aria-hidden="true" />}Follow
										</button>
									)}
								</div>
							);
						})}
						{room.participants.length === 1 && <div className="lr-empty">No one else has joined yet.</div>}
					</div>
				)}
				{tab === "notes" && (
					<div className="lr-thread">
						<form className="lr-compose" onSubmit={async (event) => {
							event.preventDefault();
							if (!crosshair || !note.trim()) return;
							const sent = note.trim();
							// The field stays editable while the note is in flight; clear it only if nothing new was typed.
							if (await noteSend.run(() => room.addNote(sent, crosshair, activePlane))) setNote((current) => current.trim() === sent ? "" : current);
							refocusComposer("lr-note");
						}}>
							<label htmlFor="lr-note">Pin note at current crosshair</label>
							<textarea id="lr-note" maxLength={4000} value={note} onChange={(event) => setNote(event.target.value)} onKeyDown={submitOnEnter} placeholder={reconnecting ? "Reconnecting…" : crosshair ? "Finding or review note…" : "Place crosshair to anchor a note"} disabled={!crosshair || editingDisabled} />
							<button disabled={!crosshair || !note.trim() || editingDisabled || noteSend.sending}>Pin note</button>
						</form>
						{notes.length === 0 ? <div className="lr-empty">No pinned notes yet.</div> : notes.map((item) => (
							<article className="lr-message" key={item.id}>
								<div><strong>{item.author}</strong><time>{planeLabel(item.plane)}</time></div>
								<p>{item.text}</p>
								<small>{item.world.map((value) => Math.round(value)).join(", ")} mm</small>
								{item.author === room.name && <button type="button" aria-label={`Delete note: ${item.text.slice(0, 40)}`} onClick={() => void deleteNote(item.id)} disabled={editingDisabled}>Delete</button>}
							</article>
						))}
					</div>
				)}
				{tab === "chat" && (
					<div className="lr-thread lr-thread--chat">
						<div className="lr-chat-list" aria-live="polite">
							{room.state.chat.length === 0 ? <div className="lr-empty">No messages yet.</div> : room.state.chat.map((message) => (
								<article className="lr-message" key={message.id}>
									<div><strong>{message.author}</strong>{message.timestamp && <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>}</div>
									<p>{message.text}</p>
								</article>
							))}
						</div>
						<form className="lr-chat-compose" onSubmit={async (event) => {
							event.preventDefault();
							if (!chat.trim()) return;
							const sent = chat.trim();
							// The field stays editable while the message is in flight; clear it only if nothing new was typed.
							if (await chatSend.run(() => room.sendChat(sent))) setChat((current) => current.trim() === sent ? "" : current);
							refocusComposer("lr-chat");
						}}>
							<label htmlFor="lr-chat">Room message</label>
							<textarea id="lr-chat" maxLength={2000} value={chat} onChange={(event) => setChat(event.target.value)} onKeyDown={submitOnEnter} disabled={editingDisabled} placeholder={reconnecting ? "Reconnecting…" : "Message everyone…"} />
							<button disabled={!chat.trim() || editingDisabled || chatSend.sending}>Send</button>
						</form>
					</div>
				)}
			</div>
			<div className="lr-export">
				<button onClick={() => void roomExport.run("zip")} disabled={roomExport.exporting !== null} aria-busy={roomExport.exporting === "zip"}><IconCloudDownload size={16} /> {roomExport.exporting === "zip" ? "Exporting…" : "Export room ZIP"}</button>
				<button onClick={() => void roomExport.run("pdf")} disabled={roomExport.exporting !== null} aria-busy={roomExport.exporting === "pdf"}><IconFileTypePdf size={16} /> {roomExport.exporting === "pdf" ? "Exporting…" : "PDF"}</button>
				{roomExport.error && <div className="lr-error" role="alert">{roomExport.error}</div>}
				<small><span className="lr-export__access">Anyone with the link can edit. </span>For research use only. Room deletes after 24 hours.</small>
			</div>
		</aside>
	);
}
