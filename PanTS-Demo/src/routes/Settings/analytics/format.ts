// Turning stored values into something readable at a glance.

/** "4m 12s", "1h 20m", "3.2s" — the largest unit that isn't a lie. */
export const duration = (ms: number): string => {
	if (!ms) return "0s";
	// A tenth of a second only while it still reads as under ten; past that the
	// seconds are rounded first, so 59.6s carries into "1m 0s", not "60s".
	if (ms < 9950) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
};

export const count = (n: number): string => n.toLocaleString();

/** "1 visit", "2 visits": a count with its noun agreeing with it. */
export const plural = (n: number, one: string, many: string): string =>
	`${count(n)} ${n === 1 ? one : many}`;

/** First letter up, rest untouched — for plan names, account types, roles. */
export const titleCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

// Event names are stored as they're fired ("upload_start_inference") because
// that's the string the code uses and the one to grep for. They're only
// prettified at the last moment, here.
const WORDS: Record<string, string> = {
	ai: "AI",
	cta: "CTA",
};

export const eventLabel = (name: string): string => {
	const words = name.split("_").map((w) => WORDS[w] ?? w);
	return [titleCase(words[0]), ...words.slice(1)].join(" ");
};

/** The area of the app an event belongs to, from its prefix. */
export const eventArea = (name: string): string => {
	const area = name.split("_")[0];
	return area === "auth" ? "account" : area;
};

/** "8 Aug" — the axis is a range of days, so the year would be noise. */
export const shortDay = (iso: string): string => {
	const d = new Date(`${iso}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};

/** "8 Aug 2026": a day of the range the server actually used, where the year
 *  matters. The server sends datetimes ("2026-09-01T00:00:00"), so only the
 *  date part is read. */
export const longDay = (iso: string): string => {
	const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};

/** The last day a range covers. The server's end is exclusive when it is a
 *  picked "to" date (the next midnight), so that reads as the day before. */
export const lastDay = (iso: string): string => {
	const midnight = /T00:00:00(\.0+)?$/.test(iso);
	const d = new Date(`${iso.slice(0, 10)}T00:00:00`);
	if (!midnight || Number.isNaN(d.getTime())) return longDay(iso);
	d.setDate(d.getDate() - 1);
	return longDay(dateString(d));
};

const dateString = (d: Date): string =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** YYYY-MM-DD for an <input type="date">, n days back from today, on the
 *  viewer's own calendar (toISOString would read it in UTC, a day ahead of
 *  evening viewers west of Greenwich). */
export const dateInput = (daysAgo = 0): string => {
	const d = new Date();
	d.setDate(d.getDate() - daysAgo);
	return dateString(d);
};

/** The "to" date to send the server. It counts days in UTC and ends the range
 *  at the end of that UTC day, so the viewer's own today (the default) would
 *  stop at the next UTC midnight and drop the newest events for an evening
 *  viewer west of Greenwich. Today is therefore sent as today's UTC date, which
 *  runs through now; any other picked day goes as it is. */
export const serverTo = (from: string, to: string): string => {
	if (to !== dateInput(0)) return to;
	const utcToday = new Date().toISOString().slice(0, 10);
	// Ahead of Greenwich the UTC date can sit before a "from" picked as today.
	return utcToday > from ? utcToday : to;
};

/** A figure against the same figure last period.
 *
 *  Returns null when there is nothing honest to say: no previous period at all
 *  (this is the first month the site has data for) reads as infinite growth,
 *  and "+100%" off a base of one visit is noise dressed as a trend. Both are
 *  better left blank than stated — the tile still shows the number itself.
 */
export const delta = (current: number, previous: number): {
	pct: number; up: boolean; label: string;
} | null => {
	if (!previous) return null;
	const change = ((current - previous) / previous) * 100;
	if (Math.abs(change) < 1) return null;  // flat; a "+0%" badge is just clutter
	const rounded = Math.round(change);
	return {
		pct: rounded,
		up: rounded > 0,
		label: `${rounded > 0 ? "+" : ""}${rounded}%`,
	};
};
