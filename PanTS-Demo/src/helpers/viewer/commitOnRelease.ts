// helpers/viewer/commitOnRelease.ts

// Same slack as the smart fill and point prompt tools: a press that travels
// this far is a pan, not a click.
const PAN_SLACK_PX = 4;

let cancelPending: (() => void) | null = null;

/**
 * Runs `commit` when the left button comes back up, but only if the pointer
 * stayed put since `down`. Pan stays on the left button while the click tools
 * (level tracing, scissors, lasso, island pick) are armed, so acting on
 * mousedown would edit the mask or drop a point at the start of every pan
 * drag. The release is read from the window so one that lands outside the
 * pane still ends the press; a window blur has no release and drops it.
 * A new press replaces any one still pending.
 */
export function commitOnRelease(down: { clientX: number; clientY: number }, commit: () => void) {
	cancelPending?.();
	let moved = false;
	const onMove = (e: MouseEvent) => {
		if (Math.abs(e.clientX - down.clientX) >= PAN_SLACK_PX || Math.abs(e.clientY - down.clientY) >= PAN_SLACK_PX) moved = true;
	};
	const stop = () => {
		window.removeEventListener("mousemove", onMove);
		window.removeEventListener("mouseup", onUp);
		window.removeEventListener("blur", stop);
		if (cancelPending === stop) cancelPending = null;
	};
	const onUp = (e: MouseEvent) => {
		onMove(e);
		stop();
		if (!moved) commit();
	};
	cancelPending = stop;
	window.addEventListener("mousemove", onMove);
	window.addEventListener("mouseup", onUp);
	window.addEventListener("blur", stop);
}
