/**
 * The lasso overlay: once the cursor can close the shape, a halo around the
 * start point pulses in radius as well as opacity, and there is one overlay
 * component to tune that on.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import LiveWireOverlay from "../components/viewer/LiveWireOverlay";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

// The value each keyframe of `name` gives `prop`, as the stylesheet parsed it.
function keyframeValues(cssText: string, name: string, prop: string): string[] {
	const style = document.createElement("style");
	style.textContent = cssText;
	document.head.appendChild(style);
	const keyframes = Array.from(style.sheet!.cssRules).find(
		(rule): rule is CSSKeyframesRule => (rule as CSSKeyframesRule).name === name,
	);
	const values = Array.from(keyframes?.cssRules ?? []).map((rule) => (rule as CSSKeyframeRule).style.getPropertyValue(prop));
	style.remove();
	return values.filter(Boolean);
}

describe("lasso close halo", () => {
	it("goes on the start point once the cursor is close enough to close", () => {
		const { container } = render(
			<LiveWireOverlay
				pane="axial"
				anchorPointsCanvas={[[0, 0], [10, 0], [10, 10]]}
				cornerPointsCanvas={[[0, 0], [10, 0], [10, 10]]}
				livePreviewPath={null}
				nearClose
			/>,
		);
		expect(container.querySelector("circle.vp-livewire-close-pulse")).toHaveAttribute("cx", "0");
	});

	it("pulses its radius with lengths, since a stylesheet drops a unitless r", () => {
		const radii = keyframeValues(read("src/components/viewer/AnnotationToolbar.css"), "vp-livewire-pulse", "r");
		expect(radii.length).toBeGreaterThan(0);
		for (const r of radii) expect(r).toMatch(/^\d+(\.\d+)?px$/);
		expect(new Set(radii).size).toBeGreaterThan(1);
	});
});

describe("lasso overlay component", () => {
	it("exists once, in components/viewer, so its motion is tuned in the copy the viewer renders", () => {
		const copies = readdirSync(resolve(process.cwd(), "src"), { recursive: true, encoding: "utf8" })
			.filter((file) => /^LiveWireOverlay\.[jt]sx?$/.test(basename(file)));
		expect(copies).toEqual(["components/viewer/LiveWireOverlay.tsx"]);
	});
});
