import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import type { EducationResult, SoloChallengeController } from "./types";
import { readSoloChallengeSession, writeSoloChallengeSession } from "./soloChallengeSession";

vi.mock("../routes/VisualizationPage", () => ({
	default: ({ soloChallenge }: { soloChallenge: SoloChallengeController }) => (
		<main>
			<span>{soloChallenge.attempt.attempt_id}</span>
			<span>{soloChallenge.findingChoice}</span>
			<span>{soloChallenge.impression}</span>
			<span>{soloChallenge.marker?.join(",")}</span>
			<span>{soloChallenge.measurement?.id}</span>
			<span>{soloChallenge.maskUrl ?? "reveal hidden"}</span>
			<span data-testid="solo-error">{soloChallenge.error}</span>
			<span data-testid="solo-reveal-error">{soloChallenge.revealError}</span>
			<button onClick={() => soloChallenge.setImpression("Updated after restore")}>Update impression</button>
		</main>
	),
}));

import SoloChallengePage from "./SoloChallengePage";

const challengeId = "pancreas-case-35";
const challenge = {
	challenge_id: challengeId,
	case_id: "35",
	title: "Find the abnormal area in the pancreas",
	eyebrow: "BodyMaps Solo Challenge 01",
	prompt: "Review the CT scan.",
	time_limit_seconds: 300,
	finding_choices: [],
	requirements: [],
	scoring: { localization: 35, measurement: 15, finding: 10, impression: 40, time: "tie_break" as const },
};

describe("SoloChallengePage session recovery", () => {
	beforeEach(() => {
		sessionStorage.clear();
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/result")) {
				return new Response(JSON.stringify({ error: "Attempt has not been submitted" }), {
					status: 400,
				headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(challenge), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}));
	});

	afterEach(() => vi.unstubAllGlobals());

	it("restores and continues persisting an in-progress attempt after remount", async () => {
		writeSoloChallengeSession(challengeId, {
			attempt: {
				attempt_id: "attempt-restored",
				attempt_key: "key",
				challenge_id: challengeId,
				started_at: "2099-01-01T12:00:00Z",
				deadline_at: "2099-01-01T12:05:00Z",
				delete_at: "2099-01-02T12:00:00Z",
				status: "active",
			},
			findingChoice: "focal_pancreatic_lesion",
			impression: "Saved impression",
			marker: [1, 2, 3],
			measurement: {
				id: "saved-length",
				tool: "Length",
				points: [[1, 2, 3], [4, 5, 6]],
				polyline: [],
				text: "",
				label: "",
				frame_of_reference: "frame-1",
				metadata: {},
			},
			result: null,
		});

		render(
			<MemoryRouter initialEntries={[`/live/challenge/${challengeId}`]}>
				<Routes>
					<Route path="/live/challenge/:challengeId" element={<SoloChallengePage />} />
				</Routes>
			</MemoryRouter>,
		);

		expect(await screen.findByText("attempt-restored")).toBeInTheDocument();
		expect(screen.getByText("focal_pancreatic_lesion")).toBeInTheDocument();
		expect(screen.getByText("Saved impression")).toBeInTheDocument();
		expect(screen.getByText("1,2,3")).toBeInTheDocument();
		expect(screen.getByText("saved-length")).toBeInTheDocument();
		expect(screen.getByText("reveal hidden")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Update impression" }));
		await waitFor(() => {
			expect(readSoloChallengeSession(challengeId)?.impression).toBe("Updated after restore");
		});
	});
});

describe("SoloChallengePage failures", () => {
	const jsonResponse = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	const attempt = {
		attempt_id: "attempt-new",
		attempt_key: "key",
		challenge_id: challengeId,
		started_at: "2099-01-01T12:00:00Z",
		deadline_at: "2099-01-01T12:05:00Z",
		delete_at: "2099-01-02T12:00:00Z",
		status: "active",
	};
	const renderPage = () =>
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={[`/live/challenge/${challengeId}`]}>
					<Routes>
						<Route path="/live/challenge/:challengeId" element={<SoloChallengePage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>,
		);

	beforeEach(() => sessionStorage.clear());
	afterEach(() => vi.unstubAllGlobals());

	it("keeps the start card after a failed start, shows why and lets the learner try again", async () => {
		let starts = 0;
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/attempts") && init?.method === "POST") {
				starts += 1;
				return starts === 1
					? jsonResponse({ error: "Too many quiz attempts created; try again later" }, 429)
					: jsonResponse(attempt);
			}
			if (url.endsWith("/result")) return jsonResponse({ error: "Attempt has not been submitted" }, 400);
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /Start solo challenge/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent("Too many quiz attempts created");
		expect(screen.queryByText("Challenge unavailable")).not.toBeInTheDocument();
		expect(document.querySelector(".edu-loading")).toBeNull();
		expect(screen.getByRole("link", { name: "Return to case 35" })).toHaveAttribute("href", "/case/35");

		const retry = screen.getByRole("button", { name: /Try again/ });
		await waitFor(() => expect(retry).toBeEnabled());
		fireEvent.click(retry);
		expect(await screen.findByText("attempt-new")).toBeInTheDocument();
	});

	it("says plainly when the server cannot run the challenge, and offers only the way back", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/attempts") && init?.method === "POST") {
				return jsonResponse({ error: "Case 35 ground-truth segmentation is unavailable", code: "challenge_unavailable" }, 409);
			}
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /Start solo challenge/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"This challenge can't be started here because its answer data isn't installed on this server.",
		);
		expect(screen.queryByText(/ground-truth segmentation/)).toBeNull();
		expect(screen.queryByRole("button", { name: /Try again|Start solo challenge/ })).toBeNull();
		expect(screen.getByRole("link", { name: "Return to case 35" })).toHaveAttribute("href", "/case/35");
	});

	it("says in words when the server cannot be reached", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/attempts") && init?.method === "POST") throw new TypeError("Failed to fetch");
			return jsonResponse(challenge);
		}));
		renderPage();

		fireEvent.click(await screen.findByRole("button", { name: /Start solo challenge/ }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Could not reach the server. Check your connection and try again.",
		);
	});

	it("offers a retry without a spinner when the server cannot be reached to load the challenge", async () => {
		let loads = 0;
		vi.stubGlobal("fetch", vi.fn(async () => {
			loads += 1;
			if (loads === 1) throw new TypeError("Failed to fetch");
			return jsonResponse(challenge);
		}));
		renderPage();

		expect(await screen.findByRole("heading", { name: "This challenge isn't available" })).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("couldn't reach the server");
		expect(document.querySelector(".edu-loading")).toBeNull();
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("button", { name: /Start solo challenge/ })).toBeInTheDocument();
	});
	it("says in words, apart from the grading error, when the reveal is unavailable after a restored result", async () => {
		writeSoloChallengeSession(challengeId, {
			attempt: { ...attempt, status: "active" as const },
			findingChoice: "",
			impression: "",
			marker: null,
			measurement: null,
			result: {
				attempt_id: attempt.attempt_id,
				challenge_id: challengeId,
				status: "graded",
			} as unknown as EducationResult,
		});
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/reveal-segmentation.nii.gz")) return jsonResponse({ error: "Reveal unavailable" }, 404);
			return jsonResponse(challenge);
		}));
		renderPage();

		await waitFor(() => {
			expect(screen.getByTestId("solo-reveal-error")).toHaveTextContent(
				"The answer overlay is not available for this challenge. Your score and review are still available.",
			);
		});
		expect(screen.getByTestId("solo-error")).toHaveTextContent("");
	});
});
