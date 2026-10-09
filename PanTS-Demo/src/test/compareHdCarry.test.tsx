/**
 * ?hd=1 on the compare page opens the side-by-side viewer at full resolution, the viewer
 * reads both CTs without ?res=low, and its links back to the comparison keep ?hd=1.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";

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

import ComparePage from "../routes/ComparePage";
import CompareViewerPage from "../routes/CompareViewerPage";

const handle = () => ({
	setLinked: vi.fn(), setSyncCursor: vi.fn(), setSegVisible: vi.fn(), setSegOpacity: vi.fn(),
	setOrganVisibility: vi.fn(), applyWindow: vi.fn(), applyZoom: vi.fn(), centerCursor: vi.fn(),
	jumpToOrgan: vi.fn(), refit: vi.fn(), resetView: vi.fn(), setFocusedViewport: vi.fn(),
	setReferenceLines: vi.fn(), flipFocused: vi.fn(), rotateFocused90: vi.fn(), startCine: vi.fn(() => true),
	stopCine: vi.fn(), setActiveMeasurementTool: vi.fn(), clearMeasurements: vi.fn(),
	getMeasurementSummaries: vi.fn(() => []), renameMeasurement: vi.fn(), removeMeasurement: vi.fn(),
	jumpToMeasurement: vi.fn(), subscribeToMeasurementChanges: vi.fn(() => vi.fn()), destroy: vi.fn(),
});

beforeEach(() => {
	setupCompare.mockResolvedValue(handle());
	// Every HEAD probe finds the local CT; every JSON call gets an empty body.
	global.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		json: async () => ({}),
		text: async () => "",
		headers: { get: () => "application/json" },
	})) as unknown as typeof fetch;
});
afterEach(() => vi.clearAllMocks());

const renderAt = (path: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/compare" element={<ComparePage />} />
					<Route path="/compare-viewer" element={<CompareViewerPage />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

describe("compare at full resolution", () => {
	it("carries ?hd=1 from the compare page into the side-by-side viewer link", async () => {
		renderAt("/compare?a=7&b=23&hd=1");
		const link = await screen.findByRole("link", { name: /View images side by side/ });
		expect(link.getAttribute("href")).toBe("/compare-viewer?a=7&b=23&hd=1");
	});

	it("leaves the viewer link at the fast copies without ?hd=1", async () => {
		renderAt("/compare?a=7&b=23");
		const link = await screen.findByRole("link", { name: /View images side by side/ });
		expect(link.getAttribute("href")).toBe("/compare-viewer?a=7&b=23");
	});

	it("reads both CTs at full resolution and keeps ?hd=1 on the way back", async () => {
		renderAt("/compare-viewer?a=7&b=23&hd=1");
		await vi.waitFor(() => expect(setupCompare).toHaveBeenCalledTimes(1));
		const sources = setupCompare.mock.calls[0][1] as { ctA: string; ctB: string };
		expect(sources.ctA).toMatch(/\/api\/get-main-nifti\/7\.nii\.gz$/);
		expect(sources.ctB).toMatch(/\/api\/get-main-nifti\/23\.nii\.gz$/);
		const back = await screen.findByRole("link", { name: "Back to comparison" });
		expect(back.getAttribute("href")).toBe("/compare?a=7&b=23&hd=1");
	});

	it("reads the fast low-resolution copies without ?hd=1", async () => {
		renderAt("/compare-viewer?a=7&b=23");
		await vi.waitFor(() => expect(setupCompare).toHaveBeenCalledTimes(1));
		const sources = setupCompare.mock.calls[0][1] as { ctA: string; ctB: string };
		expect(sources.ctA).toMatch(/\/api\/get-main-nifti\/7\.nii\.gz\?res=low$/);
		const back = await screen.findByRole("link", { name: "Back to comparison" });
		expect(back.getAttribute("href")).toBe("/compare?a=7&b=23");
	});
});
