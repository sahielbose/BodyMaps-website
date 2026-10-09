import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";

// The dual viewer pulls the Cornerstone WebGL stack, which can't run under jsdom — mock
// the isolated setup helper so we can verify the page mounts + lays out two panes.
// vi.hoisted so the mock fn exists when the hoisted vi.mock factory runs.
const { setupCompare } = vi.hoisted(() => ({ setupCompare: vi.fn() }));
vi.mock("../helpers/compareViewer", () => ({
	setupCompare,
	getOrganLabelAtPoint: vi.fn(),
	VIEWPORT_IDS: {
		aAx: "cmp_a_ax", aSag: "cmp_a_sag", aCor: "cmp_a_cor",
		bAx: "cmp_b_ax", bSag: "cmp_b_sag", bCor: "cmp_b_cor",
	},
	LENGTH_TOOL: "Length",
	BIDIRECTIONAL_TOOL: "Bidirectional",
	ANGLE_TOOL: "Angle",
	PROBE_TOOL: "Probe",
	ROI_TOOL: "RectangleROI",
	ELLIPSE_TOOL: "EllipticalROI",
	FREEHAND_ROI_TOOL: "PlanarFreehandROI",
	ARROW_TOOL: "ArrowAnnotate",
	MAGNIFY_TOOL: "AdvancedMagnify",
}));

import CompareViewerPage from "../routes/CompareViewerPage";

beforeEach(() => {
	setupCompare.mockResolvedValue({
		setLinked: vi.fn(),
		setSyncCursor: vi.fn(),
		setSegVisible: vi.fn(),
		setSegOpacity: vi.fn(),
		setOrganVisibility: vi.fn(),
		applyWindow: vi.fn(),
		applyZoom: vi.fn(),
		centerCursor: vi.fn(),
		jumpToOrgan: vi.fn(),
		refit: vi.fn(),
		resetView: vi.fn(),
		setFocusedViewport: vi.fn(),
		setReferenceLines: vi.fn(),
		flipFocused: vi.fn(),
		rotateFocused90: vi.fn(),
		startCine: vi.fn(() => true),
		stopCine: vi.fn(),
		setActiveMeasurementTool: vi.fn(),
		clearMeasurements: vi.fn(),
		getMeasurementSummaries: vi.fn(() => []),
		renameMeasurement: vi.fn(),
		removeMeasurement: vi.fn(),
		jumpToMeasurement: vi.fn(),
		subscribeToMeasurementChanges: vi.fn(() => vi.fn()),
		destroy: vi.fn(),
	});
	// resolveCtUrl does a HEAD probe; return not-ok so it falls back to the HF url.
	global.fetch = vi.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
});
afterEach(() => vi.clearAllMocks());

// The missing-ids page carries the shared site header, which needs the auth context.
const renderAt = (path: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/compare-viewer" element={<CompareViewerPage />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

describe("CompareViewerPage", () => {
	it("mounts two labelled panes and calls setupCompare for two cases", async () => {
		renderAt("/compare-viewer?a=1&b=2");
		expect(await screen.findByText("Case 1")).toBeTruthy();
		expect(await screen.findByText("Case 2")).toBeTruthy();

		// The toolbar opens shown, like the single viewer's top toolbar: open the Sync flyout.
		fireEvent.click(await screen.findByRole("button", { name: /^sync$/i }));
		expect(screen.getByText(/Link scroll/i)).toBeTruthy();

		// The isolated Cornerstone setup is invoked once with both viewport elements.
		await vi.waitFor(() => expect(setupCompare).toHaveBeenCalledTimes(1));
	});

	it("explains a missing id in plain words, with a way to the dataset", async () => {
		renderAt("/compare-viewer");
		expect(await screen.findByRole("heading", { level: 1, name: "Choose two cases to compare" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
		expect(screen.getByRole("link", { name: "Open the compare page" })).toHaveAttribute("href", "/compare");
		expect(screen.queryByText(/compare-viewer\?a=/)).toBeNull();
		expect(setupCompare).not.toHaveBeenCalled();
	});

	it("keeps the one id it was given when sending the reader to the compare page", async () => {
		renderAt("/compare-viewer?a=7");
		expect(await screen.findByRole("link", { name: "Open the compare page" })).toHaveAttribute("href", "/compare?a=7");
		expect(setupCompare).not.toHaveBeenCalled();
	});

	it("ends a failed load in an error naming the case, with a way back (no endless spinner)", async () => {
		// What setupCompare throws when case A's CT answers 404.
		setupCompare.mockRejectedValueOnce(Object.assign(new Error("HTTP 404"), { which: "a" }));
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
		renderAt("/compare-viewer?a=99999999&b=2");

		expect(await screen.findByRole("alert")).toHaveTextContent("Case 99999999 couldn't be loaded.");
		expect(screen.queryByText(/Loading both cases/)).toBeNull();
		expect(screen.getByRole("link", { name: "Back to the comparison" })).toHaveAttribute(
			"href",
			"/compare?a=99999999&b=2"
		);
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
		errorLog.mockRestore();
	});
});
