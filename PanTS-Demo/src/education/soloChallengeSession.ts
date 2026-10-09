import type { SharedMeasurement } from "../helpers/CornerstoneNifti2";
import type { EducationAttempt, EducationResult } from "./types";

const STORAGE_PREFIX = "bodymaps.education.solo-challenge";
const SESSION_VERSION = 1;

export type SoloChallengeSession = {
	attempt: EducationAttempt;
	findingChoice: string;
	impression: string;
	marker: [number, number, number] | null;
	measurement: SharedMeasurement | null;
	result: EducationResult | null;
	// Server clock minus the device clock, in milliseconds, measured when the
	// attempt started, so the countdown follows the server's deadline.
	clockOffsetMs?: number;
};

type StoredSoloChallengeSession = SoloChallengeSession & {
	version: typeof SESSION_VERSION;
};

function storageKey(challengeId: string) {
	return `${STORAGE_PREFIX}.${challengeId}`;
}

// Blocked site data (cookies off, a sandboxed iframe) makes even reading
// sessionStorage throw, so it is looked up behind a guard, never in a default
// parameter where the throw would escape the callers' try blocks.
function sessionStore(): Storage | null {
	try {
		return sessionStorage;
	} catch {
		return null;
	}
}

function discard(storage: Storage | null, key: string) {
	try {
		storage?.removeItem(key);
	} catch {
		// Treat an unavailable storage backend as already cleared.
	}
}

function finitePoint(value: unknown): value is [number, number, number] {
	return Array.isArray(value) && value.length === 3 && value.every((item) => Number.isFinite(item));
}

function validMeasurement(value: unknown): value is SharedMeasurement {
	if (!value || typeof value !== "object") return false;
	const measurement = value as Partial<SharedMeasurement>;
	return typeof measurement.id === "string"
		&& typeof measurement.tool === "string"
		&& Array.isArray(measurement.points)
		&& measurement.points.every(finitePoint);
}

function validAttempt(value: unknown, challengeId: string): value is EducationAttempt {
	if (!value || typeof value !== "object") return false;
	const attempt = value as Partial<EducationAttempt>;
	return attempt.challenge_id === challengeId
		&& attempt.status === "active"
		&& typeof attempt.attempt_id === "string"
		&& typeof attempt.attempt_key === "string"
		&& typeof attempt.started_at === "string"
		&& typeof attempt.deadline_at === "string"
		&& typeof attempt.delete_at === "string";
}

function validResult(value: unknown, challengeId: string, attemptId: string): value is EducationResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<EducationResult>;
	return result.challenge_id === challengeId
		&& result.attempt_id === attemptId
		&& (result.status === "graded" || result.status === "provisional");
}

export function readSoloChallengeSession(challengeId: string, storage: Storage | null = sessionStore()): SoloChallengeSession | null {
	if (!storage) return null;
	const key = storageKey(challengeId);
	try {
		const parsed = JSON.parse(storage.getItem(key) || "null") as Partial<StoredSoloChallengeSession> | null;
		if (!parsed || parsed.version !== SESSION_VERSION || !validAttempt(parsed.attempt, challengeId)) {
			discard(storage, key);
			return null;
		}
		if (typeof parsed.findingChoice !== "string" || typeof parsed.impression !== "string") {
			discard(storage, key);
			return null;
		}
		if (parsed.marker !== null && !finitePoint(parsed.marker)) {
			discard(storage, key);
			return null;
		}
		if (parsed.measurement !== null && !validMeasurement(parsed.measurement)) {
			discard(storage, key);
			return null;
		}
		if (parsed.result !== null && !validResult(parsed.result, challengeId, parsed.attempt.attempt_id)) {
			discard(storage, key);
			return null;
		}
		return {
			attempt: parsed.attempt,
			findingChoice: parsed.findingChoice,
			impression: parsed.impression,
			marker: parsed.marker,
			measurement: parsed.measurement,
			result: parsed.result,
			clockOffsetMs: Number.isFinite(parsed.clockOffsetMs) ? parsed.clockOffsetMs : undefined,
		};
	} catch {
		discard(storage, key);
		return null;
	}
}

export function writeSoloChallengeSession(challengeId: string, session: SoloChallengeSession, storage: Storage | null = sessionStore()) {
	const value: StoredSoloChallengeSession = { version: SESSION_VERSION, ...session };
	try {
		storage?.setItem(storageKey(challengeId), JSON.stringify(value));
	} catch {
		// Storage can be unavailable in hardened/private contexts; the live attempt still works.
	}
}

export function clearSoloChallengeSession(challengeId: string, storage: Storage | null = sessionStore()) {
	discard(storage, storageKey(challengeId));
}
