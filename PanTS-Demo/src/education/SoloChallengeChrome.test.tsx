import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SoloChallengeDock, SoloChallengeHeader } from "./SoloChallengeChrome";
import type { EducationChallenge, EducationResult, SoloChallengeController } from "./types";

const challenge: EducationChallenge = {
	challenge_id: "pancreas-case-35",
	case_id: "35",
	title: "Find the abnormal area in the pancreas",
	eyebrow: "BodyMaps Solo Challenge 01",
	prompt: "Review the scan.",
	time_limit_seconds: 300,
	finding_choices: [
		{ id: "no_focal_lesion", label: "No focal pancreatic lesion" },
		{ id: "focal_pancreatic_lesion", label: "Focal pancreatic lesion" },
	],
	requirements: [],
	scoring: { localization: 35, measurement: 15, finding: 10, impression: 40, time: "tie_break" },
};

function controller(overrides: Partial<SoloChallengeController> = {}): SoloChallengeController {
	return {
		challenge,
		attempt: {
			attempt_id: "attempt-1", attempt_key: "key", challenge_id: challenge.challenge_id,
			started_at: "2026-07-31T12:00:00Z", deadline_at: "2026-07-31T12:05:00Z",
			delete_at: "2026-08-01T12:00:00Z", status: "active",
		},
		remainingSeconds: 240,
		findingChoice: "focal_pancreatic_lesion",
		setFindingChoice: vi.fn(),
		impression: "Focal pancreatic lesion with a measurable axial diameter.",
		setImpression: vi.fn(),
		marker: [-5, -5, 2],
		setMarker: vi.fn(),
		measurement: null,
		setMeasurement: vi.fn(),
		result: null,
		submitting: false,
		retryingGrade: false,
		error: null,
		submit: vi.fn(),
		retryGrade: vi.fn(),
		taskDockOpen: true,
		setTaskDockOpen: vi.fn(),
		clearSession: vi.fn(),
		...overrides,
	};
}

const measurement = { uid: "m1", tool: "Length", label: "", value: "31.0 mm", center: [-5, -5, 2] as [number, number, number] };
const serialized = { id: "m1", tool: "Length", points: [[-4, -4, 2], [-6, -6, 2]], polyline: [], text: "", label: "", frame_of_reference: "", metadata: {} };

describe("Solo Challenge timer", () => {
	// The ticking clock sits in no live region; a separate status line speaks
	// only at one minute left and at time up, so its text changes rarely.
	it("keeps the clock out of every live region", () => {
		render(<SoloChallengeHeader controller={controller({ remainingSeconds: 240 })} />);
		const timer = screen.getByRole("timer");
		expect(timer).toHaveTextContent("04:00");
		expect(timer.closest("[aria-live], [role=status], [role=alert], [role=log]")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent(/^$/);
	});

	it("announces the last minute once and then time up", () => {
		const { rerender } = render(<SoloChallengeHeader controller={controller({ remainingSeconds: 61 })} />);
		const status = screen.getByRole("status");
		expect(status).toHaveTextContent(/^$/);

		rerender(<SoloChallengeHeader controller={controller({ remainingSeconds: 60 })} />);
		expect(status).toHaveTextContent("One minute remaining.");
		rerender(<SoloChallengeHeader controller={controller({ remainingSeconds: 59 })} />);
		expect(status).toHaveTextContent("One minute remaining.");
		expect(screen.getByRole("timer")).toHaveTextContent("00:59");

		rerender(<SoloChallengeHeader controller={controller({ remainingSeconds: 0 })} />);
		expect(status).toHaveTextContent("Time is up.");
	});
});

describe("Solo Challenge chrome", () => {
	it("requires a complete marked and measured interpretation before submission", () => {
		const onSubmit = vi.fn();
		render(<SoloChallengeDock controller={controller()} crosshair={[-5, -5, 2]} measurement={measurement} serializedMeasurement={serialized} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={onSubmit} />);
		expect(screen.getByText("Measure the abnormal area")).toBeInTheDocument();
		expect(screen.getByText(/axial \(top-down\) CT view/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Start measuring" })).toBeEnabled();
		const button = screen.getByRole("button", { name: /Submit interpretation/i });
		expect(button).toBeEnabled();
		fireEvent.click(button);
		expect(onSubmit).toHaveBeenCalledOnce();
	});

	it("keeps Submit disabled for an incomplete form until time runs out, then lets it through", () => {
		const incomplete = { findingChoice: "focal_pancreatic_lesion", marker: null, impression: "" };
		const dock = (remainingSeconds: number) => (
			<SoloChallengeDock controller={controller({ ...incomplete, remainingSeconds })} crosshair={null} measurement={null} serializedMeasurement={null} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={vi.fn()} />
		);
		const { rerender } = render(dock(30));
		expect(screen.getByRole("button", { name: /Submit interpretation/i })).toBeDisabled();
		rerender(dock(0));
		expect(screen.getByRole("button", { name: /Submit interpretation/i })).toBeEnabled();
	});

	it("offers an AI grading retry while preserving a provisional result", () => {
		const retryGrade = vi.fn();
		const result: EducationResult = {
			attempt_id: "attempt-1", challenge_id: challenge.challenge_id, status: "provisional",
			submitted_at: "2026-07-31T12:03:00Z", elapsed_seconds: 180,
			objective_points: 60, total_points: null, max_points: 100,
			scores: {
				localization: { points: 35, max_points: 35, distance_mm: 0, inside_lesion: true },
				measurement: { points: 15, max_points: 15, measured_mm: 31, reference_mm: 30, error_percent: 3.3 },
				finding: { points: 10, max_points: 10, selected: "focal_pancreatic_lesion", correct: "focal_pancreatic_lesion" },
			},
			ai_grade: { status: "provisional", model: "llama", rubric_version: 1, criteria: null, points: null, max_points: 40, feedback: null },
			ground_truth: { correct_finding: "focal_pancreatic_lesion", correct_finding_label: "Focal pancreatic lesion", segmentation_label: 1, mesh_organ_id: 28, location: "pancreatic head", reference_diameter_mm: 30, reference_measurement_lps: [], teaching_points: [] },
		};
		render(<SoloChallengeDock controller={controller({ result, retryGrade })} crosshair={null} measurement={null} serializedMeasurement={null} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={vi.fn()} />);
		expect(screen.getByPlaceholderText("AI tutor becomes available after the impression grade is complete.")).toBeDisabled();
		expect(screen.getByRole("button", { name: "Send question to AI tutor" })).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: /Retry AI grade/i }));
		expect(retryGrade).toHaveBeenCalledOnce();
	});

	it("keeps submission disabled when an abnormal finding has no marker", () => {
		render(<SoloChallengeDock controller={controller({ marker: null })} crosshair={null} measurement={measurement} serializedMeasurement={serialized} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={vi.fn()} />);
		expect(screen.getByRole("button", { name: /Submit interpretation/i })).toBeDisabled();
	});

	it("reveals the score and teaching feedback after submission", () => {
		const result: EducationResult = {
			attempt_id: "attempt-1", challenge_id: challenge.challenge_id, status: "graded",
			submitted_at: "2026-07-31T12:03:00Z", elapsed_seconds: 180,
			objective_points: 60, total_points: 96, max_points: 100,
			scores: {
				localization: { points: 35, max_points: 35, distance_mm: 0, inside_lesion: true },
				measurement: { points: 15, max_points: 15, measured_mm: 31, reference_mm: 30, error_percent: 3.3 },
				finding: { points: 10, max_points: 10, selected: "focal_pancreatic_lesion", correct: "focal_pancreatic_lesion" },
			},
			ai_grade: { status: "graded", model: "llama", rubric_version: 1, criteria: { finding: 10, location: 9, evidence: 8, impression: 9 }, points: 36, max_points: 40, feedback: "Strong calibrated impression." },
			ground_truth: { correct_finding: "focal_pancreatic_lesion", correct_finding_label: "Abnormal area in the pancreas", segmentation_label: 1, mesh_organ_id: 28, location: "pancreatic head", reference_diameter_mm: 30, reference_measurement_lps: [], teaching_points: ["Use the top-down CT view."] },
		};
		render(<SoloChallengeDock controller={controller({ result })} crosshair={null} measurement={null} serializedMeasurement={null} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={vi.fn()} />);
		expect(screen.getByText("96")).toBeInTheDocument();
		expect(screen.getByText("Correct answer")).toBeInTheDocument();
		expect(screen.getByText("Abnormal area in the pancreas")).toBeInTheDocument();
		expect(screen.getByText("Widest size")).toBeInTheDocument();
		expect(screen.getByText("30 mm")).toBeInTheDocument();
		expect(screen.getByText("Strong calibrated impression.")).toBeInTheDocument();
		expect(screen.getByPlaceholderText("Ask why the measurement or impression was scored this way…")).toBeEnabled();
		expect(screen.getByRole("button", { name: "Send question to AI tutor" })).toBeDisabled();
	});

	it("shows an accessible typing indicator while the AI tutor is responding", () => {
		const pendingResponse = new Promise<Response>(() => undefined);
		const fetchMock = vi.fn(() => pendingResponse);
		vi.stubGlobal("fetch", fetchMock);
		const result: EducationResult = {
			attempt_id: "attempt-1", challenge_id: challenge.challenge_id, status: "graded",
			submitted_at: "2026-07-31T12:03:00Z", elapsed_seconds: 180,
			objective_points: 60, total_points: 96, max_points: 100,
			scores: {
				localization: { points: 35, max_points: 35, distance_mm: 0, inside_lesion: true },
				measurement: { points: 15, max_points: 15, measured_mm: 31, reference_mm: 30, error_percent: 3.3 },
				finding: { points: 10, max_points: 10, selected: "focal_pancreatic_lesion", correct: "focal_pancreatic_lesion" },
			},
			ai_grade: { status: "graded", model: "qwen", rubric_version: 1, criteria: { finding: 10, location: 9, evidence: 8, impression: 9 }, points: 36, max_points: 40, feedback: "Strong calibrated impression." },
			ground_truth: { correct_finding: "focal_pancreatic_lesion", correct_finding_label: "Abnormal area in the pancreas", segmentation_label: 1, mesh_organ_id: 28, location: "pancreatic head", reference_diameter_mm: 30, reference_measurement_lps: [], teaching_points: [] },
		};
		render(<SoloChallengeDock controller={controller({ result })} crosshair={null} measurement={null} serializedMeasurement={null} onSetMarker={vi.fn()} onActivateMeasure={vi.fn()} onSubmit={vi.fn()} />);
		fireEvent.change(screen.getByPlaceholderText("Ask why the measurement or impression was scored this way…"), { target: { value: "What can I improve?" } });
		fireEvent.click(screen.getByRole("button", { name: "Send question to AI tutor" }));
		expect(screen.getByRole("status", { name: "AI tutor is thinking" })).toBeInTheDocument();
		expect(screen.getByText("What can I improve?")).toBeInTheDocument();
		expect(fetchMock).toHaveBeenCalledOnce();
		const request = fetchMock.mock.calls[0][1] as RequestInit;
		expect(JSON.parse(String(request.body))).toEqual({ message: "What can I improve?", history: [] });
		vi.unstubAllGlobals();
	});
});
