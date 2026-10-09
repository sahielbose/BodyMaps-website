/** A server timestamp as a Date. The server's times are UTC, and an ISO string
 *  with no Z or offset would be read as local time, so those get a Z. */
export const parseServerTime = (iso: string): Date => {
	const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(iso.trim());
	return new Date(hasZone ? iso : `${iso.trim()}Z`);
};

/** Milliseconds until a server timestamp. */
export const msUntil = (iso: string): number => parseServerTime(iso).getTime() - Date.now();
