/**
 * The overview's count-up. The live CT-volume figure arrives from the API at
 * an unknown moment and can differ from the fallback in size and digit count:
 * the row must reserve the width of the figure it will end on, and the count
 * must never run backwards.
 */
import { act, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import LandingPage from "../routes/LandingPage";

const json = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

let answerSearch: (total: number) => void = () => {};

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"],
	});
	global.fetch = vi.fn((url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/search")) {
			return new Promise((resolve) => {
				answerSearch = (total) => resolve(json({ items: [], total, ids: [] }));
			});
		}
		if (u.includes("/api/auth/me")) return Promise.resolve(json({ user: null }));
		return Promise.resolve(json({ google: true, github: true }));
	}) as unknown as typeof fetch;
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const renderLanding = () =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<LandingPage />
			</MemoryRouter>
		</AuthProvider>,
	);

/** The CT volumes cell: the hidden final figure and the visible count. */
const volumeCell = (container: HTMLElement) => {
	const [finalSpan, countSpan] = Array.from(container.querySelector("dd")!.children) as HTMLElement[];
	return { finalSpan, countSpan };
};

const numberIn = (el: HTMLElement) => Number((el.textContent ?? "").replace(/[^0-9]/g, ""));

/** Advances time frame by frame, collecting what the count shows. */
const run = (ms: number, countSpan: HTMLElement, seen: number[]) => {
	for (let t = 0; t < ms; t += 16) {
		act(() => {
			vi.advanceTimersByTime(16);
		});
		seen.push(numberIn(countSpan));
	}
};

const settle = async (total: number) => {
	await act(async () => {
		answerSearch(total);
	});
};

const neverDecreases = (values: number[]) => values.every((v, i) => i === 0 || v >= values[i - 1]);

describe("overview stats count-up", () => {
	it("waits for the live figure, reserves its width, and counts straight up to it", async () => {
		const { container } = renderLanding();
		const { finalSpan, countSpan } = volumeCell(container);
		const seen: number[] = [];

		// Answered after the row has begun to fade in (the count would already
		// be running toward the 32,768 fallback without the wait).
		run(900, countSpan, seen);
		expect(seen.every((v) => v === 0)).toBe(true);
		await settle(9_262);
		// The reservation is the figure the count will end on, from the start.
		expect(finalSpan).toHaveTextContent("9,262");

		run(2_400, countSpan, seen);
		expect(countSpan).toHaveTextContent("9,262");
		expect(neverDecreases(seen)).toBe(true);
		expect(Math.max(...seen)).toBe(9_262);
	});

	it("a lower figure that arrives after the count finished is shown, not counted down to", async () => {
		const { container } = renderLanding();
		const { finalSpan, countSpan } = volumeCell(container);
		const seen: number[] = [];

		run(4_000, countSpan, seen);
		expect(countSpan).toHaveTextContent("32,768");
		await settle(9_262);
		const after: number[] = [];
		run(1_000, countSpan, after);
		expect(finalSpan).toHaveTextContent("9,262");
		expect(after.every((v) => v === 9_262)).toBe(true);
	});

	it("a higher figure that arrives mid-count is eased up to, never backwards", async () => {
		const { container } = renderLanding();
		const { finalSpan, countSpan } = volumeCell(container);
		const seen: number[] = [];

		run(1_700, countSpan, seen);
		await settle(1_234_567);
		expect(finalSpan).toHaveTextContent("1,234,567");
		run(2_500, countSpan, seen);
		expect(countSpan).toHaveTextContent("1,234,567");
		expect(neverDecreases(seen)).toBe(true);
	});
});
