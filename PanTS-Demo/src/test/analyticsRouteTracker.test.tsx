/**
 * AnalyticsRouteTracker turns time on a route into one page view per
 * foreground stretch: navigating away records the old route once, time in
 * the background never counts, and a blip (the tab hidden then shown straight
 * back, or pagehide right after the tab was hidden) isn't a visit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";

const trackPageView = vi.fn();
const flush = vi.fn();
vi.mock("../helpers/analytics", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../helpers/analytics")>();
	return { ...actual, trackPageView: (...a: unknown[]) => trackPageView(...a), flush: (...a: unknown[]) => flush(...a) };
});

import AnalyticsRouteTracker from "../components/AnalyticsRouteTracker";

function GoTo({ to }: { to: string }) {
	const navigate = useNavigate();
	return <button type="button" onClick={() => navigate(to)}>go</button>;
}

let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState) {
	visibility = state;
	act(() => {
		document.dispatchEvent(new Event("visibilitychange"));
	});
}

function advance(ms: number) {
	vi.setSystemTime(Date.now() + ms);
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-29T10:00:00Z"));
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
	trackPageView.mockClear();
	flush.mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function renderTracker() {
	return render(
		<MemoryRouter initialEntries={["/upload"]}>
			<AnalyticsRouteTracker />
			<GoTo to="/dashboard" />
		</MemoryRouter>,
	);
}

describe("AnalyticsRouteTracker", () => {
	it("records the route you leave exactly once", () => {
		renderTracker();
		advance(5000);
		fireEvent.click(screen.getByRole("button", { name: "go" }));

		expect(trackPageView).toHaveBeenCalledTimes(1);
		expect(trackPageView).toHaveBeenCalledWith("/upload", 5000);
	});

	it("records a stretch once when the tab is hidden and then the page goes away", () => {
		renderTracker();
		advance(3000);
		setVisibility("hidden");
		advance(20);
		act(() => {
			window.dispatchEvent(new Event("pagehide"));
		});

		expect(trackPageView).toHaveBeenCalledTimes(1);
		expect(trackPageView).toHaveBeenCalledWith("/upload", 3000);
		expect(flush).toHaveBeenCalledWith(true);
	});

	it("doesn't count a blip in front as a visit", () => {
		renderTracker();
		advance(4000);
		setVisibility("hidden");
		trackPageView.mockClear();

		advance(60_000);
		setVisibility("visible");
		advance(20);
		setVisibility("hidden");

		expect(trackPageView).not.toHaveBeenCalled();
	});

	it("leaves time in the background out", () => {
		renderTracker();
		advance(2000);
		setVisibility("hidden");
		advance(60_000);
		setVisibility("visible");
		advance(3000);
		fireEvent.click(screen.getByRole("button", { name: "go" }));

		expect(trackPageView.mock.calls).toEqual([["/upload", 2000], ["/upload", 3000]]);
	});
});
