import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { RECENT_UPLOADS_KEY } from "../helpers/recentUploads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

	it("gives the case one main landmark around the panes and a level 1 heading", async () => {
		const { container } = render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/17"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		const main = screen.getByRole("main");
		expect(main).toContainElement(container.querySelector(".vp-stage") as HTMLElement);
		expect(screen.getByRole("heading", { level: 1, name: "Case 17" })).toHaveClass("sr-only");
	});

	it("runs Brightness and Contrast the way their names say and announces the real level and width", async () => {
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "Adjust" }));

		const brightness = screen.getByRole("slider", { name: "Brightness" }) as HTMLInputElement;
		const contrast = screen.getByRole("slider", { name: "Contrast" }) as HTMLInputElement;
		expect(brightness).toHaveAttribute("aria-valuetext", "Window level 40 HU");
		expect(contrast).toHaveAttribute("aria-valuetext", "Window width 400 HU");

		// Right is more contrast: a narrower window.
		fireEvent.change(contrast, { target: { value: String(Number(contrast.value) + 200) } });
		expect(contrast).toHaveAttribute("aria-valuetext", "Window width 200 HU");

		// Right is brighter: a lower window level.
		fireEvent.change(brightness, { target: { value: String(Number(brightness.value) + 100) } });
		expect(brightness).toHaveAttribute("aria-valuetext", "Window level -60 HU");
	});

	it("names the CT window preset only while its window is the one applied", async () => {
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.getByRole("button", { name: "CT window preset: Soft tissue" })).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "CT window preset: Soft tissue" }));
		fireEvent.click(screen.getByRole("button", { name: "Lung" }));
		expect(screen.getByRole("button", { name: "CT window preset: Lung" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Lung" })).toHaveAttribute("aria-pressed", "true");

		// A Contrast drag leaves Lung's window, so the trigger stops calling it Lung.
		fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
		const contrast = screen.getByRole("slider", { name: "Contrast" }) as HTMLInputElement;
		fireEvent.change(contrast, { target: { value: String(Number(contrast.value) + 300) } });
		const trigger = screen.getByRole("button", { name: "CT window preset" });
		// The label's last span is the visible one; the others only size it.
		expect(trigger.querySelector(".vp-tb-mini__label > span:last-child")).toHaveTextContent(/^Window$/);
		expect(screen.queryByRole("button", { name: "CT window preset: Lung" })).toBeNull();
	});

	it("says a case has no metadata once the lookup comes back empty, not before", async () => {
		let answerSearch!: () => void;
		const search = new Promise<void>((resolve) => { answerSearch = resolve; });
		const plainFetch = global.fetch;
		global.fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
			if (String(url).includes("/api/search")) {
				await search;
				return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
			}
			return plainFetch(url, init);
		}) as typeof fetch;

		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/case/1"]}>
					<Routes>
						<Route path="/case/:caseId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		fireEvent.click(screen.getByRole("button", { name: "Panels" }));
		fireEvent.click(screen.getByRole("button", { name: "Case metadata" }));

		await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("/api/search")));
		expect(screen.getByText("Loading…")).toBeInTheDocument();
		expect(screen.queryByText("No metadata available for this case.")).toBeNull();

		await act(async () => answerSearch());
		expect(await screen.findByText("No metadata available for this case.")).toBeInTheDocument();
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
			// resize: the pane refit calls it on a later frame, after the test may have ended.
			renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: () => viewport },
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

describe("scan name in the viewer's top bar", () => {
	it("the rename field is named, like the Upload page's", async () => {
		localStorage.setItem(
			RECENT_UPLOADS_KEY,
			JSON.stringify([{ sessionId: "abc", label: "ePAI scan", model: "ePAI", status: "Completed", timestamp: Date.now() }]),
		);
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/session/abc"]}>
					<Routes>
						<Route path="/session/:sessionId" element={<VisualizationPage />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
		fireEvent.click(await screen.findByRole("button", { name: "Rename scan" }));
		const field = screen.getByRole("textbox", { name: "Scan name" });
		expect(field).toHaveFocus();
		expect(field).toHaveValue("ePAI scan");
		localStorage.clear();
	});

	// The saved names are one list per browser, each run stamped with the account
	// that started it. Opening a session's address as another account is possible
	// (browser history, a shared link), and must show neither its owner's name
	// for it nor a way to change it.
	describe("on a browser shared by two accounts", () => {
		const signedInAs = (id: string) => {
			global.fetch = vi.fn(async (url: RequestInfo | URL) => {
				const body = String(url).includes("/api/auth/me")
					? { user: { id, email: `${id}@example.com`, name: null, plan: "pro" } }
					: {};
				return {
					ok: true, status: 200, json: async () => body, text: async () => "",
					arrayBuffer: async () => new ArrayBuffer(0), blob: async () => new Blob(),
					headers: { get: () => "application/json" },
				};
			}) as unknown as typeof fetch;
		};
		const openSession = () =>
			render(
				<AuthProvider>
					<MemoryRouter initialEntries={["/session/abc"]}>
						<Routes>
							<Route path="/session/:sessionId" element={<VisualizationPage />} />
						</Routes>
					</MemoryRouter>
				</AuthProvider>
			);
		const saved = () => JSON.parse(localStorage.getItem(RECENT_UPLOADS_KEY) ?? "[]") as { label: string }[];
		const seed = () =>
			localStorage.setItem(
				RECENT_UPLOADS_KEY,
				JSON.stringify([{ sessionId: "abc", label: "One's scan", model: "ePAI", status: "Completed", timestamp: Date.now(), ownerId: "u1" }]),
			);
		afterEach(() => localStorage.clear());

		it("shows the account's own name for its scan, and renames it", async () => {
			seed();
			signedInAs("u1");
			openSession();

			fireEvent.click(await screen.findByRole("button", { name: "Rename scan" }));
			fireEvent.change(screen.getByRole("textbox", { name: "Scan name" }), { target: { value: "Renamed" } });
			fireEvent.keyDown(screen.getByRole("textbox", { name: "Scan name" }), { key: "Enter" });

			await waitFor(() => expect(saved()[0].label).toBe("Renamed"));
		});

		it("writes no rename once the run is no longer the account's (it changed hands in another tab)", async () => {
			seed();
			signedInAs("u1");
			openSession();
			fireEvent.click(await screen.findByRole("button", { name: "Rename scan" }));
			fireEvent.change(screen.getByRole("textbox", { name: "Scan name" }), { target: { value: "Renamed" } });

			localStorage.setItem(
				RECENT_UPLOADS_KEY,
				JSON.stringify([{ ...saved()[0], sessionId: "abc", ownerId: "u2" }]),
			);
			fireEvent.keyDown(screen.getByRole("textbox", { name: "Scan name" }), { key: "Enter" });

			await waitFor(() => expect(screen.queryByRole("textbox", { name: "Scan name" })).not.toBeInTheDocument());
			expect(saved()[0].label).toBe("One's scan");
		});

		it("takes up a scan saved before runs carried an owner when the server says it is the account's", async () => {
			localStorage.setItem(
				RECENT_UPLOADS_KEY,
				JSON.stringify([{ sessionId: "abc", label: "Earlier scan", model: "ePAI", status: "Completed", timestamp: Date.now() }]),
			);
			global.fetch = vi.fn(async (url: RequestInfo | URL) => {
				const u = String(url);
				const body = u.includes("/api/auth/me")
					? { user: { id: "u1", email: "u1@example.com", name: null, plan: "pro" } }
					: u.includes("/api/me/runs/owned")
						? { owned: ["abc"] }
						: {};
				return {
					ok: true, status: 200, json: async () => body, text: async () => "",
					arrayBuffer: async () => new ArrayBuffer(0), blob: async () => new Blob(),
					headers: { get: () => "application/json" },
				};
			}) as unknown as typeof fetch;
			openSession();

			// Opened straight from an address, with the Upload page never visited.
			fireEvent.click(await screen.findByRole("button", { name: "Rename scan" }));
			expect(screen.getByRole("textbox", { name: "Scan name" })).toHaveValue("Earlier scan");
			fireEvent.change(screen.getByRole("textbox", { name: "Scan name" }), { target: { value: "Renamed" } });
			fireEvent.keyDown(screen.getByRole("textbox", { name: "Scan name" }), { key: "Enter" });

			await waitFor(() => expect(saved()[0].label).toBe("Renamed"));
			expect((saved()[0] as { ownerId?: string }).ownerId).toBe("u1");
		});

		it("shows another account's scan under its address without that account's name, and cannot rename it", async () => {
			seed();
			signedInAs("u2");
			openSession();
			await waitFor(() => expect(vi.mocked(global.fetch).mock.calls.some(([u]) => String(u).includes("/api/auth/me"))).toBe(true));
			await new Promise((resolve) => setTimeout(resolve, 80));

			expect(screen.queryByText("One's scan")).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Rename scan" })).not.toBeInTheDocument();
			expect(saved()[0].label).toBe("One's scan");
		});
	});
});
