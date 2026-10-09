/**
 * The axial slice bar is turned so slice 0 is at the top. Its Up and Page Up keys are
 * turned round with it, so the thumb moves the way the key points.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { axialSliceBarKeyStep } from "../helpers/viewer/sliceBarKeys";

const page = readFileSync(resolve(process.cwd(), "src/routes/VisualizationPage.tsx"), "utf8");

describe("axial slice bar keys", () => {
	it("steps towards the top on Up and towards the bottom on Down", () => {
		expect(axialSliceBarKeyStep("ArrowUp", 200)).toBe(-1);
		expect(axialSliceBarKeyStep("ArrowDown", 200)).toBe(1);
	});

	it("pages by a tenth of the scan, at least one slice", () => {
		expect(axialSliceBarKeyStep("PageUp", 200)).toBe(-20);
		expect(axialSliceBarKeyStep("PageDown", 200)).toBe(20);
		expect(axialSliceBarKeyStep("PageDown", 4)).toBe(1);
	});

	it("leaves Left, Right, Home, End and other keys to the range", () => {
		for (const key of ["ArrowLeft", "ArrowRight", "Home", "End", "Tab", "a"]) {
			expect(axialSliceBarKeyStep(key, 200)).toBeNull();
		}
	});

	it("is wired to the axial bar only and steps from the live slice", () => {
		const input = /<input\s+type="range"\s+className=\{`vp-slice-scrollbar[\s\S]*?\/>/.exec(page)?.[0] ?? "";
		expect(input).toMatch(/onKeyDown=\{pane === "axial" \? \(e\) => \{/);
		expect(input).toMatch(/axialSliceBarKeyStep\(e\.key, info\.total\)/);
		expect(input).toMatch(/e\.preventDefault\(\);\s*stepPaneSlice\(pane, step\);/);
	});
});
