import { lazy, useRef, type ComponentType } from "react";
import { useLocation } from "react-router";

// Routes whose chunk failed to load, each with a function that drops the
// rejected lazy component so the next render imports the chunk again.
const failedRoutes = new Set<() => void>();

/**
 * React.lazy for a route component that can be fetched again after a failure.
 * lazy() keeps a rejected import for good and rethrows the same error on every
 * later render, so a chunk that failed once (offline, a flaky connection) kept
 * the route on its error page until a full reload, even from the site header
 * once the network was back. The failure itself is still rethrown to the
 * route's error boundary, and retries React makes while that visit is still on
 * screen keep the rejected component, so a dead network does not turn into a
 * loop of fetches. The rejected component is dropped by
 * useRetryFailedRoutesOnNavigation, once the visit that failed is over.
 */
export function lazyRoute<P extends object>(
	load: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
	function fresh() {
		return lazy(() =>
			load().catch((error) => {
				failedRoutes.add(() => {
					Inner = fresh();
				});
				throw error;
			}),
		);
	}
	let Inner = fresh();
	return function LazyRoute(props: P) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const Current = Inner as ComponentType<any>;
		return <Current {...props} />;
	};
}

/**
 * Call from the component that renders the route error boundary. Any navigation
 * ends the visit that failed, including a link to the path it is already on
 * (the location key changes even when the path does not) and Back or Forward to
 * the failed entry itself (history restores its old key, so the key alone could
 * not tell the two visits apart), and the next visit to a route imports its
 * chunk again.
 */
export function useRetryFailedRoutesOnNavigation() {
	const { key } = useLocation();
	const lastKey = useRef(key);
	if (lastKey.current !== key) {
		lastKey.current = key;
		failedRoutes.forEach((retry) => retry());
		failedRoutes.clear();
	}
}
