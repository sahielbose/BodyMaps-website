import { Component, type ReactNode } from "react";

type Props = {
	fallback: ReactNode;
	children: ReactNode;
	onError?: (error: unknown) => void;
	/** When this changes, a boundary that has caught an error tries its children again (the route boundary passes the location key, so a link to the current path also resets it). */
	resetKey?: string;
};
type State = { hasError: boolean };

// Minimal error boundary: if a child throws while rendering (e.g. the three.js
// loader fails to get a WebGL context, or a lazy chunk fails to load), show the
// fallback instead of crashing the subtree to a blank/white canvas.
export default class ErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false };

	static getDerivedStateFromError(): State {
		return { hasError: true };
	}

	componentDidCatch(error: unknown) {
		console.error("ErrorBoundary caught:", error);
		this.props.onError?.(error);
	}

	componentDidUpdate(prev: Props) {
		if (this.state.hasError && prev.resetKey !== this.props.resetKey) this.setState({ hasError: false });
	}

	render() {
		return this.state.hasError ? this.props.fallback : this.props.children;
	}
}
