/**
 * "Largest organ?" and "smallest organ?" used to POST /api/mask-data again,
 * which makes the server load the CT and every mask to recompute stats the
 * viewer had already loaded for its sidebar. They now answer from those.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildViewerActions } from "../components/AIAssistant/assistantActions";

const STATS = [
	{ organ_name: "liver", volume_cm3: 1500, mean_hu: 60 },
	{ organ_name: "spleen", volume_cm3: 200, mean_hu: 50 },
	{ organ_name: "gall_bladder", volume_cm3: 30, mean_hu: 10 },
];

function actions(getOrganStats?: () => typeof STATS | null, labels: string[] = []) {
	return buildViewerActions({
		checkBoxData: labels.map((label) => ({ label })) as never,
		setCheckState: vi.fn(),
		setOpacityValue: vi.fn(),
		handleWindowChange: vi.fn(),
		setViewModeFn: vi.fn(),
		setActiveMeasureToolFn: vi.fn(),
		caseId: "1",
		apiBase: "http://api.test",
		getOrganStats,
	});
}

afterEach(() => vi.unstubAllGlobals());

describe("assistant metric answers", () => {
	it("use the stats the viewer already loaded", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const viewer = actions(() => STATS);

		expect(await viewer.getLargestStructure()).toMatch(/\*\*liver\*\*/i);
		expect(await viewer.getSmallestStructure()).toMatch(/gall ?bladder/i);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("fetch them only when the viewer has none", async () => {
		const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ organ_metrics: STATS }), { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);
		const viewer = actions(() => null);

		expect(await viewer.getLargestStructure()).toMatch(/\*\*liver\*\*/i);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});

describe("assistant structure counts", () => {
	it("use the singular noun for a single structure", async () => {
		const viewer = actions(undefined, ["liver"]);
		expect(await viewer.getStructureCount()).toMatch(/\*\*1 segmented structure\*\*/);
		expect(await viewer.listStructures()).toMatch(/\*\*1 segmented structure\*\*/);
	});

	it("use the plural noun for several", async () => {
		const viewer = actions(undefined, ["liver", "spleen"]);
		expect(await viewer.getStructureCount()).toMatch(/\*\*2 segmented structures\*\*/);
		expect(await viewer.listStructures()).toMatch(/\*\*2 segmented structures\*\*/);
	});
});
