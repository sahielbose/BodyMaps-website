import { describe, expect, it } from "vitest";
import {
	fitAffine,
	fitCaseMapping,
	fitPerAxisLinear,
	mapByBounds,
	scrollDeltaToWorld,
	type ScrollInfo,
	type Vec3,
} from "../helpers/compareViewer";

// A known affine transform (rotation + anisotropic scale + translation) used to generate
// synthetic landmark pairs — if the fit is correct, applying it to a point NOT in the fit
// set should still land close to the point the same known transform would produce.
const applyKnownAffine = ([x, y, z]: Vec3): Vec3 => [
	1.2 * x - 0.3 * y + 5,
	0.3 * x + 0.9 * y + 2 * z - 10,
	0.5 * z + 20,
];

const LANDMARKS: Vec3[] = [
	[0, 0, 0],
	[10, 0, 0],
	[0, 10, 0],
	[0, 0, 10],
	[10, 10, 0],
	[5, -5, 15],
	[-8, 3, 7],
];

describe("fitAffine", () => {
	it("recovers a known affine transform from >=4 landmark pairs", () => {
		const pairs: [Vec3, Vec3][] = LANDMARKS.map((p) => [p, applyKnownAffine(p)]);
		const fit = fitAffine(pairs);
		expect(fit).not.toBeNull();

		// A point that was NOT part of the fit set — verifies the fit generalizes rather
		// than just interpolating the training points.
		const probe: Vec3 = [3, -2, 9];
		const expected = applyKnownAffine(probe);
		const actual = fit!(probe);
		for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
	});

	it("returns null with fewer than 4 pairs", () => {
		const pairs: [Vec3, Vec3][] = LANDMARKS.slice(0, 3).map((p) => [p, applyKnownAffine(p)]);
		expect(fitAffine(pairs)).toBeNull();
	});

	it("returns null for degenerate (collinear) landmarks", () => {
		const collinear: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]];
		const pairs: [Vec3, Vec3][] = collinear.map((p) => [p, applyKnownAffine(p)]);
		expect(fitAffine(pairs)).toBeNull();
	});
});

describe("fitPerAxisLinear", () => {
	it("recovers an independent per-axis scale + offset", () => {
		const scaleOffset = ([x, y, z]: Vec3): Vec3 => [2 * x + 1, -0.5 * y + 4, 3 * z - 7];
		const pts: Vec3[] = [[0, 0, 0], [1, 2, 3], [-4, 5, -6]];
		const pairs: [Vec3, Vec3][] = pts.map((p) => [p, scaleOffset(p)]);
		const fit = fitPerAxisLinear(pairs);
		expect(fit).not.toBeNull();

		const probe: Vec3 = [10, -10, 8];
		const expected = scaleOffset(probe);
		const actual = fit!(probe);
		for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
	});

	it("returns null with fewer than 2 pairs", () => {
		expect(fitPerAxisLinear([[[0, 0, 0], [1, 1, 1]]])).toBeNull();
	});

	it("returns null when an axis has no spread across landmarks", () => {
		// z is constant across every landmark — can't fit a slope for that axis.
		const pairs: [Vec3, Vec3][] = [
			[[0, 0, 5], [1, 1, 1]],
			[[1, 1, 5], [2, 2, 1]],
			[[2, 2, 5], [3, 3, 1]],
		];
		expect(fitPerAxisLinear(pairs)).toBeNull();
	});

	it("ignores a few far-off labels instead of letting them flatten the slope", () => {
		// The shape seen on cases 7 and 23: most organs follow z_B = 0.5 z_A + 20, but the
		// femurs and the bladder sit far below everything else in A's long scan and land
		// mid-scan in B. A least-squares line through all of them has a slope near 0.1.
		const inliers = [-341, -312, -300, -290, -282, -276, -270, -246, -227, -176, -142, -136];
		const pairs: [Vec3, Vec3][] = inliers.map((z, i) => [
			[i, 2 * i, z],
			[i + 1, 2 * i + 1, 0.5 * z + 20 + (i % 2 ? 1.5 : -1.5)],
		]);
		for (const [zA, zB] of [[-576, -140], [-568, -70], [-535, -120], [-521, -185]]) {
			pairs.push([[pairs.length, 3, zA], [pairs.length, 4, zB]]);
		}
		const zs = pairs.map(([a]) => a[2]);
		const mean = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / xs.length;
		const za = mean(zs), zb = mean(pairs.map(([, b]) => b[2]));
		const ols =
			pairs.reduce((acc, [a, b]) => acc + (a[2] - za) * (b[2] - zb), 0) /
			pairs.reduce((acc, [a]) => acc + (a[2] - za) ** 2, 0);
		expect(ols).toBeLessThan(0.15); // what the old least-squares fit produced

		const fit = fitPerAxisLinear(pairs)!;
		expect(fit).not.toBeNull();
		const slope = (fit([0, 0, -150])[2] - fit([0, 0, -250])[2]) / 100;
		expect(slope).toBeGreaterThan(0.45);
		expect(slope).toBeLessThan(0.55);
		expect(Math.abs(fit([0, 0, -200])[2] - -80)).toBeLessThan(2);

		// Fit the other way round, it is the exact inverse, so Link scroll doesn't jump when
		// the person switches from scrolling A to scrolling B.
		const back = fitPerAxisLinear(pairs.map(([a, b]) => [b, a] as [Vec3, Vec3]))!;
		for (const p of [[3, -7, -300], [0, 12, -150]] as Vec3[]) {
			const round = back(fit(p));
			for (let i = 0; i < 3; i++) expect(round[i]).toBeCloseTo(p[i], 6);
		}
	});

	it("still fits exactly with only two landmarks", () => {
		const fit = fitPerAxisLinear([
			[[0, 0, 0], [1, 2, 3]],
			[[10, 10, 10], [21, -8, 18]],
		])!;
		expect(fit([5, 5, 5])).toEqual([11, -3, 10.5]);
	});
});

describe("fitCaseMapping", () => {
	it("prefers the full affine fit when there are enough landmarks", () => {
		const pairs: [Vec3, Vec3][] = LANDMARKS.map((p) => [p, applyKnownAffine(p)]);
		const fit = fitCaseMapping(pairs);
		expect(fit).not.toBeNull();
		const probe: Vec3 = [1, 1, 1];
		const expected = applyKnownAffine(probe);
		const actual = fit!(probe);
		for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 6);
	});

	it("falls back to the per-axis linear fit with only 2-3 landmarks", () => {
		const scaleOffset = ([x, y, z]: Vec3): Vec3 => [2 * x, 2 * y, 2 * z];
		const pts: Vec3[] = [[0, 0, 0], [1, 1, 1], [2, 3, 4]];
		const pairs: [Vec3, Vec3][] = pts.map((p) => [p, scaleOffset(p)]);
		const fit = fitCaseMapping(pairs);
		expect(fit).not.toBeNull();
		expect(fit!([5, 5, 5])).toEqual([10, 10, 10]);
	});

	it("returns null when there's nothing reliable to fit (e.g. no shared organs)", () => {
		expect(fitCaseMapping([])).toBeNull();
		expect(fitCaseMapping([[[0, 0, 0], [1, 1, 1]]])).toBeNull();
	});
});

// Cornerstone's scroll convention, as getVolumeViewportScrollInfo and snapFocalPointToSlice
// work it out for one axis-aligned volume: steps count from the min end of the volume along
// the camera's viewPlaneNormal, whichever way the volume stores its slices.
type FakeVolume = { origin: number; spacing: number; slices: number }; // world z of slice k = origin + k*spacing
const zRange = (v: FakeVolume) => {
	const a = v.origin, b = v.origin + (v.slices - 1) * v.spacing;
	return [Math.min(a, b), Math.max(a, b)];
};
const scrollInfo = (v: FakeVolume, focalZ: number, nz: 1 | -1): ScrollInfo => {
	const [lo, hi] = zRange(v);
	const min = Math.min(lo * nz, hi * nz), max = Math.max(lo * nz, hi * nz);
	const sp = Math.abs(v.spacing);
	const numScrollSteps = Math.round((max - min) / sp);
	return {
		numScrollSteps,
		currentStepIndex: Math.round(((focalZ * nz - min) / (max - min)) * numScrollSteps),
		sliceRangeInfo: { sliceRange: { min, max }, spacingInNormalDirection: sp, camera: { viewPlaneNormal: [0, 0, nz] } },
	};
};
// What scroll(delta) does to the focal point.
const scrollFocalZ = (v: FakeVolume, focalZ: number, nz: 1 | -1, delta: number) => {
	const info = scrollInfo(v, focalZ, nz);
	const { min, max } = info.sliceRangeInfo.sliceRange;
	const sp = Math.abs(v.spacing);
	const floating = ((focalZ * nz - min) / (max - min)) * info.numScrollSteps;
	const frame = Math.max(0, Math.min(info.numScrollSteps, Math.round(floating) + delta));
	return focalZ + nz * (frame - floating) * sp;
};

describe("scrollDeltaToWorld", () => {
	const vol: FakeVolume = { origin: -300, spacing: 1.5, slices: 101 }; // z from -300 to -150
	const axial = (focalZ: number) => scrollInfo(vol, focalZ, -1);

	it("counts steps toward the feet as positive for an axial normal of [0,0,-1]", () => {
		expect(scrollDeltaToWorld(axial(-210), [0, 0, -213])).toBe(2); // 3 mm inferior
		expect(scrollDeltaToWorld(axial(-210), [0, 0, -207])).toBe(-2); // 3 mm superior
		expect(scrollDeltaToWorld(axial(-210), [0, 0, -210.5])).toBe(0); // under half a slice
	});

	it("counts the other way on a flipped pane, whose normal is [0,0,1]", () => {
		const flipped = scrollInfo(vol, -210, 1);
		expect(scrollDeltaToWorld(flipped, [0, 0, -213])).toBe(-2);
		expect(scrollDeltaToWorld(flipped, [0, 0, -207])).toBe(2);
	});

	it("ignores the in-plane position", () => {
		expect(scrollDeltaToWorld(axial(-210), [500, -500, -213])).toBe(2);
	});

	it("clamps the target to the first and last slice", () => {
		const atTop = axial(-150); // most superior slice: step 0
		expect(atTop.currentStepIndex).toBe(0);
		expect(scrollDeltaToWorld(atTop, [0, 0, 400])).toBe(0);
		expect(scrollDeltaToWorld(atTop, [0, 0, -9999])).toBe(100);
		expect(scrollDeltaToWorld(axial(-300), [0, 0, -9999])).toBe(0);
	});

	it("works for sagittal [1,0,0] and coronal [0,-1,0] normals", () => {
		const along = (n: Vec3): ScrollInfo => ({
			numScrollSteps: 100,
			currentStepIndex: 50,
			sliceRangeInfo: { sliceRange: { min: -100, max: 100 }, spacingInNormalDirection: 2, camera: { viewPlaneNormal: n } },
		});
		expect(scrollDeltaToWorld(along([1, 0, 0]), [10, 99, 99])).toBe(5);
		// Coronal: the projection on [0,-1,0] is -y, so +10 mm in y is 5 steps back.
		expect(scrollDeltaToWorld(along([0, -1, 0]), [99, 10, 99])).toBe(-5);
	});

	it("does nothing when the spacing is not a positive number", () => {
		for (const sp of [0, -1, Number.NaN]) {
			const info = axial(-210);
			info.sliceRangeInfo.spacingInNormalDirection = sp;
			expect(scrollDeltaToWorld(info, [0, 0, -240])).toBe(0);
		}
	});
});

describe("Link scroll depth mapping and storage order", () => {
	// Source moves 15 mm toward the feet; the fitted depth map is z_B = 1.1 z_A + 5.
	const mapZ = (z: number) => 1.1 * z + 5;
	const srcBefore = -120, srcAfter = -135;
	// Case 2 stores slices feet to head (+z), case 23 head to feet (-z).
	const case2: FakeVolume = { origin: -300, spacing: 1.5, slices: 180 };
	const case23: FakeVolume = { origin: 0, spacing: -0.8, slices: 192 };

	const follow = (v: FakeVolume, nz: 1 | -1) => {
		let focal = scrollFocalZ(v, mapZ(srcBefore), nz, 0);
		focal = scrollFocalZ(v, focal, nz, scrollDeltaToWorld(scrollInfo(v, focal, nz), [0, 0, mapZ(srcBefore)]));
		const before = focal;
		const after = scrollFocalZ(v, focal, nz, scrollDeltaToWorld(scrollInfo(v, focal, nz), [0, 0, mapZ(srcAfter)]));
		return { before, after };
	};

	for (const [name, vol] of [["feet to head (case 2)", case2], ["head to feet (case 23)", case23]] as const) {
		for (const nz of [-1, 1] as const) {
			it(`moves a ${name} destination toward the feet too${nz === 1 ? " when it is flipped" : ""}`, () => {
				const { before, after } = follow(vol, nz);
				expect(after).toBeLessThan(before);
				expect(Math.abs(after - mapZ(srcAfter))).toBeLessThanOrEqual(Math.abs(vol.spacing) / 2 + 1e-9);
			});
		}
	}

	it("documents the old storage-index formula moving a feet-to-head destination the wrong way", () => {
		// Old code: target = round(storage k of the mapped z), delta = target - getSliceIndex().
		const oldDelta = (v: FakeVolume, focal: number, z: number) =>
			Math.round((z - v.origin) / v.spacing) - scrollInfo(v, focal, -1).currentStepIndex;
		const step = (focal: number, srcZ: number) => scrollFocalZ(case2, focal, -1, oldDelta(case2, focal, mapZ(srcZ)));
		const start = step(scrollFocalZ(case2, mapZ(srcBefore), -1, 0), srcBefore);
		expect(Math.abs(start - mapZ(srcBefore))).toBeGreaterThan(20); // first jump lands mirrored
		const after = step(start, srcAfter);
		expect(after).toBeGreaterThan(start); // the source went toward the feet, this went up
	});
});

describe("mapByBounds", () => {
	it("maps the +x/+y/+z end of one volume to the +x/+y/+z end of the other", () => {
		const src = [-100, 100, -50, 150, -300, -100];
		const dst = [10, 210, -400, -200, 0, 160];
		expect(mapByBounds([100, 150, -100], src, dst)).toEqual([210, -200, 160]);
		expect(mapByBounds([-100, -50, -300], src, dst)).toEqual([10, -400, 0]);
		expect(mapByBounds([0, 50, -200], src, dst)).toEqual([110, -300, 80]);
	});

	it("clamps points outside the source volume and copes with a flat axis", () => {
		expect(mapByBounds([999, -999, 5], [0, 10, 0, 10, 5, 5], [0, 20, 0, 20, 7, 7])).toEqual([20, 0, 7]);
	});
});
