import { beforeEach, describe, expect, it } from "vitest";
import {
	addRecentUpload,
	adoptOwnedRuns,
	formatRelativeTime,
	friendlyScanName,
	loadDismissedUploads,
	loadRecentUploads,
	markRecentUploadViewed,
	MAX_RECENT_UPLOADS,
	mergeServerRuns,
	RECENT_WINDOW_MS,
	recentStatusColor,
	removeRecentUpload,
	runsOf,
	splitByAge,
	groupUploads,
	updateRecentUploadStatus,
	type RecentUpload,
} from "./recentUploads";

const makeEntry = (overrides: Partial<RecentUpload> = {}): RecentUpload => ({
	sessionId: "s1",
	label: "ct.nii.gz",
	model: "SuPreM",
	status: "Processing",
	timestamp: Date.now(),
	...overrides,
});

beforeEach(() => {
	localStorage.clear();
});

describe("loadRecentUploads", () => {
	it("returns an empty array when nothing is stored", () => {
		expect(loadRecentUploads()).toEqual([]);
	});

	it("returns an empty array when storage holds malformed JSON", () => {
		localStorage.setItem("recentUploads", "{not json");
		expect(loadRecentUploads()).toEqual([]);
	});
});

describe("addRecentUpload", () => {
	it("prepends the newest entry", () => {
		addRecentUpload(makeEntry({ sessionId: "a" }));
		const list = addRecentUpload(makeEntry({ sessionId: "b" }));
		expect(list.map((u) => u.sessionId)).toEqual(["b", "a"]);
	});

	it("de-duplicates by sessionId (re-adding moves it to the front)", () => {
		addRecentUpload(makeEntry({ sessionId: "a" }));
		addRecentUpload(makeEntry({ sessionId: "b" }));
		const list = addRecentUpload(makeEntry({ sessionId: "a", label: "updated" }));
		expect(list.map((u) => u.sessionId)).toEqual(["a", "b"]);
		expect(list.filter((u) => u.sessionId === "a")).toHaveLength(1);
		expect(list[0].label).toBe("updated");
	});

	it(`caps the list at ${MAX_RECENT_UPLOADS} entries`, () => {
		for (let i = 0; i < MAX_RECENT_UPLOADS + 4; i++) {
			addRecentUpload(makeEntry({ sessionId: `s${i}` }));
		}
		expect(loadRecentUploads()).toHaveLength(MAX_RECENT_UPLOADS);
	});
});

describe("updateRecentUploadStatus", () => {
	it("updates only the matching session's status", () => {
		addRecentUpload(makeEntry({ sessionId: "a" }));
		addRecentUpload(makeEntry({ sessionId: "b" }));
		const list = updateRecentUploadStatus("a", "Completed");
		expect(list.find((u) => u.sessionId === "a")?.status).toBe("Completed");
		expect(list.find((u) => u.sessionId === "b")?.status).toBe("Processing");
	});
});

describe("formatRelativeTime", () => {
	it("formats recent, minutes, hours, and days", () => {
		const now = Date.now();
		expect(formatRelativeTime(now)).toBe("Just now");
		expect(formatRelativeTime(now - 5 * 60_000)).toBe("5 mins ago");
		expect(formatRelativeTime(now - 1 * 60_000)).toBe("1 min ago");
		expect(formatRelativeTime(now - 3 * 60 * 60_000)).toBe("3 hours ago");
		expect(formatRelativeTime(now - 25 * 60 * 60_000)).toBe("Yesterday");
		expect(formatRelativeTime(now - 4 * 24 * 60 * 60_000)).toBe("4 days ago");
	});
});

describe("recentStatusColor", () => {
	it("maps each status to its color", () => {
		expect(recentStatusColor("Failed")).toBe("#b91c1c");
		expect(recentStatusColor("Cancelled")).toBe("#b45309");
		expect(recentStatusColor("Processing")).toBe("#6a6a6a");
		expect(recentStatusColor("Completed")).toBe("#6a6a6a");
	});
});

describe("splitByAge", () => {
	const now = Date.UTC(2026, 7, 7, 12, 0, 0);
	const agoMs = (ms: number) => now - ms;

	it("keeps the last day on the upload page and sends the rest to history", () => {
		const groups = groupUploads([
			makeEntry({ sessionId: "today", timestamp: agoMs(2 * 60 * 60 * 1000) }),
			makeEntry({ sessionId: "old", timestamp: agoMs(3 * RECENT_WINDOW_MS) }),
		]);

		const { recent, older } = splitByAge(groups, now);
		expect(recent.map((g) => g.timestamp)).toEqual([agoMs(2 * 60 * 60 * 1000)]);
		expect(older.map((g) => g.timestamp)).toEqual([agoMs(3 * RECENT_WINDOW_MS)]);
	});

	it("treats an entry exactly on the boundary as recent", () => {
		const groups = groupUploads([
			makeEntry({ sessionId: "edge", timestamp: agoMs(RECENT_WINDOW_MS) }),
		]);
		expect(splitByAge(groups, now).recent).toHaveLength(1);
	});

	it("judges a batch by its newest scan so it is never torn in half", () => {
		const groups = groupUploads([
			makeEntry({
				sessionId: "a", batchId: "b1", batchLabel: "2 scans",
				timestamp: agoMs(3 * RECENT_WINDOW_MS),
			}),
			makeEntry({
				sessionId: "b", batchId: "b1", batchLabel: "2 scans",
				timestamp: agoMs(60 * 1000),
			}),
		]);

		const { recent, older } = splitByAge(groups, now);
		expect(older).toHaveLength(0);
		expect(recent).toHaveLength(1);
		expect(recent[0].kind === "batch" && recent[0].uploads).toHaveLength(2);
	});

	it("returns both sides empty for an empty list", () => {
		expect(splitByAge([], now)).toEqual({ recent: [], older: [] });
	});

	it("sends a recently-finished but already-viewed scan to history early", () => {
		const groups = groupUploads([
			makeEntry({ sessionId: "seen", timestamp: agoMs(2 * 60 * 60 * 1000), viewed: true }),
		]);
		const { recent, older } = splitByAge(groups, now);
		expect(recent).toHaveLength(0);
		expect(older).toHaveLength(1);
	});

	it("keeps a recent, unviewed scan on the upload page", () => {
		const groups = groupUploads([
			makeEntry({ sessionId: "unseen", timestamp: agoMs(2 * 60 * 60 * 1000) }),
		]);
		const { recent, older } = splitByAge(groups, now);
		expect(recent).toHaveLength(1);
		expect(older).toHaveLength(0);
	});

	it("keeps a batch on the upload page until every scan in it has been viewed", () => {
		const groups = groupUploads([
			makeEntry({ sessionId: "a", batchId: "b1", batchLabel: "2 scans", timestamp: agoMs(60 * 1000), viewed: true }),
			makeEntry({ sessionId: "b", batchId: "b1", batchLabel: "2 scans", timestamp: agoMs(60 * 1000) }),
		]);
		const { recent, older } = splitByAge(groups, now);
		expect(recent).toHaveLength(1);
		expect(older).toHaveLength(0);
	});
});

describe("markRecentUploadViewed", () => {
	it("sets viewed on the matching entry only", () => {
		localStorage.setItem(
			"recentUploads",
			JSON.stringify([makeEntry({ sessionId: "a" }), makeEntry({ sessionId: "b" })]),
		);
		const result = markRecentUploadViewed("a");
		expect(result.find((u) => u.sessionId === "a")?.viewed).toBe(true);
		expect(result.find((u) => u.sessionId === "b")?.viewed).toBeUndefined();
	});

	it("is a no-op for an unknown session id", () => {
		localStorage.setItem("recentUploads", JSON.stringify([makeEntry({ sessionId: "a" })]));
		const result = markRecentUploadViewed("nonexistent");
		expect(result.find((u) => u.sessionId === "a")?.viewed).toBeUndefined();
	});
});

describe("mergeServerRuns", () => {
	const at = "2026-09-29T15:30:00+00:00";
	const run = (overrides: Record<string, unknown> = {}) => ({
		session_id: "srv-1",
		model: "ePAI",
		status: "completed",
		created_at: at,
		...overrides,
	});

	it("adds a run this browser lacks, named like a fresh run and owned by the account", () => {
		const { list, added } = mergeServerRuns([], [run()], "u1", []);

		expect(added).toEqual(list);
		expect(list).toEqual([
			{
				sessionId: "srv-1",
				label: friendlyScanName("ePAI", Date.parse(at)),
				model: "ePAI",
				status: "Completed",
				timestamp: Date.parse(at),
				isReconstruction: false,
				ownerId: "u1",
			},
		]);
	});

	it("maps the server's statuses onto the list's", () => {
		const statuses = ["queued", "running", "completed", "failed", "cancelled"];
		const { list } = mergeServerRuns([], statuses.map((status) => run({ session_id: status, status })), "u1", []);

		expect(list.map((u) => u.status)).toEqual(["Processing", "Processing", "Completed", "Failed", "Cancelled"]);
	});

	it("leaves a run the browser already has exactly as it is", () => {
		const mine = makeEntry({ sessionId: "srv-1", label: "My renamed scan", status: "Processing", viewed: true });

		const { list, added } = mergeServerRuns([mine], [run()], "u1", []);

		expect(added).toEqual([]);
		expect(list).toEqual([mine]);
	});

	it("puts the runs it adds after the ones the browser has", () => {
		const mine = makeEntry({ sessionId: "local" });

		const { list, added } = mergeServerRuns([mine], [run({ session_id: "a" }), run({ session_id: "b" })], "u1", []);

		expect(list.map((u) => u.sessionId)).toEqual(["local", "a", "b"]);
		expect(added.map((u) => u.sessionId)).toEqual(["a", "b"]);
	});

	it("skips a run removed in this browser", () => {
		const { list } = mergeServerRuns([], [run()], "u1", ["srv-1"]);

		expect(list).toEqual([]);
	});

	it("skips rows it cannot read", () => {
		const { list } = mergeServerRuns(
			[],
			[
				null,
				"nope",
				run({ session_id: 7 }),
				run({ session_id: "no-status", status: "paused" }),
				run({ session_id: "no-date", created_at: "not a date" }),
				run({ session_id: "ok" }),
			],
			"u1",
			[],
		);

		expect(list.map((u) => u.sessionId)).toEqual(["ok"]);
	});

	it("ignores a reply that is not a list", () => {
		const local = [makeEntry()];

		expect(mergeServerRuns(local, undefined, "u1", []).list).toBe(local);
		expect(mergeServerRuns(local, { runs: [] }, "u1", []).added).toEqual([]);
	});

	it(`never grows the list past ${MAX_RECENT_UPLOADS} entries`, () => {
		const local = Array.from({ length: MAX_RECENT_UPLOADS - 1 }, (_, i) => makeEntry({ sessionId: `l${i}` }));

		const { list, added } = mergeServerRuns(local, [run({ session_id: "a" }), run({ session_id: "b" })], "u1", []);

		expect(list).toHaveLength(MAX_RECENT_UPLOADS);
		expect(added.map((u) => u.sessionId)).toEqual(["a"]);
	});
});

describe("removeRecentUpload", () => {
	it("remembers the removal, so a server run does not come back", () => {
		addRecentUpload(makeEntry({ sessionId: "srv-1" }));

		removeRecentUpload("srv-1");

		expect(loadRecentUploads()).toEqual([]);
		expect(loadDismissedUploads()).toEqual(["srv-1"]);
		const { list } = mergeServerRuns(
			loadRecentUploads(),
			[{ session_id: "srv-1", model: "ePAI", status: "completed", created_at: "2026-09-29T15:30:00+00:00" }],
			"u1",
		);
		expect(list).toEqual([]);
	});
});

describe("runsOf", () => {
	const mine = makeEntry({ sessionId: "mine", ownerId: "u1" });
	const theirs = makeEntry({ sessionId: "theirs", ownerId: "u2" });
	const nobodys = makeEntry({ sessionId: "nobodys" });
	const list = [mine, theirs, nobodys];

	it("gives a signed-in account only its own runs", () => {
		expect(runsOf(list, "u1")).toEqual([mine]);
		expect(runsOf(list, "u2")).toEqual([theirs]);
	});

	it("gives a signed-out visitor only the runs nobody owns", () => {
		expect(runsOf(list, null)).toEqual([nobodys]);
	});

	it("gives nobody anything while sign-in is still being worked out", () => {
		expect(runsOf(list, null, false)).toEqual([]);
		expect(runsOf(list, "u1", false)).toEqual([]);
	});

	it("leaves the list itself alone", () => {
		runsOf(list, "u1");
		expect(list).toEqual([mine, theirs, nobodys]);
	});
});

describe("adoptOwnedRuns", () => {
	const owned = makeEntry({ sessionId: "owned" });
	const unnamed = makeEntry({ sessionId: "unnamed" });
	const theirs = makeEntry({ sessionId: "theirs", ownerId: "u2" });
	const mine = makeEntry({ sessionId: "mine", ownerId: "u1" });

	it("stamps the account on a run with no owner that the server names as its own", () => {
		const { list, adopted } = adoptOwnedRuns([owned, unnamed], ["owned"], "u1");

		expect(list).toEqual([{ ...owned, ownerId: "u1" }, unnamed]);
		expect(adopted).toEqual([{ ...owned, ownerId: "u1" }]);
		expect(runsOf(list, "u1").map((u) => u.sessionId)).toEqual(["owned"]);
	});

	it("leaves a run with no owner that the server does not name to whoever it belongs to", () => {
		const { list, adopted } = adoptOwnedRuns([unnamed], ["other"], "u1");

		expect(list).toEqual([unnamed]);
		expect(adopted).toEqual([]);
		expect(runsOf(list, null)).toEqual([unnamed]);
	});

	it("never takes a run that already has an owner", () => {
		const { list, adopted } = adoptOwnedRuns([theirs, mine], ["theirs", "mine"], "u1");

		expect(list).toEqual([theirs, mine]);
		expect(adopted).toEqual([]);
	});

	it("ignores an answer that is not a list, and entries in it that are not ids", () => {
		expect(adoptOwnedRuns([owned], undefined, "u1")).toEqual({ list: [owned], adopted: [] });
		expect(adoptOwnedRuns([owned], [null, 7, {}], "u1").adopted).toEqual([]);
	});
});
