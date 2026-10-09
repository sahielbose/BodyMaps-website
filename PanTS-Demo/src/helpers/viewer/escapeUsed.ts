// Whether something on the page already used an Escape keypress.
//
// The case viewer's own Escape (disarm the armed tool) only runs for an
// Escape nothing else wanted: a popup closing, a half-drawn shape clearing
// or a flyout shutting each use it up. defaultPrevented can't carry that,
// because Cornerstone calls preventDefault on every key that reaches a
// focused viewport, which is wherever the person last clicked. So whatever
// closes or cancels on Escape marks the event here instead.
const used = new WeakSet<Event>();

export function markEscapeUsed(e: Event): void {
	used.add(e);
}

export function escapeWasUsed(e: Event): boolean {
	return used.has(e);
}

// INPUT types that take no typed text; every other type is a text field, which keeps its own
// Escape (a rename cancels on it) wherever a page decides what an Escape means.
export const NON_TEXT_INPUT_TYPES = new Set(["range", "checkbox", "radio", "button", "submit", "reset"]);
