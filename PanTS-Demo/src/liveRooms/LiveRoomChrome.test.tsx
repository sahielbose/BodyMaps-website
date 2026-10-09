import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LiveRoomDock, LiveRoomHeader } from "./LiveRoomChrome";
import type { LiveRoomController } from "./types";

function controller(overrides: Partial<LiveRoomController> = {}): LiveRoomController {
	return {
		metadata: {
			room_id: "room-1", case_id: "35", resolution: "low",
			created_at: "2026-07-12T00:00:00Z", expires_at: "2026-07-13T00:00:00Z",
			geometry_hash: "hash", dimensions: [4, 4, 2], latest_seq: 0,
			mode: "review",
		},
		roomKey: "secret",
		maskUrl: "blob:mask",
		participantId: "self",
		name: "Ronit",
		connectionState: "connected",
		participants: [
			{ participant_id: "self", name: "Ronit", color: "#22d3ee", role: "reviewer" },
			{ participant_id: "peer", name: "Maya", color: "#f59e0b", role: "reviewer", plane: "axial" },
		],
		state: { measurements: {}, notes: {}, chat: [] },
		pendingEvents: [],
		acknowledgeEvents: vi.fn(),
		followingId: null,
		error: null,
		undoNotice: null,
		quiz: null,
		quizOwnSubmissions: {},
		quizEligible: false,
		isHost: false,
		collaborationLocked: false,
		sendDurable: vi.fn(), sendPresence: vi.fn(), sendView: vi.fn(), sendChat: vi.fn(),
		addNote: vi.fn(), deleteNote: vi.fn(), requestUndo: vi.fn(), follow: vi.fn(),
		stopFollowing: vi.fn(), copyShareLink: vi.fn(), downloadExport: vi.fn(),
		startQuiz: vi.fn(), answerQuiz: vi.fn(), closeQuiz: vi.fn(), revealQuiz: vi.fn(), advanceQuiz: vi.fn(),
		...overrides,
	};
}

describe("Live Room collaboration chrome", () => {
	it("shows dynamic five-question race copy in lobby", () => {
		const room = controller({
			metadata: { ...controller().metadata, mode: "quiz", quiz_pack_id: "radworld-case-35-v2", quiz_timer_seconds: 30 },
			isHost: true,
			quiz: {
				phase: "lobby", question_index: -1, question_count: 5, current_question: null,
				deadline_at: null, remaining_seconds: 30, timer_paused: false,
				response_count: 0, eligible_count: 0, reveal: null, leaderboard: [],
				consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 0 }, round_completed: false, host_connected: true,
			},
		});
		render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		expect(screen.getByText("5 linked questions")).toBeInTheDocument();
	});

	it("header has a Leave link back to this case's normal viewer", () => {
		const room = controller();
		render(<LiveRoomHeader room={room} dockOpen={false} onToggleDock={vi.fn()} />);
		const leave = screen.getByRole("link", { name: /Leave/ });
		// case_id "35" in the fixture -> the solo case viewer route.
		expect(leave.getAttribute("href")).toMatch(/\/case\/35$/);
	});

	it("shows equal participants and lets anyone follow another participant", () => {
		const room = controller();
		render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		expect(screen.getByText("Ronit (you)")).toBeInTheDocument();
		expect(screen.getByText("Maya")).toBeInTheDocument();
		expect(screen.queryByText(/owner|host|admin/i)).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Follow Maya" }));
		expect(room.follow).toHaveBeenCalledWith("peer");
	});

	it("disables collaborative composition while reconnecting", () => {
		const room = controller({ connectionState: "reconnecting" });
		render(<LiveRoomDock room={room} crosshair={[1, 2, 3]} activePlane="axial" onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("tab", { name: /Chat/ }));
		expect(screen.getByLabelText("Room message")).toBeDisabled();
		expect(screen.getByText("Reconnecting. Edits are paused.")).toBeInTheDocument();
	});

	it("keeps the quiz countdown out of the live region and announces answers and phases", () => {
		const quiz = {
			phase: "question_open" as const, question_index: 0, question_count: 4,
			current_question: { id: "organ", prompt: "Which organ?", choices: [{ id: "pancreas", label: "Pancreas" }] },
			deadline_at: "2099-01-01T00:00:00Z", remaining_seconds: 30, timer_paused: false,
			response_count: 1, eligible_count: 3, reveal: null, leaderboard: [],
			consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 0 }, round_completed: false, host_connected: true,
		};
		const room = controller({
			metadata: { ...controller().metadata, mode: "quiz", quiz_pack_id: "radworld-case-35-v1", quiz_timer_seconds: 30 },
			quiz,
		});
		render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);

		const timer = screen.getByRole("timer");
		expect(timer.textContent).toMatch(/\d+s$/);
		expect(timer.closest("[aria-live], [role=status], [role=alert], [role=log]")).toBeNull();
		expect(screen.getByRole("status")).toHaveTextContent("Question 1 open. 1 of 3 answered.");
		expect(screen.getByRole("status")).not.toHaveTextContent(/\d+s/);
	});

	it("renders private student choices and sends one quiz answer", () => {
		const answerQuiz = vi.fn(() => true);
		const room = controller({
			metadata: { ...controller().metadata, mode: "quiz", quiz_pack_id: "radworld-case-35-v1", quiz_timer_seconds: 30 },
			participants: [{ participant_id: "self", name: "Ronit", color: "#22d3ee", role: "student" }],
			quizEligible: true,
			collaborationLocked: true,
			answerQuiz,
			quiz: {
				phase: "question_open", question_index: 0, question_count: 4,
				current_question: { id: "organ", prompt: "Which organ?", choices: [{ id: "pancreas", label: "Pancreas" }, { id: "liver", label: "Liver" }] },
				deadline_at: "2099-01-01T00:00:00Z", remaining_seconds: 30, timer_paused: false,
				response_count: 0, eligible_count: 1, reveal: null, leaderboard: [],
				consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 0 }, round_completed: false, host_connected: true,
			},
		});
		render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /Pancreas/i }));
		expect(answerQuiz).toHaveBeenCalledWith("pancreas");
		expect(screen.getByText(/Chat and editing return after reveal/i)).toBeInTheDocument();
	});

	it("reveals personal correctness, aggregate distribution, and consistency feedback", () => {
		const downloadExport = vi.fn(() => Promise.resolve());
		const room = controller({
			metadata: { ...controller().metadata, mode: "quiz", quiz_pack_id: "radworld-case-35-v1", quiz_timer_seconds: 30 },
			participants: [{ participant_id: "self", name: "Ronit", color: "#22d3ee", role: "student" }],
			quizOwnSubmissions: {
				organ: { choice_id: "pancreas", answered_at: "2026-08-06T12:00:03Z", response_ms: 3000, name: "Ronit" },
			},
			downloadExport,
			quiz: {
				phase: "question_revealed", question_index: 0, question_count: 4,
				current_question: { id: "organ", prompt: "Which organ?", choices: [{ id: "pancreas", label: "Pancreas" }, { id: "liver", label: "Liver" }] },
				deadline_at: null, remaining_seconds: 0, timer_paused: false,
				response_count: 2, eligible_count: 2,
				reveal: {
					question_id: "organ", correct_choice_id: "pancreas",
					explanation: "The synchronized crosshair is within the pancreas.",
					source_label: "Structured report finding",
					distribution: { pancreas: 1, liver: 1 },
				},
				leaderboard: [{
					rank: 1, participant_id: "self", name: "Ronit", score: 1, max_score: 1, total_response_ms: 3000,
					consistency: { status: "incomplete", reasons: ["Complete the remaining linked questions."] },
				}],
				consistency_summary: { consistent: 0, inconsistent: 0, incomplete: 1 }, round_completed: false, host_connected: true,
			},
		});
		render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		expect(screen.getByText("Your answer is correct")).toBeInTheDocument();
		expect(screen.getByText("The synchronized crosshair is within the pancreas.")).toBeInTheDocument();
		expect(screen.getByText("Structured report finding")).toBeInTheDocument();
		// Mid-race, an incomplete row's reasons only say that questions are still to come.
		expect(screen.queryByText("Complete the remaining linked questions.")).not.toBeInTheDocument();
		expect(screen.getByLabelText("Answer distribution")).toHaveTextContent("Pancreas Correct answer1");
		expect(screen.queryByRole("button", { name: "Export quiz ZIP" })).not.toBeInTheDocument();
		expect(downloadExport).not.toHaveBeenCalled();
	});

	it("offers exports only after quiz completion", () => {
		const downloadExport = vi.fn(() => Promise.resolve());
		const room = controller({
			metadata: { ...controller().metadata, mode: "quiz", quiz_pack_id: "radworld-case-35-v1", quiz_timer_seconds: 30 },
			downloadExport,
			quiz: {
				phase: "completed", question_index: 3, question_count: 4, current_question: null,
				deadline_at: null, remaining_seconds: 0, timer_paused: false,
				response_count: 1, eligible_count: 1, reveal: null, leaderboard: [],
				consistency_summary: { consistent: 1, inconsistent: 0, incomplete: 0 }, round_completed: true, host_connected: true,
			},
		});
		render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: "Export quiz ZIP" }));
		expect(downloadExport).toHaveBeenCalledWith("zip");
	});
});
