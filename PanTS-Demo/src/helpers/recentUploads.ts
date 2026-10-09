// Recent uploads persisted in the user's localStorage (mirrors JHU's recentIds
// pattern). Extracted from UploadPage so the logic can be unit-tested.

export type RecentUploadStatus = "Processing" | "Completed" | "Failed" | "Cancelled";

export type RecentUpload = {
	sessionId: string;
	// User-facing name. Defaults to a friendly "<model> · <date>" (see
	// friendlyScanName) rather than the raw upload filename, and is renameable.
	label: string;
	// The original filename, kept for reference (shown as a tooltip) even after
	// the label is renamed. Optional so older localStorage entries still parse.
	sourceName?: string;
	model: string;
	status: RecentUploadStatus;
	timestamp: number;
	isReconstruction?: boolean;
	// Scans run together (multi-select) share a batchId + batchLabel. A scan run
	// on its own has neither and is treated as an individual entry.
	batchId?: string;
	batchLabel?: string;
	// Has the user opened this scan's result yet? Drives the Upload page's
	// completed-uploads list: an unviewed finished scan stays there regardless
	// of age (that's the whole point - it's still waiting to be looked at),
	// while a viewed one is done being "new" and behaves like any other
	// finished scan for the age-based History split. Optional/undefined for
	// older localStorage entries and for anything still Processing.
	viewed?: boolean;
};

export const RECENT_UPLOADS_KEY = "recentUploads";
// Raised from 8 so a multi-scan batch isn't half-evicted from the list, and
// again from 60 once anything older than a day became the History page's
// content — a history that forgets your 61st scan isn't much of one.
export const MAX_RECENT_UPLOADS = 200;

const TERMINAL: RecentUploadStatus[] = ["Completed", "Failed", "Cancelled"];
export const isTerminalStatus = (s: RecentUploadStatus): boolean => TERMINAL.includes(s);

// A grouped view over the flat upload list: each entry is either a lone scan or
// a batch of scans sharing a batchId. Ordered by most-recent activity.
export type UploadGroup =
	| { kind: "single"; upload: RecentUpload; timestamp: number }
	| {
			kind: "batch";
			batchId: string;
			label: string;
			uploads: RecentUpload[];
			timestamp: number;
	  };

export const groupUploads = (list: RecentUpload[]): UploadGroup[] => {
	const batches = new Map<string, RecentUpload[]>();
	const groups: UploadGroup[] = [];

	for (const u of list) {
		if (u.batchId) {
			if (!batches.has(u.batchId)) batches.set(u.batchId, []);
			batches.get(u.batchId)!.push(u);
		} else {
			groups.push({ kind: "single", upload: u, timestamp: u.timestamp });
		}
	}

	for (const [batchId, uploads] of batches) {
		groups.push({
			kind: "batch",
			batchId,
			label: uploads[0].batchLabel || `${uploads.length} scans`,
			uploads,
			timestamp: Math.max(...uploads.map((u) => u.timestamp)),
		});
	}

	return groups.sort((a, b) => b.timestamp - a.timestamp);
};

// A name for each batch that no other batch on the page shares, for the
// buttons that act on a whole batch: two uploads can both be "3 scans", so the
// label alone doesn't tell a screen-reader or voice-control user which View
// details or Cancel all they are reaching. Adds when it started, and a count
// when even that is the same.
export const batchButtonNames = (groups: UploadGroup[]): Map<string, string> => {
	const names = new Map<string, string>();
	const seen = new Map<string, number>();
	for (const g of groups) {
		if (g.kind !== "batch") continue;
		const started = new Date(Math.min(...g.uploads.map((u) => u.timestamp)));
		const base = `${g.label} started ${started.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
		const n = (seen.get(base) ?? 0) + 1;
		seen.set(base, n);
		names.set(g.batchId, n === 1 ? base : `${base} (${n})`);
	}
	return names;
};

// A batch is "in flight" while any of its scans is still processing; it's
// "done" once every scan has reached a terminal state.
export const isGroupInFlight = (g: UploadGroup): boolean =>
	g.kind === "single"
		? g.upload.status === "Processing"
		: g.uploads.some((u) => u.status === "Processing");

// Longest a finished scan stays on the Upload page if it's never opened - a
// day is generous enough to notice it finished, but the page still shouldn't
// accumulate scans someone genuinely walked away from forever.
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

// A group counts as "viewed" once every scan in it has been opened - a batch
// with one scan still unlooked-at is still something to come back to.
const isGroupViewed = (g: UploadGroup): boolean =>
	g.kind === "single" ? Boolean(g.upload.viewed) : g.uploads.every((u) => Boolean(u.viewed));

/** Split finished groups into what the Upload page shows and what History gets.
 *  A group belongs to History once it's been viewed (its job here is done -
 *  see markRecentUploadViewed) OR once RECENT_WINDOW_MS has passed unviewed,
 *  whichever comes first. A batch is judged by its most recent scan for the
 *  age check, so a batch straddling the age boundary stays whole rather than
 *  being torn in half. */
export const splitByAge = (
	groups: UploadGroup[],
	now: number = Date.now()
): { recent: UploadGroup[]; older: UploadGroup[] } => {
	const cutoff = now - RECENT_WINDOW_MS;
	const belongsToHistory = (g: UploadGroup) => isGroupViewed(g) || g.timestamp < cutoff;
	return {
		recent: groups.filter((g) => !belongsToHistory(g)),
		older: groups.filter(belongsToHistory),
	};
};

export const loadRecentUploads = (): RecentUpload[] => {
	try {
		const arr = JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) || "[]");
		return Array.isArray(arr) ? arr : [];
	} catch {
		return [];
	}
};

export const persistRecentUploads = (list: RecentUpload[]) => {
	try {
		localStorage.setItem(RECENT_UPLOADS_KEY, JSON.stringify(list.slice(0, MAX_RECENT_UPLOADS)));
	} catch (e) {
		console.warn("saveRecentUploads failed", e);
	}
};

export const addRecentUpload = (entry: RecentUpload): RecentUpload[] => {
	const list = [entry, ...loadRecentUploads().filter((u) => u.sessionId !== entry.sessionId)];
	const trimmed = list.slice(0, MAX_RECENT_UPLOADS);
	persistRecentUploads(trimmed);
	return trimmed;
};

export const removeRecentUpload = (sessionId: string): RecentUpload[] => {
	const list = loadRecentUploads().filter((u) => u.sessionId !== sessionId);
	persistRecentUploads(list);
	return list;
};

export const updateRecentUploadStatus = (
	sessionId: string,
	status: RecentUploadStatus
): RecentUpload[] => {
	const list = loadRecentUploads().map((u) => (u.sessionId === sessionId ? { ...u, status } : u));
	persistRecentUploads(list);
	return list;
};

// Marks a scan opened - called wherever the viewer is actually navigated to
// (View button, clicking the card, a batch's per-scan view). Idempotent: once
// true it stays true, so re-viewing a scan doesn't need to re-write storage.
export const markRecentUploadViewed = (sessionId: string): RecentUpload[] => {
	const list = loadRecentUploads().map((u) =>
		u.sessionId === sessionId && !u.viewed ? { ...u, viewed: true } : u
	);
	persistRecentUploads(list);
	return list;
};

// Rename a scan. Empty/whitespace input falls back to a sensible default so a
// scan is never left nameless.
export const renameRecentUpload = (
	sessionId: string,
	label: string
): RecentUpload[] => {
	const list = loadRecentUploads().map((u) => {
		if (u.sessionId !== sessionId) return u;
		const next = label.trim();
		return { ...u, label: next || friendlyScanName(u.model, u.timestamp) };
	});
	persistRecentUploads(list);
	return list;
};

// A meaningful default name for a scan: the model it was run with plus the date,
// e.g. "ePAI · Aug 13, 2026". Far more useful in the history list than the raw
// upload filename (often "ct.nii.gz" or a cryptic export name). The user can
// rename it afterwards.
export const friendlyScanName = (model: string, timestamp: number): string => {
	const who = model && model !== "None" ? model : "Scan";
	let date: string;
	try {
		date = new Date(timestamp).toLocaleDateString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		date = new Date(timestamp).toISOString().slice(0, 10);
	}
	return `${who} · ${date}`;
};

// Scans run the same day with the same model share a default name, so the file
// each one came from is what tells the rows apart. Empty when the scan has no
// recorded file, or when a rename already made the name the file's own.
export const scanSourceName = (u: Pick<RecentUpload, "label" | "sourceName">): string =>
	u.sourceName && u.sourceName !== u.label ? u.sourceName : "";

// What a row's buttons call the scan. The label alone, unless another row in
// `all` carries the same label, in which case the file name is added so a
// screen reader can tell "Download ePAI · Sep 30, 2026" apart from its twin.
export const scanAccessibleName = (
	u: Pick<RecentUpload, "sessionId" | "label" | "sourceName"> & Partial<Pick<RecentUpload, "timestamp">>,
	all: readonly (Pick<RecentUpload, "sessionId" | "label"> & Partial<Pick<RecentUpload, "timestamp" | "sourceName">>)[],
): string => {
	type Row = typeof all[number];
	const twins = (x: Row) => all.some((o) => o.sessionId !== x.sessionId && o.label === x.label);
	if (!twins(u)) return u.label;
	// The file the scan came from, when one is on record.
	const withSource = (x: Row) => {
		const source = scanSourceName({ label: x.label, sourceName: x.sourceName });
		return source ? `${x.label} (${source})` : x.label;
	};
	const base = withSource(u);
	const sameBase = (x: Row) => x.label === u.label && withSource(x) === base;
	if (all.filter(sameBase).every((o) => o.sessionId === u.sessionId)) return base;
	// The same file run again the same day, or no file name on record (a run
	// merged in from the server, or an older entry): the time it was started is
	// what is left to tell it from its twin.
	if (!u.timestamp) return base;
	const timeOf = (ts: number) =>
		new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
	const withTime = (x: Row) => {
		const source = scanSourceName({ label: x.label, sourceName: x.sourceName });
		return source ? `${x.label} (${source}, ${timeOf(x.timestamp!)})` : `${x.label} (${timeOf(x.timestamp!)})`;
	};
	const named = withTime(u);
	// Twins started in the same minute still match: count them in session
	// order, as batchButtonNames does for batches.
	const same = all
		.filter((o) => sameBase(o) && o.timestamp && withTime(o) === named)
		.map((o) => o.sessionId)
		.sort();
	return same.length > 1 ? `${named} (${same.indexOf(u.sessionId) + 1})` : named;
};

export const formatRelativeTime = (ts: number): string => {
	const mins = Math.floor((Date.now() - ts) / 60000);
	if (mins < 1) return "Just now";
	if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
	const days = Math.floor(hours / 24);
	return days === 1 ? "Yesterday" : `${days} days ago`;
};

// Status words are small text on the pale #f5f5f5 rows, so each colour keeps
// at least 4.5:1 there (the old #8f8f8f, #ef4444 and #d97706 did not).
export const recentStatusColor = (status: RecentUploadStatus): string =>
	status === "Failed"
		? "#b91c1c"
		: status === "Cancelled"
			? "#b45309"
			: "#6a6a6a";
