/**
 * Viewer: the 3D Volume presets follow the scan on screen. The page is reused across
 * routes, so a CT case opened after an MR scan gets the CT presets back instead of
 * keeping MR transfer functions on CT data.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { beforeEach, describe, expect, it, vi } from "vitest";

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));

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
		// The organ map has finished loading, so a missing organ is really missing.
		isSegmentationComplete: vi.fn(() => true),
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
		// Zoom controls in the top toolbar
		setZoom: vi.fn(),
		centerOnCursor: vi.fn(),
		zoomToFit: vi.fn(),
		zoomToCursor: vi.fn(),
		// Progressive full-res upgrade + shaded volume rendering (3D pane)
		upgradeCtVolume: vi.fn(async () => null),
		enableVolume3D: vi.fn(async () => true),
		disableVolume3D: vi.fn(),
		applyVolume3DPreset: vi.fn(),
		getCurrentVolumeModality: vi.fn(() => undefined),
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
		startCine: vi.fn(() => true),
		stopCine: vi.fn(),
		setReferenceLinesEnabled: vi.fn(),
		flipPaneHorizontal: vi.fn(),
		rotatePane90Clockwise: vi.fn(),
		resetMprOrientation: vi.fn(),
	};
});

// The mesh scene is not under test: a stand-in that shows what the page hands it.
vi.mock("../components/viewer/MeshViewer", () => ({
	fetchMeshManifest: vi.fn(),
	SegmentationMeshViewer: (props: { crosshairMm: unknown }) => (
		<div data-testid="mesh" data-crosshair={JSON.stringify(props.crosshairMm)} />
	),
}));

// A local NIfTI arrives as a blob: URL over the decompressed file.
vi.mock("../helpers/localNifti", () => ({
	loadLocalNiftiAsRawBlobUrl: vi.fn(async () => "blob:local-ct"),
	getLocalNiftiFile: vi.fn(() => null),
	setLocalNiftiFile: vi.fn(),
}));

import { getCurrentVolumeModality, renderVisualization } from "../helpers/CornerstoneNifti2";
import VisualizationPage from "../routes/VisualizationPage";

function stubFetch() {
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		arrayBuffer: async () => new ArrayBuffer(0),
		blob: async () => new Blob(),
		json: async () => ({}),
		text: async () => "",
		headers: { get: () => "application/json" },
	})) as unknown as typeof fetch;
}

let navigateTo: (path: string) => void = () => {};
function NavigateHook() {
	const navigate = useNavigate();
	useEffect(() => {
		navigateTo = navigate;
	}, [navigate]);
	return null;
}

// One unkeyed route element, as in App.tsx, so moving between cases reuses the page.
function renderViewer(path: string) {
	return render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<NavigateHook />
				<Routes>
					<Route path="/case/:caseId" element={<VisualizationPage />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);
}

const presetLabels = () =>
	within(screen.getByRole("group", { name: "Volume preset" }))
		.getAllByRole("button")
		.map((b) => b.textContent);

beforeEach(() => {
	vi.clearAllMocks();
	viewerVolumeSequence.value = 0;
	stubFetch();
	vi.mocked(renderVisualization).mockImplementation(async () => ({
		renderingEngine: {
			resize: vi.fn(),
			render: vi.fn(),
			getViewport: vi.fn(() => ({
				resetCamera: vi.fn(),
				element: { clientWidth: 100, clientHeight: 100 },
				getActors: () => [],
				getDefaultActor: () => undefined,
			})),
		} as never,
		viewportIds: ["axial"],
		volumeId: `test-volume-${++viewerVolumeSequence.value}`,
		dispose: viewerDispose,
	}));
});

describe("3D volume presets across loads", () => {
	it("offers the MR presets for an MR scan and the CT presets again for the next CT case", async () => {
		vi.mocked(getCurrentVolumeModality).mockReturnValue("MR");
		renderViewer("/case/1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalledTimes(1));
		fireEvent.click(await screen.findByRole("button", { name: "Volume" }));
		await waitFor(() => expect(presetLabels()).toEqual(["Default", "Angio", "MIP", "T2 brain"]));
		expect(screen.getByRole("button", { name: "Default", pressed: true })).toBeInTheDocument();

		vi.mocked(getCurrentVolumeModality).mockReturnValue("CT");
		await act(async () => navigateTo("/case/2"));
		await waitFor(() => expect(renderVisualization).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(presetLabels()).toEqual(["Bone", "Contrast + bone", "Enhanced organs", "Lung", "Skin", "MIP"])
		);
		expect(screen.getByRole("button", { name: "Bone", pressed: true })).toBeInTheDocument();
	});

	it("keeps the chosen preset when the next load uses the same list", async () => {
		vi.mocked(getCurrentVolumeModality).mockReturnValue("CT");
		renderViewer("/case/1");
		await waitFor(() => expect(renderVisualization).toHaveBeenCalledTimes(1));
		fireEvent.click(await screen.findByRole("button", { name: "Volume" }));
		fireEvent.click(await screen.findByRole("button", { name: "MIP" }));
		await act(async () => navigateTo("/case/2"));
		await waitFor(() => expect(renderVisualization).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(screen.getByRole("button", { name: "MIP", pressed: true })).toBeInTheDocument());
	});
});
