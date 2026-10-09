import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuizPracticeDock, QuizPracticeHeader } from "./QuizPracticeChrome";
import type { QuizPracticeController } from "./types";

const pack = {
	pack_id: "test-pack-v1",
	version: 1,
	case_id: "88",
	title: "Case 88 · Pancreas imaging quiz",
	difficulty: "medium" as const,
	provenance: {},
	generator_version: "generator/1",
	validator_version: "validator/1",
	questions: [
		{
			id: "organ",
			prompt: "Which organ?",
			choices: [{ id: "pancreas", label: "Pancreas" }, { id: "liver", label: "Liver" }],
			viewer_cue: { crosshair_lps: [1, 2, 3] as [number, number, number] },
		},
	],
};

function controller(overrides: Partial<QuizPracticeController> = {}): QuizPracticeController {
	return {
		pack,
		questionIndex: 0,
		answers: {},
		result: null,
		maskUrl: null,
		submitting: false,
		error: null,
		dockOpen: true,
		setDockOpen: vi.fn(),
		selectAnswer: vi.fn(),
		previous: vi.fn(),
		next: vi.fn(),
		reportContent: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("QuizPracticeChrome", () => {
	it("shows one server-authored question and forwards private selection", () => {
		const value = controller();
		render(<><QuizPracticeHeader controller={value} /><QuizPracticeDock controller={value} /></>);
		expect(screen.getByText("Case 88 · medium")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Pancreas/i }));
		expect(value.selectAnswer).toHaveBeenCalledWith("pancreas");
		expect(screen.getByRole("button", { name: /Submit/i })).toBeDisabled();
		expect(screen.getByText("Pick one answer for each question")).toBeInTheDocument();
	});

	it("header has a CT viewer link back to this case's normal viewer", () => {
		render(<QuizPracticeHeader controller={controller()} />);
		const link = screen.getByRole("link", { name: /CT viewer/ });
		expect(link.getAttribute("href")).toBe("/case/88");
	});

	it("reveals answer and explanation only after completed result", () => {
		const value = controller({
			answers: { organ: "liver" },
			result: {
				attempt_id: "attempt",
				pack_id: pack.pack_id,
				pack_version: 1,
				case_id: pack.case_id,
				status: "completed",
				completed_at: "now",
				score: 0,
				max_score: 1,
				answers: { organ: "liver" },
				consistency: { status: "incomplete", reasons: [] },
				reveals: [{
					question_id: "organ",
					correct_choice_id: "pancreas",
					explanation: "Crosshair is in pancreas.",
					source_label: "Structured report finding",
					distribution: { liver: 1, pancreas: 0 },
				}],
			},
		});
		render(<QuizPracticeDock controller={value} />);
		expect(screen.getByText("Incorrect")).toBeInTheDocument();
		expect(screen.getByText("Crosshair is in pancreas.")).toBeInTheDocument();
		expect(screen.getByText("Structured report finding")).toBeInTheDocument();
		expect(screen.getByText("0/1 correct")).toBeInTheDocument();
	});
});
