import type { SharedMeasurement } from "../helpers/CornerstoneNifti2";

export type EducationFindingChoice = {
	id: string;
	label: string;
};

export type EducationChallenge = {
	challenge_id: string;
	case_id: string;
	title: string;
	eyebrow: string;
	prompt: string;
	time_limit_seconds: number;
	finding_choices: EducationFindingChoice[];
	requirements: string[];
	scoring: {
		localization: number;
		measurement: number;
		finding: number;
		impression: number;
		time: "tie_break";
	};
};

export type EducationAttempt = {
	attempt_id: string;
	attempt_key: string;
	challenge_id: string;
	started_at: string;
	deadline_at: string;
	delete_at: string;
	status: "active";
};

export type EducationScoreComponent = {
	points: number;
	max_points: number;
	[key: string]: unknown;
};

export type EducationResult = {
	attempt_id: string;
	challenge_id: string;
	status: "graded" | "provisional";
	submitted_at: string;
	elapsed_seconds: number;
	objective_points: number;
	total_points: number | null;
	max_points: number;
	scores: {
		localization: EducationScoreComponent & { distance_mm: number | null; inside_lesion: boolean };
		measurement: EducationScoreComponent & { measured_mm: number | null; reference_mm: number; error_percent: number | null };
		finding: EducationScoreComponent & { selected: string; correct: string };
	};
	ai_grade: {
		status: "graded" | "provisional";
		model: string;
		rubric_version: number;
		criteria: Record<"finding" | "location" | "evidence" | "impression", number> | null;
		points: number | null;
		max_points: number;
		feedback: string | null;
	};
	ground_truth: {
		correct_finding: string;
		correct_finding_label: string;
		segmentation_label: number;
		mesh_organ_id: number;
		location: string;
		reference_diameter_mm: number;
		reference_measurement_lps: number[][];
		teaching_points: string[];
	};
};

export type SoloChallengeController = {
	challenge: EducationChallenge;
	attempt: EducationAttempt;
	remainingSeconds: number;
	findingChoice: string;
	setFindingChoice: (value: string) => void;
	impression: string;
	setImpression: (value: string) => void;
	marker: [number, number, number] | null;
	setMarker: (value: [number, number, number] | null) => void;
	measurement: SharedMeasurement | null;
	setMeasurement: (value: SharedMeasurement | null) => void;
	result: EducationResult | null;
	maskUrl: string | null;
	submitting: boolean;
	retryingGrade: boolean;
	error: string | null;
	submit: (measurement: SharedMeasurement | null, timedOut?: boolean) => Promise<void>;
	retryGrade: () => Promise<void>;
	taskDockOpen: boolean;
	setTaskDockOpen: (value: boolean) => void;
	clearSession: () => void;
	// The submit window closed before an answer was accepted, so this attempt can
	// no longer be graded; the dock offers startOver instead of a dead Submit.
	deadlineMissed?: boolean;
	startOver?: () => void;
	// Why the answer overlay could not be loaded, kept apart from `error` (which
	// the results panel words as a grading problem).
	revealError?: string | null;
	// The tutor chat, held by the page so closing the Results panel keeps it.
	tutor?: SoloChallengeTutor;
};

export type SoloChallengeTutorMessage = { role: "student" | "tutor"; text: string };

export type SoloChallengeTutor = {
	question: string;
	setQuestion: (value: string) => void;
	messages: SoloChallengeTutorMessage[];
	setMessages: (update: (current: SoloChallengeTutorMessage[]) => SoloChallengeTutorMessage[]) => void;
	sending: boolean;
	setSending: (value: boolean) => void;
};

export type QuizPracticeChoice = { id: string; label: string };
export type QuizPracticeQuestion = {
	id: string;
	prompt: string;
	choices: QuizPracticeChoice[];
	viewer_cue?: {
		clear_overlays?: boolean;
		crosshair_lps?: [number, number, number];
	};
};

export type QuizPracticePack = {
	pack_id: string;
	version: number;
	case_id: string;
	title: string;
	difficulty: "easy" | "medium" | "hard";
	provenance: Record<string, unknown>;
	generator_version: string;
	validator_version: string;
	questions: QuizPracticeQuestion[];
};

export type QuizPracticeReveal = {
	question_id: string;
	correct_choice_id: string;
	explanation: string;
	source_label?: string;
	distribution: Record<string, number>;
	viewer_cue?: {
		show_lesion_overlay?: boolean;
		crosshair_lps?: [number, number, number];
		reference_measurement_lps?: [[number, number, number], [number, number, number]];
		reference_diameter_mm?: number;
		lesion_label?: number;
		mesh_organ_id?: number;
	};
};

export type QuizPracticeResult = {
	attempt_id: string;
	pack_id: string;
	pack_version: number;
	case_id: string;
	status: "completed";
	completed_at: string;
	score: number;
	max_score: number;
	answers: Record<string, string>;
	consistency: { status: "consistent" | "inconsistent" | "incomplete"; reasons: string[] };
	reveals: QuizPracticeReveal[];
};

export type QuizPracticeController = {
	pack: QuizPracticePack;
	questionIndex: number;
	answers: Record<string, string>;
	result: QuizPracticeResult | null;
	maskUrl: string | null;
	submitting: boolean;
	error: string | null;
	dockOpen: boolean;
	setDockOpen: (open: boolean) => void;
	selectAnswer: (choiceId: string) => void;
	previous: () => void;
	next: () => void;
	reportContent: (category: string) => Promise<void>;
	// Kept on the controller so they outlive the dock, which unmounts when closed.
	reportRecorded?: boolean;
	reportError?: string | null;
};
