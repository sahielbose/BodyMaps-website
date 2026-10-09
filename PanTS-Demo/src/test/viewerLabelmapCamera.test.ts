/**
 * Cornerstone's labelmap render adds its actor asynchronously after checking the pane
 * has none, so overlapping renders stacked two to five copies per pane, and every add
 * re-seated the pane's camera by a slice index, which a full resolution room mask
 * over the fast preview CT turned into the first slice of the scan. addLabelmapActors
 * adds the actor once per pane itself, then puts the cameras back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const added = vi.hoisted(() => ({ calls: [] as Array<{ inputs: unknown[]; ids: string[] }>, onAdd: undefined as undefined | ((id: string) => void) }));
vi.mock("@cornerstonejs/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cornerstonejs/core")>()),
	addVolumesToViewports: vi.fn(async (_engine: unknown, inputs: unknown[], ids: string[]) => {
		added.calls.push({ inputs, ids });
		for (const id of ids) added.onAdd?.(id);
	}),
}));

import {
	addLabelmapActors,
	evenLabelmapOpacity,
	FILL_REFERENCE_SAMPLE_DISTANCE,
	keepingCameras,
	labelmapRepresentationUID,
} from "../helpers/viewer/labelmapActors";

type Camera = { focalPoint: number[]; position: number[] };
function fakePane(focalPoint: number[], position: number[]) {
	let camera: Camera = { focalPoint, position };
	const actors: Array<{ representationUID?: string }> = [{}];
	return {
		actors,
		getActors: () => actors,
		getCamera: () => camera,
		setCamera: vi.fn((next: Partial<Camera>) => {
			camera = { ...camera, ...next } as Camera;
		}),
	};
}
function fakeEngine() {
	const panes = {
		ax: fakePane([0, -190, -371], [0, -190, -871]),
		sag: fakePane([0, -190, -371], [500, -190, -371]),
		cor: fakePane([0, -190, -371], [0, -690, -371]),
	};
	return { panes, getViewport: (id: string) => panes[id as keyof typeof panes] };
}
const IDS = ["ax", "sag", "cor"];

beforeEach(() => {
	added.calls = [];
	added.onAdd = undefined;
});

describe("addLabelmapActors", () => {
	it("adds the labelmap once per pane under the UID Cornerstone's render looks for", async () => {
		const engine = fakeEngine();
		added.onAdd = (id) => engine.panes[id as keyof typeof engine.panes].actors.push({ representationUID: labelmapRepresentationUID("seg") });
		await addLabelmapActors(engine as never, "seg", "seg-volume", IDS);

		expect(added.calls.map((c) => c.ids)).toEqual([["ax"], ["sag"], ["cor"]]);
		expect(added.calls[0].inputs).toEqual([expect.objectContaining({ volumeId: "seg-volume", representationUID: "seg-Labelmap", visibility: false })]);

		// A second call finds the actors and adds no copies.
		await addLabelmapActors(engine as never, "seg", "seg-volume", IDS);
		expect(added.calls).toHaveLength(3);
	});

	it("puts back a pane the add moved to the edge of the scan, and the ones the crosshairs tool recentred", async () => {
		const engine = fakeEngine();
		engine.panes.ax.setCamera({ focalPoint: [0, -190, -420], position: [0, -190, -920] });
		added.onAdd = (id) => {
			// What Viewport.addActors did: this pane re-seated by slice index, every pane reset.
			engine.panes.ax.setCamera({ focalPoint: [0, -190, -371], position: [0, -190, -871] });
			if (id === "cor") engine.panes.cor.setCamera({ focalPoint: [0, -293.7, -371], position: [0, -793.7, -371] });
		};
		await addLabelmapActors(engine as never, "seg", "seg", IDS);

		expect(engine.panes.cor.getCamera()).toEqual({ focalPoint: [0, -190, -371], position: [0, -690, -371] });
		expect(engine.panes.ax.getCamera().focalPoint).toEqual([0, -190, -420]);
	});
});

describe("keepingCameras", () => {
	it("does not keep a reference to the camera arrays it saved", async () => {
		const engine = fakeEngine();
		await keepingCameras(engine, IDS, async () => {
			engine.panes.sag.getCamera().focalPoint[0] = 99;
		});
		expect(engine.panes.sag.getCamera().focalPoint).toEqual([0, -190, -371]);
	});

	it("skips a pane that is not ready and still runs the work", async () => {
		const run = vi.fn(async () => "done");
		const result = await keepingCameras({ getViewport: () => { throw new Error("no viewport"); } }, IDS, run);
		expect(run).toHaveBeenCalledTimes(1);
		expect(result).toBe("done");
	});
});

// A labelmap actor as vtk.js exposes it: the property holds the opacity unit distance and the
// shared mapper the sample distance Cornerstone derived from the voxel spacing.
function fakeVolumeActor(sampleDistance: number) {
	let unit = 1;
	return {
		getUnit: () => unit,
		getProperty: () => ({ setScalarOpacityUnitDistance: vi.fn((_i: number, d: number) => (unit = d)) }),
		getMapper: () => ({ getSampleDistance: () => sampleDistance }),
	};
}
// What vtk.js draws for a fill alpha after its sample distance correction.
const drawnAlpha = (alpha: number, sampleDistance: number, unit: number) => 1 - (1 - alpha) ** (sampleDistance / unit);

describe("labelmap fill strength across grids (round 9: the fill faded by 43% on HD)", () => {
	it("draws a fill at the same strength on the preview grid and the full resolution grid", () => {
		const preview = fakeVolumeActor(0.6833); // 1.25 x 1.25 x 1.6 mm
		const hd = fakeVolumeActor(0.3417); // 0.625 x 0.625 x 0.8 mm
		// Before: a unit distance of 1 on both grids.
		expect(drawnAlpha(0.6, 0.3417, 1) / drawnAlpha(0.6, 0.6833, 1)).toBeCloseTo(0.578, 2);

		evenLabelmapOpacity(preview);
		evenLabelmapOpacity(hd);
		const onPreview = drawnAlpha(0.6, 0.6833, preview.getUnit());
		const onHd = drawnAlpha(0.6, 0.3417, hd.getUnit());
		expect(onHd).toBeCloseTo(onPreview, 6);
		// The preview keeps the strength the fill values were tuned at.
		expect(onPreview).toBeCloseTo(drawnAlpha(0.6, FILL_REFERENCE_SAMPLE_DISTANCE, 1), 3);
	});

	it("evens every labelmap addLabelmapActors adds, and one a pane already had", async () => {
		const engine = fakeEngine();
		const fresh = fakeVolumeActor(0.3417);
		added.onAdd = (id) => engine.panes[id as keyof typeof engine.panes].actors.push({ representationUID: labelmapRepresentationUID("seg"), actor: fresh } as never);
		const existing = fakeVolumeActor(0.3417);
		engine.panes.ax.actors.push({ representationUID: labelmapRepresentationUID("seg"), actor: existing } as never);

		await addLabelmapActors(engine as never, "seg", "seg", IDS);

		expect(added.calls.map((c) => c.ids)).toEqual([["sag"], ["cor"]]);
		expect(existing.getUnit()).toBeCloseTo(0.3417 / FILL_REFERENCE_SAMPLE_DISTANCE, 6);
		expect(fresh.getUnit()).toBeCloseTo(0.3417 / FILL_REFERENCE_SAMPLE_DISTANCE, 6);
	});

	it("leaves an actor without a usable sample distance alone", () => {
		const actor = fakeVolumeActor(0);
		evenLabelmapOpacity(actor);
		evenLabelmapOpacity(undefined);
		expect(actor.getUnit()).toBe(1);
	});
});

describe("the hidden labelmap actor", () => {
	it("relies on Cornerstone's colour pass to show it, so the pane never draws the uncoloured grey slab", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		// cwd is PanTS-Demo (see brand.test.ts).
		const display = readFileSync(
			resolve(process.cwd(), "node_modules/@cornerstonejs/tools/dist/esm/tools/displayTools/Labelmap/labelmapDisplay.js"),
			"utf8",
		);
		const colourPass = display.slice(display.indexOf("function _setLabelmapColorAndOpacity"));
		const setsTable = colourPass.indexOf("setRGBTransferFunction(0, cfun)");
		const showsActor = colourPass.indexOf("labelmapActor.setVisibility(visible)");
		expect(setsTable).toBeGreaterThan(-1);
		expect(showsActor).toBeGreaterThan(setsTable);
	});
});
