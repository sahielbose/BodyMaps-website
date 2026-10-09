/**
 * Dead ends on the quiz and live-room routes are branded site pages with a
 * heading and a way back, not bare dark cards.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";

// Both pages hand off to the WebGL viewer on success; never reached here.
vi.mock("../routes/VisualizationPage", () => ({ default: () => <div>viewer</div> }));

import QuizPracticePage from "../education/QuizPracticePage";
import LiveRoomPage from "../liveRooms/LiveRoomPage";

const renderRoute = (path: string, pattern: string, element: ReactNode) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path={pattern} element={element} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

afterEach(() => vi.unstubAllGlobals());

describe("quiz practice error state", () => {
	it("explains a missing pack once, in plain words, with a way back to the dataset", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/quiz-packs/")
					? new Response(JSON.stringify({ error: "Quiz pack is unavailable" }), { status: 404 })
					: new Response("{}", { status: 200 })
			)
		);
		renderRoute("/learn/quiz/does-not-exist", "/learn/quiz/:packId", <QuizPracticePage />);

		expect(await screen.findByRole("heading", { level: 1, name: "This quiz can't be opened" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent(/may have been removed/);
		expect(screen.queryByText(/Quiz pack is unavailable/)).toBeNull();
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
		expect(screen.getByRole("banner")).toBeInTheDocument();
		expect(screen.getByRole("contentinfo")).toHaveTextContent(/nonclinical use only/i);
	});

	it("passes through a message that says something useful, like a rate limit", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ error: "Too many quiz attempts created; try again later" }), { status: 429 })
			)
		);
		renderRoute("/learn/quiz/p1", "/learn/quiz/:packId", <QuizPracticePage />);
		expect(await screen.findByText("Too many quiz attempts created; try again later.")).toBeInTheDocument();
	});
});

describe("live room error state", () => {
	it("turns a link without its key into a branded page with a way back", () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
		renderRoute("/live/does-not-exist", "/live/:roomId", <LiveRoomPage />);

		expect(screen.getByRole("heading", { level: 1, name: "This live room isn't available" })).toBeInTheDocument();
		expect(screen.getByText("Live room")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("Room link is missing its secret key.");
		expect(screen.getByRole("alert")).toHaveTextContent(/whole link/);
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
		expect(screen.queryByText(/Return to dashboard/)).toBeNull();
	});

	/** Opens a room link that carries its key, joins it, and lets the snapshot fail. */
	const joinFailingRoom = async (status: number, body: Record<string, unknown>) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/api/live-rooms/")
					? new Response(JSON.stringify(body), { status })
					: new Response("{}", { status: 200 })
			)
		);
		window.history.pushState({}, "", "/live/r1#secret");
		const user = userEvent.setup();
		renderRoute("/live/r1", "/live/:roomId", <LiveRoomPage />);
		await user.type(screen.getByLabelText("Display name"), "Ada");
		await user.click(screen.getByRole("button", { name: "Join room" }));
		return screen.findByRole("heading", { level: 1, name: "This live room isn't available" });
	};

	afterEach(() => {
		window.history.pushState({}, "", "/");
		sessionStorage.clear();
	});

	it("says a room the server doesn't know may have expired, or the link is incomplete", async () => {
		await joinFailingRoom(404, { error: "Room not found" });
		expect(screen.getByRole("alert")).toHaveTextContent(
			"This room may have expired (rooms are deleted 24 hours after they are created) or the link may be incomplete. Check that you have the whole link, including the part after the #."
		);
	});

	it("doesn't blame the link, or show a raw status, when the server is down", async () => {
		await joinFailingRoom(503, {});
		const alert = screen.getByRole("alert");
		expect(alert).toHaveTextContent("We couldn't load this room. Try again in a moment.");
		expect(alert).not.toHaveTextContent(/whole link/);
		expect(alert).not.toHaveTextContent(/503/);
	});
});

describe("message page surface", () => {
	it("lifts the dark page ground while it shows, and puts it back on the way out", async () => {
		const { default: MessagePage } = await import("../components/MessagePage");
		const { DARK_ROUTE_CLASS } = await import("../helpers/routeSurface");
		window.history.pushState({}, "", "/live/room-1");
		document.documentElement.classList.add(DARK_ROUTE_CLASS);

		const { unmount } = render(
			<AuthProvider>
				<MemoryRouter>
					<MessagePage title="This live room isn't available" actions={[{ label: "Browse the dataset", to: "/dashboard" }]} />
				</MemoryRouter>
			</AuthProvider>
		);
		expect(document.documentElement.classList.contains(DARK_ROUTE_CLASS)).toBe(false);

		unmount();
		expect(document.documentElement.classList.contains(DARK_ROUTE_CLASS)).toBe(true);
		document.documentElement.classList.remove(DARK_ROUTE_CLASS);
		window.history.pushState({}, "", "/");
	});
});
