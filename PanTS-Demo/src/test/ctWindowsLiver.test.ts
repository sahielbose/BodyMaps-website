/**
 * The Liver window shows liver as grey. Its level is in HU (the Brightness slider shows
 * it negated), and upstream's level of -50 turned 70 to 99.9 percent of the liver white
 * on the local PanTS cases. The viewer, the compare viewer and the assistant all use it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CT_WINDOWS } from "../helpers/ctWindows";

describe("Liver CT window", () => {
	it("spans liver from non-contrast to portal venous without clipping either end", () => {
		const { width, center } = CT_WINDOWS.liver;
		// Liver medians on the local PanTS cases run from 38 HU to 111 HU.
		expect(center - width / 2).toBeLessThanOrEqual(38);
		expect(center + width / 2).toBeGreaterThanOrEqual(111);
		expect(center).toBeGreaterThanOrEqual(30);
		expect(center).toBeLessThanOrEqual(90);
	});

	it.each([
		"routes/VisualizationPage.tsx",
		"routes/CompareViewerPage.tsx",
		"components/AIAssistant/assistantActions.ts",
	])("%s takes its Liver window from the shared constant", (file) => {
		const source = readFileSync(resolve(process.cwd(), "src", file), "utf8");
		expect(source).toMatch(/CT_WINDOWS\.liver/);
		expect(source).not.toMatch(/center:\s*-50/);
	});
});
