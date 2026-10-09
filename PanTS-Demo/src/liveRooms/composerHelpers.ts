import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * One send at a time for a composer. The ref closes the gap before the state
 * update renders, so a double click cannot start a second send, and `sending`
 * disables the button while the first is still in flight.
 */
export function useSendOnce() {
	const busy = useRef(false);
	const [sending, setSending] = useState(false);
	const run = async (task: () => Promise<boolean>): Promise<boolean> => {
		if (busy.current) return false;
		busy.current = true;
		setSending(true);
		try {
			return await task();
		} finally {
			busy.current = false;
			setSending(false);
		}
	};
	return { sending, run };
}

/** After a send, a button that disabled itself (in flight, then an empty draft) leaves focus on the page body. Hand it back to the composer field, but leave it alone when the user has already moved on to something else. */
export function refocusComposer(fieldId: string) {
	const active = document.activeElement;
	const lost = !active || active === document.body || (active instanceof HTMLButtonElement && active.disabled);
	if (lost) document.getElementById(fieldId)?.focus();
}

/** Enter sends, Shift+Enter adds a line, and Enter that confirms an IME composition is left alone (Safari reports that one as keyCode 229 after the composition has ended). */
export function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
	if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
	event.preventDefault();
	event.currentTarget.form?.requestSubmit();
}

/** First character of a name for an avatar; slice(0, 1) would cut an emoji's surrogate pair in half. */
export function nameInitial(name: string): string {
	return (Array.from(name)[0] ?? "?").toUpperCase();
}

const EXPORT_OFFLINE = "Could not export. Check your connection and try again.";
const EXPORT_REFUSED = "Could not export. Try again later.";

/**
 * Room exports for a dock: one at a time (the buttons disable while one runs),
 * the previous error is dropped at the start of each try, and a failure
 * shows one plain sentence instead of the browser's "Failed to fetch". Only a
 * network failure (fetch rejects with a TypeError) blames the connection; an
 * Error the server's reply turned into (expired or missing room, export not
 * ready) gets a neutral line, since retrying on a good connection cannot help.
 * The pressed button disables while the export runs, which drops keyboard focus
 * to the page body; once the buttons are enabled again focus goes back to it,
 * unless the user has already moved somewhere else.
 */
export function useRoomExport(download: (kind: "zip" | "pdf") => Promise<void>) {
	const [exporting, setExporting] = useState<"zip" | "pdf" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const busy = useRef(false);
	const pressed = useRef<HTMLElement | null>(null);
	useEffect(() => {
		if (exporting !== null) return;
		const button = pressed.current;
		pressed.current = null;
		const active = document.activeElement;
		if (button?.isConnected && (!active || active === document.body)) button.focus();
	}, [exporting]);
	const run = async (kind: "zip" | "pdf") => {
		if (busy.current) return;
		busy.current = true;
		pressed.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setExporting(kind);
		setError(null);
		try {
			await download(kind);
		} catch (caught) {
			console.error("Live room export failed", caught);
			setError(caught instanceof Error && !(caught instanceof TypeError) ? EXPORT_REFUSED : EXPORT_OFFLINE);
		} finally {
			busy.current = false;
			setExporting(null);
		}
	};
	return { exporting, error, run };
}
