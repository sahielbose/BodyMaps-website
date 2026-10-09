import { API_BASE } from "../helpers/constants";
import { ungzip } from "pako";
import type { MaskRange } from "../helpers/CornerstoneNifti2";
import type {
	LiveRoomChatMessage,
	LiveRoomDurableState,
	LiveRoomEvent,
	LiveRoomMeasurement,
	LiveRoomMetadata,
	LiveRoomNote,
	LiveQuizState,
} from "./types";

export const LIVE_ROOM_PROTOCOL = 1;
export const LIVE_ROOM_FRAME_BYTES = 512 * 1024;
export const MAX_LIVE_ROOM_CHAT_MESSAGES = 500;
export const MAX_LIVE_ROOM_REPLAY_EVENTS = 500;
export const MAX_LIVE_ROOM_BUFFERED_EVENTS = 256;
export const LIVE_ROOM_SEQUENCE_GAP_MS = 1_500;
export const LIVE_ROOM_SEQUENCE_GAP_CLOSE_CODE = 4012;

export type LiveRoomParticipantCredential = {
	participantId: string;
	resumeCredential: string;
};

export function liveRoomParticipantStorageKey(roomId: string): string {
	return `bodymaps.live-room.${roomId}.participant-credential`;
}

// sessionStorage can throw on any access (site data blocked, a sandboxed
// iframe), and a throw during render blanks the whole viewer. The live-room
// screens go through these instead: a value that can't be read counts as
// absent, and one that can't be written is simply not remembered.
export function readLiveRoomSession(key: string): string | null {
	try {
		return sessionStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeLiveRoomSession(key: string, value: string): void {
	try {
		sessionStorage.setItem(key, value);
	} catch {
		// Storage is off; this tab just won't remember it.
	}
}

export function getLiveRoomParticipantCredential(roomId: string): LiveRoomParticipantCredential | null {
	try {
		const value = JSON.parse(sessionStorage.getItem(liveRoomParticipantStorageKey(roomId)) || "null") as Partial<LiveRoomParticipantCredential> | null;
		if (
			value
			&& typeof value.participantId === "string" && value.participantId.length > 0 && value.participantId.length <= 256
			&& typeof value.resumeCredential === "string" && value.resumeCredential.length > 0 && value.resumeCredential.length <= 256
		) {
			return { participantId: value.participantId, resumeCredential: value.resumeCredential };
		}
	} catch {
		// A malformed tab-local identity is treated as absent.
	}
	return null;
}

function normalizedBasename(basename: string): string {
	const clean = basename.trim().replace(/^\/+|\/+$/g, "");
	return clean ? `/${clean}` : "";
}

export function liveRoomRoute(roomId: string, roomKey: string): string {
	return `/live/${encodeURIComponent(roomId)}#${encodeURIComponent(roomKey)}`;
}

export function appRootRelativeUrl(path: string, basename = import.meta.env.VITE_BASENAME || ""): string {
	return `${normalizedBasename(basename)}/${path.replace(/^\/+/, "")}`;
}

export function liveRoomShareUrl(
	roomId: string,
	roomKey: string,
	origin = window.location.origin,
	basename = import.meta.env.VITE_BASENAME || ""
): string {
	return `${origin}${appRootRelativeUrl(liveRoomRoute(roomId, roomKey), basename)}`;
}

export function roomKeyFromFragment(fragment = window.location.hash): string {
	const encoded = fragment.replace(/^#/, "").trim();
	try {
		return decodeURIComponent(encoded);
	} catch {
		return "";
	}
}

export function liveRoomWebSocketUrl(roomId: string): string {
	const url = new URL(`/ws/live-rooms/${encodeURIComponent(roomId)}`, window.location.origin);
	url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}

export function liveRoomApiUrl(roomId: string, suffix = ""): string {
	return `${API_BASE}/api/live-rooms/${encodeURIComponent(roomId)}${suffix}`;
}

function finiteVector(value: unknown, length: number): number[] | null {
	if (!Array.isArray(value) || value.length !== length) return null;
	return value.every((item) => typeof item === "number" && Number.isFinite(item)) ? value : null;
}

function shortString(value: unknown): string | null {
	return typeof value === "string" ? value.slice(0, 64) : null;
}

export function sanitizeLiveRoomPresence(payload: Record<string, unknown>): Record<string, unknown> {
	const clean: Record<string, unknown> = {};
	if (payload.cursor === null) clean.cursor = null;
	else if (payload.cursor && typeof payload.cursor === "object") {
		const cursor = payload.cursor as Record<string, unknown>;
		const pane = shortString(cursor.pane);
		const x = cursor.x;
		const y = cursor.y;
		if (pane && typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
			clean.cursor = { pane, x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
		}
	}
	if (payload.crosshair === null) clean.crosshair = null;
	else {
		const crosshair = finiteVector(payload.crosshair, 3);
		if (crosshair) clean.crosshair = crosshair;
	}
	for (const key of ["active_tool", "target_organ", "plane"] as const) {
		if (payload[key] === null) clean[key] = null;
		else {
			const value = shortString(payload[key]);
			if (value !== null) clean[key] = value;
		}
	}
	if (payload.following === null) clean.following = null;
	else {
		const following = shortString(payload.following);
		if (following) clean.following = following;
	}
	return clean;
}

export function sanitizeLiveRoomView(payload: Record<string, unknown>): Record<string, unknown> {
	const rawView = payload.view;
	if (!rawView || typeof rawView !== "object") return {};
	const source = rawView as Record<string, unknown>;
	const view: Record<string, unknown> = {};
	if (source.crosshair === null) view.crosshair = null;
	else {
		const crosshair = finiteVector(source.crosshair, 3);
		if (crosshair) view.crosshair = crosshair;
	}
	if (source.cameras && typeof source.cameras === "object") {
		const cameras: Record<string, unknown> = {};
		for (const pane of ["axial", "sagittal", "coronal"] as const) {
			const rawCamera = (source.cameras as Record<string, unknown>)[pane];
			if (!rawCamera || typeof rawCamera !== "object") continue;
			const cameraSource = rawCamera as Record<string, unknown>;
			const camera: Record<string, unknown> = {};
			for (const key of ["focalPoint", "position", "viewUp", "viewPlaneNormal"] as const) {
				const vector = finiteVector(cameraSource[key], 3);
				if (vector) camera[key] = vector;
			}
			if (typeof cameraSource.parallelScale === "number" && Number.isFinite(cameraSource.parallelScale)) camera.parallelScale = cameraSource.parallelScale;
			if (typeof cameraSource.flipHorizontal === "boolean") camera.flipHorizontal = cameraSource.flipHorizontal;
			if (typeof cameraSource.flipVertical === "boolean") camera.flipVertical = cameraSource.flipVertical;
			if (Object.keys(camera).length) cameras[pane] = camera;
		}
		if (Object.keys(cameras).length) view.cameras = cameras;
	}
	for (const key of ["windowWidth", "windowCenter", "opacity"] as const) {
		if (typeof source[key] === "number" && Number.isFinite(source[key])) view[key] = source[key];
	}
	if (Array.isArray(source.visibleOrgans)) view.visibleOrgans = source.visibleOrgans.slice(0, 256).map(Boolean);
	return Object.keys(view).length ? { view } : {};
}

export function emptyDurableState(): LiveRoomDurableState {
	return { measurements: {}, notes: {}, chat: [], undone_event_ids: [] };
}

export function applyCommittedEvent(
	state: LiveRoomDurableState,
	event: LiveRoomEvent
): LiveRoomDurableState {
	const next: LiveRoomDurableState = {
		...state,
		measurements: { ...state.measurements },
		notes: { ...state.notes },
		chat: [...state.chat],
	};
	const payload = event.payload as {
		measurement?: LiveRoomMeasurement;
		note?: LiveRoomNote;
		message?: LiveRoomChatMessage;
		id?: string;
	};
	if (event.type === "measurement.upsert" && payload.measurement?.id) {
		next.measurements[payload.measurement.id] = payload.measurement;
	} else if (event.type === "measurement.delete" && payload.id) {
		delete next.measurements[payload.id];
	} else if (event.type === "note.upsert" && payload.note?.id) {
		next.notes[payload.note.id] = payload.note;
	} else if (event.type === "note.delete" && payload.id) {
		delete next.notes[payload.id];
	} else if (event.type === "chat.add" && payload.message?.id) {
		const message = payload.message;
		if (!next.chat.some((item) => item.id === message.id)) {
			next.chat.push(message);
			if (next.chat.length > MAX_LIVE_ROOM_CHAT_MESSAGES) {
				next.chat = next.chat.slice(-MAX_LIVE_ROOM_CHAT_MESSAGES);
			}
		}
	}
	return next;
}

/** Split at range boundaries, leaving room for envelope JSON below 512 KiB. */
export function chunkMaskRanges(ranges: MaskRange[], targetBytes = 440 * 1024): MaskRange[][] {
	const chunks: MaskRange[][] = [];
	let current: MaskRange[] = [];
	let bytes = 2;
	for (const range of ranges) {
		const rangeBytes = JSON.stringify(range).length + 1;
		if (current.length && bytes + rangeBytes > targetBytes) {
			chunks.push(current);
			current = [];
			bytes = 2;
		}
		current.push(range);
		bytes += rangeBytes;
	}
	if (current.length) chunks.push(current);
	return chunks;
}

/** A room request the server answered with an error, keeping its HTTP status
 *  so the page can tell a bad link (401, 404) from a server that's down. */
export class LiveRoomRequestError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

export async function bootstrapLiveRoom(roomId: string, roomKey: string): Promise<{
	metadata: LiveRoomMetadata;
	state: LiveRoomDurableState;
	maskUrl: string;
	snapshotSequence: number;
	quiz: LiveQuizState | null;
}> {
	const headers = { "X-Room-Key": roomKey };
	const snapshotResponse = await fetch(liveRoomApiUrl(roomId, "/snapshot"), { headers });
	const snapshot = await snapshotResponse.json().catch(() => ({}));
	if (!snapshotResponse.ok) {
		throw new LiveRoomRequestError(snapshot.error || `Room snapshot failed (${snapshotResponse.status})`, snapshotResponse.status);
	}
	const snapshotSequence = Number(snapshot.latest_seq);
	if (!Number.isSafeInteger(snapshotSequence) || snapshotSequence < 0) {
		throw new Error("Room snapshot has an invalid sequence");
	}

	// State is authoritative through snapshotSequence. The mask can lag that sequence
	// when intervening durable events do not edit voxels, so it cannot be the replay
	// baseline. Mask edits committed after the state snapshot arrive over WebSocket.
	const maskResponse = await fetch(`${liveRoomApiUrl(roomId, "/snapshot")}?format=mask`, { headers });
	if (!maskResponse.ok) {
		const body = await maskResponse.json().catch(() => ({}));
		throw new LiveRoomRequestError(body.error || `Room mask failed (${maskResponse.status})`, maskResponse.status);
	}
	// Cornerstone decides gzip handling from URL suffix. Blob URLs don't end in
	// `.gz`, so expose decompressed NIfTI bytes instead of compressed bytes under a
	// suffix-less blob URL.
	const compressedMask = new Uint8Array(await maskResponse.arrayBuffer());
	const maskUrl = URL.createObjectURL(new Blob([new Uint8Array(ungzip(compressedMask))], {
		type: "application/octet-stream",
	}));

	const metadata = { ...(snapshot.room as LiveRoomMetadata) };
	metadata.mode ??= "review";
	return {
		metadata,
		state: (snapshot.state ?? emptyDurableState()) as LiveRoomDurableState,
		maskUrl,
		snapshotSequence,
		quiz: (snapshot.quiz ?? null) as LiveQuizState | null,
	};
}

export async function loadLiveQuizRevealMask(roomId: string, roomKey: string): Promise<string> {
	const response = await fetch(liveRoomApiUrl(roomId, "/quiz/reveal-segmentation.nii.gz"), {
		headers: { "X-Room-Key": roomKey },
	});
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw new Error(body.error || `Quiz reveal failed (${response.status})`);
	}
	const compressed = new Uint8Array(await response.arrayBuffer());
	return URL.createObjectURL(new Blob([new Uint8Array(ungzip(compressed))], {
		type: "application/octet-stream",
	}));
}
