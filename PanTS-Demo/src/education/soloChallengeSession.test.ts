import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EducationAttempt, EducationResult } from "./types";
import {
	clearSoloChallengeSession,
	readSoloChallengeSession,
	writeSoloChallengeSession,
} from "./soloChallengeSession";

const challengeId = "pancreas-case-35";
const attempt: EducationAttempt = {
	attempt_id: "attempt-1",
	attempt_key: "secret",
	challenge_id: challengeId,
	started_at: "2026-07-31T12:00:00Z",
	deadline_at: "2026-07-31T12:05:00Z",
	delete_at: "2026-08-01T12:00:00Z",
	status: "active",
};

const result = {
	attempt_id: attempt.attempt_id,
	challenge_id: challengeId,
	status: "provisional",
} as EducationResult;

const measurement = {
	id: "measurement-1",
	tool: "Length",
	points: [[1, 2, 3], [4, 5, 6]],
	polyline: [],
	text: "",
	label: "",
	frame_of_reference: "frame-1",
	metadata: {},
};

describe("solo challenge session", () => {
	beforeEach(() => sessionStorage.clear());

	it("restores active progress, measurement, and result from session storage", () => {
		writeSoloChallengeSession(challengeId, {
			attempt,
			findingChoice: "focal_pancreatic_lesion",
			impression: "Focal abnormality in the pancreatic body.",
			marker: [1, 2, 3],
			measurement,
			result,
		});

		expect(readSoloChallengeSession(challengeId)).toEqual({
			attempt,
			findingChoice: "focal_pancreatic_lesion",
			impression: "Focal abnormality in the pancreatic body.",
			marker: [1, 2, 3],
			measurement,
			result,
		});
	});

	it("discards malformed or mismatched sessions", () => {
		sessionStorage.setItem("bodymaps.education.solo-challenge.pancreas-case-35", JSON.stringify({
			version: 1,
			attempt: { ...attempt, challenge_id: "another-challenge" },
			findingChoice: "",
			impression: "",
			marker: null,
			measurement: null,
			result: null,
		}));

		expect(readSoloChallengeSession(challengeId)).toBeNull();
		expect(sessionStorage.length).toBe(0);
	});

	it("clears a completed session when the student exits", () => {
		writeSoloChallengeSession(challengeId, {
			attempt,
			findingChoice: "",
			impression: "",
			marker: null,
			measurement: null,
			result: null,
		});

		clearSoloChallengeSession(challengeId);
		expect(readSoloChallengeSession(challengeId)).toBeNull();
	});

	it("reads nothing, and never throws, when site data is blocked", () => {
		// Cookies off or a sandboxed iframe: even reaching sessionStorage throws.
		const blocked = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
		const storage = vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(blocked);
		try {
			expect(readSoloChallengeSession(challengeId)).toBeNull();
			expect(() => writeSoloChallengeSession(challengeId, {
				attempt, findingChoice: "", impression: "", marker: null, measurement: null, result: null,
			})).not.toThrow();
			expect(() => clearSoloChallengeSession(challengeId)).not.toThrow();
		} finally {
			storage.mockRestore();
		}
	});
});
