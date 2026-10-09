// Key-image captures that have been asked for but have not finished. Stopping a
// reading session waits for these (ReadingSession ignores a shot added after Stop),
// so a capture the reader started just before Stop still reaches the session.

export type CaptureTracker = {
	track: (capture: Promise<unknown>) => void;
	/** Resolves when every tracked capture has settled, or after maxWaitMs. */
	settled: (maxWaitMs?: number) => Promise<void>;
};

export function createCaptureTracker(): CaptureTracker {
	const pending = new Set<Promise<void>>();
	return {
		track(capture) {
			const done: Promise<void> = capture
				.then(() => {}, () => {})
				.finally(() => pending.delete(done));
			pending.add(done);
		},
		async settled(maxWaitMs = 1500) {
			if (!pending.size) return;
			// Capped so a hidden tab, where animation frames never fire, cannot hold Stop open.
			let timer: number | undefined;
			await Promise.race([
				Promise.allSettled([...pending]),
				new Promise((resolve) => {
					timer = window.setTimeout(resolve, maxWaitMs);
				}),
			]);
			window.clearTimeout(timer);
		},
	};
}
