import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));

// The CT viewer relies on WebGL (Niivue + Cornerstone) and a three.js loader,
// none of which run under jsdom/CI (no GPU). Mock those modules so we can verify
// the page component itself mounts and wires up without crashing.
vi.mock("@niivue/niivue", () => ({
	Niivue: class {
		attachToCanvas() {}
		loadVolumes() {
			return Promise.resolve();
		}
		setSliceType() {}
		setInterpolation() {}
		drawScene() {}
	},
}));

vi.mock("../helpers/CornerstoneNifti2", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
	return {
		...actual,
		getOrganLabelOnClick: vi.fn(),
		getOrganLabelAtPoint: vi.fn(() => undefined),
		moveCornerstoneCrosshairToMm: vi.fn(),
		renderVisualization: vi.fn().mockImplementation(async () => ({
			renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() },
			viewportIds: [],
			volumeId: `test-volume-${++viewerVolumeSequence.value}`,
			dispose: viewerDispose,
		})),
		setFillOpacity: vi.fn(),
		setPaneSliceIndex: vi.fn(),
		subscribeToSliceChanges: vi.fn(() => () => {}),
		setOutlineOpacity: vi.fn(),
		setVisibilities: vi.fn(),
		subscribeToCrosshairChanges: vi.fn(),
		subscribeToVolumeProgress: vi.fn(() => () => {}),
		toggleCrosshairTool: vi.fn(),
		setActiveMeasurementTool: vi.fn(),
		clearMeasurements: vi.fn(),
		applyRemoteMeasurement: vi.fn(),
		removeRemoteMeasurement: vi.fn(),
		getCrosshairMm: vi.fn(() => null),
		getOrganCentroids: vi.fn(() => null),
		// Measurement inventory + reading-session capture APIs
		getMeasurementSummaries: vi.fn(() => []),
		subscribeToMeasurementChanges: vi.fn(() => () => {}),
		captureViewportImages: vi.fn(async () => []),
		renameMeasurement: vi.fn(),
		removeMeasurement: vi.fn(),
		jumpToMeasurement: vi.fn(() => null),
		// Zoom controls now live in the top toolbar (previously ZoomHandle)
		setZoom: vi.fn(),
		centerOnCursor: vi.fn(),
		zoomToFit: vi.fn(),
		zoomToCursor: vi.fn(),
		// Progressive full-res upgrade + shaded volume rendering (3D pane)
		upgradeCtVolume: vi.fn(async () => null),
		enableVolume3D: vi.fn(async () => false),
		disableVolume3D: vi.fn(),
		applyVolume3DPreset: vi.fn(),
		getCurrentVolumeModality: () => undefined,
		// Mask editing (brush/eraser + labelmap export)
		setActiveMaskEditTool: vi.fn(),
		setActiveEditSegment: vi.fn(),
		setMaskBrushSize: vi.fn(),
		undoMaskEdit: vi.fn(),
		redoMaskEdit: vi.fn(),
		getMaskEditHistoryState: vi.fn(() => ({ canUndo: false, canRedo: false })),
		subscribeToSegmentationEdits: vi.fn(() => () => {}),
		getEditedSegments: vi.fn(() => new Set()),
		getSegmentationExport: vi.fn(() => null),
		hasSegmentation: vi.fn(() => false),
		getPresentSegmentIndices: vi.fn(() => null),
		buildMaskFilter: vi.fn(() => () => true),
		setBrushMaskingScope: vi.fn(),
		// Cine playback + oblique-MPR reset
		startCine: vi.fn(() => false),
		stopCine: vi.fn(),
		setReferenceLinesEnabled: vi.fn(),
		flipPaneHorizontal: vi.fn(),
		rotatePane90Clockwise: vi.fn(),
		resetMprOrientation: vi.fn(),
	};
});

import { applyRemoteMeasurement, clearMeasurements, LENGTH_TOOL, renderVisualization } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";
import type { QuizPracticeController } from "../education/types";
import type { LiveRoomController } from "../liveRooms/types";

function quizController(maskUrl: string | null = null): QuizPracticeController {
	return {
		pack: {
			pack_id: "radworld-case-35-v1",
			version: 1,
			case_id: "35",
			title: "Case 35",
			difficulty: "easy",
			provenance: {},
			generator_version: "test",
			validator_version: "test",
			questions: [{ id: "organ", prompt: "Which organ?", choices: [] }],
		},
		questionIndex: 0,
		answers: {},
		result: null,
		maskUrl,
		submitting: false,
		error: null,
		dockOpen: false,
		setDockOpen: vi.fn(),
		selectAnswer: vi.fn(),
		previous: vi.fn(),
		next: vi.fn(),
		reportContent: vi.fn(async () => {}),
	};
}

function liveRoomController(maskUrl = "blob:mask-1"): LiveRoomController {
	const measurement = {
		id: "measurement-1",
		tool: LENGTH_TOOL,
		points: [[1, 2, 3], [4, 5, 6]],
		polyline: [],
		text: "5 mm",
		label: "Lesion",
		frame_of_reference: "frame-1",
		metadata: {},
	};
	return {
		metadata: {
			room_id: "room-1", case_id: "35", resolution: "low",
			created_at: "2026-08-17T00:00:00Z", expires_at: "2026-08-18T00:00:00Z",
			geometry_hash: "hash", dimensions: [4, 4, 2], latest_seq: 0, mode: "review",
		},
		roomKey: "secret",
		maskUrl,
		participantId: "self",
		name: "Viewer",
		connectionState: "connected",
		participants: [{ participant_id: "self", name: "Viewer", color: "#22d3ee", role: "reviewer" }],
		state: { measurements: { [measurement.id]: measurement }, notes: {}, chat: [] },
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
		sendDurable: vi.fn(async () => true), sendPresence: vi.fn(), sendView: vi.fn(), sendChat: vi.fn(async () => true),
		addNote: vi.fn(async () => true), deleteNote: vi.fn(async () => true), requestUndo: vi.fn(), follow: vi.fn(),
		stopFollowing: vi.fn(), copyShareLink: vi.fn(async () => {}), downloadExport: vi.fn(async () => {}),
		startQuiz: vi.fn(() => false), answerQuiz: vi.fn(() => false), closeQuiz: vi.fn(() => false),
		revealQuiz: vi.fn(() => false), advanceQuiz: vi.fn(() => false),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	viewerVolumeSequence.value = 0;
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
		viewportIds: [],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		arrayBuffer: async () => new ArrayBuffer(0),
		blob: async () => new Blob(),
		json: async () => ({}),
		text: async () => "",
		headers: { get: () => "application/json" },
	})) as unknown as typeof fetch;
});

describe("viewer smoke test", () => {
	it("VisualizationPage mounts for a dataset case without crashing", async () => {
		const { container, unmount } = render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		expect(container.firstChild).toBeTruthy();
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const options = vi.mocked(renderVisualization).mock.calls.at(-1)?.[7];
		expect(options?.resourceKey).toContain("get-main-nifti/1.nii.gz");
		expect(options?.signal?.aborted).toBe(false);
		unmount();
		expect(options?.signal?.aborted).toBe(true);
		expect(viewerDispose).toHaveBeenCalledOnce();
	});

	it("aborts an in-flight load and disposes its late result", async () => {
		const staleDispose = vi.fn();
		let resolveLoad!: (value: Awaited<ReturnType<typeof renderVisualization>>) => void;
		vi.mocked(renderVisualization).mockImplementationOnce(() => new Promise((resolve) => {
			resolveLoad = resolve;
		}));

		const { unmount } = render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const options = vi.mocked(renderVisualization).mock.calls.at(-1)?.[7];

		unmount();
		expect(options?.signal?.aborted).toBe(true);
		await act(async () => {
			resolveLoad({
				renderingEngine: {} as never,
				viewportIds: [],
				volumeId: "stale-volume",
				dispose: staleDispose,
			});
		});

		await waitFor(() => expect(staleDispose).toHaveBeenCalledOnce());
	});

	it("rehydrates authoritative live-room measurements after viewer replacement", async () => {
		const initialRoom = liveRoomController();
		const view = (room: LiveRoomController) => (
			<AuthProvider>
				<MemoryRouter>
					<VisualizationPage liveRoom={room} />
				</MemoryRouter>
			</AuthProvider>
		);
		const { rerender } = render(view(initialRoom));

		await waitFor(() => expect(applyRemoteMeasurement).toHaveBeenCalledWith(initialRoom.state.measurements["measurement-1"]));
		const initialRenderCount = vi.mocked(renderVisualization).mock.calls.length;
		const initialHydrationCount = vi.mocked(applyRemoteMeasurement).mock.calls.length;

		const replacementRoom = { ...initialRoom, maskUrl: "blob:mask-2" };
		rerender(view(replacementRoom));

		await waitFor(() => expect(vi.mocked(renderVisualization).mock.calls.length).toBeGreaterThan(initialRenderCount));
		await waitFor(() => expect(vi.mocked(applyRemoteMeasurement).mock.calls.length).toBeGreaterThan(initialHydrationCount));
		expect(applyRemoteMeasurement).toHaveBeenLastCalledWith(replacementRoom.state.measurements["measurement-1"]);
		expect(clearMeasurements).toHaveBeenCalled();
	});

	it("loads quiz-practice CT before reveal mask is available", async () => {
		const controller = quizController();

		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/learn/quiz/radworld-case-35-v1"]}>
					<VisualizationPage quizPractice={controller} />
				</MemoryRouter>
			</AuthProvider>
		);

		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(vi.mocked(renderVisualization).mock.calls.at(-1)?.[5]).toBeUndefined();
	});

	it("applies windowing to CT actor after reveal labelmap becomes default", async () => {
		const ctUpdateRange = vi.fn();
		const segmentationUpdateRange = vi.fn();
		const actor = (referencedId: string, updateRange: () => void) => ({
			referencedId,
			actor: {
				getProperty: () => ({
					getRGBTransferFunction: () => ({
						setMappingRange: vi.fn(),
						updateRange,
					}),
				}),
			},
		});
		const segmentationActor = actor("bodymaps-seg-test-g1", segmentationUpdateRange);
		const ctActor = actor("ct-volume", ctUpdateRange);
		const viewport = {
			getActors: () => [segmentationActor, ctActor],
			getDefaultActor: () => segmentationActor,
			render: vi.fn(),
		};
		vi.mocked(renderVisualization).mockResolvedValueOnce({
			renderingEngine: { render: vi.fn(), getViewport: () => viewport },
			viewportIds: ["viewport-1"],
			volumeId: "ct-volume",
			dispose: vi.fn(),
		} as never);

		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/learn/quiz/radworld-case-35-v1"]}>
					<VisualizationPage quizPractice={quizController("blob:reveal-mask")} />
				</MemoryRouter>
			</AuthProvider>
		);

		await waitFor(() => expect(ctUpdateRange).toHaveBeenCalled());
		expect(segmentationUpdateRange).not.toHaveBeenCalled();
	});
});
