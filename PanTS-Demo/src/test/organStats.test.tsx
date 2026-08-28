import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../contexts/authContext";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same WebGL/three.js mocks as the viewer smoke test — jsdom has no GPU, so the
// Niivue/Cornerstone/loader modules must be stubbed for the page to mount.
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
		// The page destructures { renderingEngine, viewportIds, volumeId } off the result,
		// so resolve that shape (not undefined) to avoid a post-test unhandled rejection.
		renderVisualization: vi.fn().mockResolvedValue({
			renderingEngine: {},
			viewportIds: [],
			volumeId: "test-volume",
		}),
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
		getCrosshairMm: vi.fn(() => null),
		getOrganCentroids: vi.fn(() => null),
		centerOnCursor: vi.fn(),
		setZoom: vi.fn(),
		zoomToFit: vi.fn(),
		zoomToCursor: vi.fn(),
		getMeasurementSummaries: vi.fn(() => []),
		subscribeToMeasurementChanges: vi.fn(() => () => {}),
		captureViewportImages: vi.fn(async () => []),
		renameMeasurement: vi.fn(),
		removeMeasurement: vi.fn(),
		jumpToMeasurement: vi.fn(() => null),
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
		hasSegmentationVolume: vi.fn(() => false),
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
vi.mock("../helpers/NiiVueNifti", () => ({
	create3DVolume: vi.fn().mockResolvedValue(undefined),
	moveNiiVueCrosshairToMm: vi.fn(),
	updateVisibilities: vi.fn(),
}));

import VisualizationPage from "../routes/VisualizationPage";
import { __resetOrganNormsCache } from "../helpers/organNorms";

// A tiny population reference: liver only, with a single M|60-69 bucket whose breakpoints
// make the assertions exact (grid 0/50/100 → volumes 1000/1500/2000).
const NORMS_FIXTURE = {
	version: 1,
	min_n: 1,
	percentile_grid: [0, 50, 100],
	organs: {
		liver: {
			"M|60-69": { n: 120, q: [1000, 1500, 2000] },
			"M|ALL": { n: 800, q: [950, 1480, 2100] },
			"ALL|ALL": { n: 1600, q: [800, 1400, 2200] },
		},
	},
};

// Per-case organ metrics, exactly the shape /api/mask-data returns. The liver gets a
// percentile; the spleen has no reference bucket; the kidney's volume is flagged invalid.
const MASK_DATA = {
	organ_metrics: [
		{ organ_name: "liver", volume_cm3: 1500, mean_hu: 52 },
		{ organ_name: "spleen", volume_cm3: 210, mean_hu: 48 },
		{ organ_name: "kidney_left", volume_cm3: 999999, mean_hu: 999999 },
	],
};

beforeEach(() => {
	__resetOrganNormsCache();
	// Route the mocked fetch by URL so the page exercises its real wiring:
	// mask-data → metrics, search → demographics, organ_norms.json → the reference.
	global.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const body = (data: unknown) => ({
			ok: true,
			status: 200,
			arrayBuffer: async () => new ArrayBuffer(0),
			blob: async () => new Blob(),
			json: async () => data,
			text: async () => "",
			headers: { get: () => "application/json" },
		});
		if (url.includes("/api/mask-data")) return body(MASK_DATA);
		if (url.includes("/api/search")) return body({ items: [{ sex: "M", age: 66 }] });
		if (url.includes("/organ_norms.json")) return body(NORMS_FIXTURE);
		return body({});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	// clearAllMocks (not restoreAllMocks) so the module mocks keep their resolved-value
	// implementations — the page's volume-load effect resolves asynchronously after the
	// test body, and would otherwise see an undefined result and throw post-teardown.
	vi.clearAllMocks();
});

const renderViewer = () =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={["/case/1"]}>
				<Routes>
					<Route path="/case/:caseId" element={<VisualizationPage />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

describe("Organ Statistics — population percentiles", () => {
	it("shows each organ's volume percentile vs the dataset for the case's sex/age", async () => {
		renderViewer();

		// The toolbar is visible by default; open Organ statistics (grouped under
		// the "Panels" dropdown alongside Organs/Case metadata/Measurements).
		fireEvent.click(screen.getByLabelText("Panels"));
		fireEvent.click(screen.getByRole("menuitem", { name: "Organ stats" }));

		// The %ile column header only appears once the norms asset has loaded.
		expect(await screen.findByText("%ile")).toBeTruthy();

		// liver 1500 cm³ in M|60-69 q=[1000,1500,2000] → exactly p50.
		const pct = await screen.findByText("p50");
		expect(pct).toBeTruthy();
		// Tooltip (on the cell wrapping the number + sparkline) names the comparison
		// group + sample size it fell back to.
		const cell = pct.closest("[title]");
		expect(cell?.getAttribute("title")).toContain("males 60–69");
		expect(cell?.getAttribute("title")).toContain("n=120");

		// The percentile sparkline renders next to the number…
		expect(screen.getByLabelText("Percentile 50 of 100")).toBeTruthy();
		// …and the CSV/JSON export buttons appear once there are rows.
		expect(screen.getByTitle("Download as CSV")).toBeTruthy();
		expect(screen.getByTitle("Download as JSON")).toBeTruthy();
	});

	it("falls back to an em dash when an organ has no reference or an invalid volume", async () => {
		renderViewer();
		// The toolbar is visible by default; open Organ statistics (grouped under
		// the "Panels" dropdown alongside Organs/Case metadata/Measurements).
		fireEvent.click(screen.getByLabelText("Panels"));
		fireEvent.click(screen.getByRole("menuitem", { name: "Organ stats" }));
		await screen.findByText("%ile");

		// spleen has no bucket and the kidney volume is flagged → two "—" cells.
		const dashes = await screen.findAllByText("—");
		expect(dashes.length).toBeGreaterThanOrEqual(2);
	});
});
