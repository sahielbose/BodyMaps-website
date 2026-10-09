/**
 * The 3D pane's volume presets show what their labels say on PanTS abdominal CT, and
 * MIP is a real maximum intensity projection rather than a composite render.
 */
import { CONSTANTS, Enums } from "@cornerstonejs/core";
import { describe, expect, it, vi } from "vitest";
import {
	applyVolume3DBlend,
	VOLUME_3D_PRESETS,
	VOLUME_3D_PRESETS_MR,
	volume3DBlendFor,
	volume3DPresetsForModality,
} from "./volume3DPresets";

const stockPreset = (name: string) => CONSTANTS.VIEWPORT_PRESETS.find((p) => p.name === name);

// Piecewise-linear opacity at a given HU from a VTK scalarOpacity string
// ("count x0 y0 x1 y1 ...").
function opacityAt(scalarOpacity: string, hu: number): number {
	const nums = scalarOpacity.trim().split(/\s+/).map(Number).slice(1);
	const pts: [number, number][] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
	if (hu <= pts[0][0]) return pts[0][1];
	for (let i = 1; i < pts.length; i++) {
		const [x0, y0] = pts[i - 1];
		const [x1, y1] = pts[i];
		if (hu <= x1) return y0 + ((y1 - y0) * (hu - x0)) / (x1 - x0);
	}
	return pts[pts.length - 1][1];
}

describe("volume 3D presets", () => {
	it("names only presets Cornerstone ships, so none silently does nothing", () => {
		for (const preset of [...VOLUME_3D_PRESETS, ...VOLUME_3D_PRESETS_MR]) {
			expect(stockPreset(preset.name), preset.name).toBeDefined();
		}
	});

	it("Bone leaves muscle and organs clear and shows bone up to the PanTS ceiling", () => {
		const bone = VOLUME_3D_PRESETS.find((p) => p.label === "Bone");
		const opacity = stockPreset(bone!.name)!.scalarOpacity;
		expect(opacityAt(opacity, 60)).toBe(0);
		expect(opacityAt(opacity, 400)).toBeGreaterThan(0.1);
		expect(opacityAt(opacity, 999)).toBeGreaterThan(0.1);
	});

	it("labels the contrast preset as showing bone too, since HU alone cannot tell them apart", () => {
		const aaa = VOLUME_3D_PRESETS.find((p) => p.name === "CT-AAA");
		expect(aaa!.label).toMatch(/bone/i);
		expect(aaa!.label).not.toBe("Angio");
	});

	it("does not call the abdominal presets by chest or soft-tissue names they do not show", () => {
		const labels = VOLUME_3D_PRESETS.map((p) => p.label);
		expect(labels).not.toContain("Chest");
		expect(labels).not.toContain("Soft tissue");
		expect(VOLUME_3D_PRESETS.find((p) => p.name === "CT-Soft-Tissue")!.label).toBe("Skin");
	});

	it("blends MIP presets as a maximum intensity projection and the rest as composite", () => {
		expect(volume3DBlendFor("CT-MIP")).toBe("mip");
		expect(volume3DBlendFor("MR-MIP")).toBe("mip");
		for (const preset of [...VOLUME_3D_PRESETS, ...VOLUME_3D_PRESETS_MR]) {
			if (preset.name.endsWith("-MIP")) continue;
			expect(volume3DBlendFor(preset.name), preset.name).toBe("composite");
		}
		expect(volume3DBlendFor("not-a-preset")).toBe("composite");
	});

	it("sets the mapper's blend mode for MIP and back to composite when leaving it", () => {
		const setBlendMode = vi.fn();
		const viewport = { getDefaultActor: () => ({ actor: { getMapper: () => ({ setBlendMode }) } }) };
		applyVolume3DBlend(viewport, "CT-MIP", Enums.BlendModes);
		expect(setBlendMode).toHaveBeenLastCalledWith(Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
		applyVolume3DBlend(viewport, "CT-Bones", Enums.BlendModes);
		expect(setBlendMode).toHaveBeenLastCalledWith(Enums.BlendModes.COMPOSITE);
		applyVolume3DBlend(viewport, "MR-MIP", Enums.BlendModes);
		expect(setBlendMode).toHaveBeenLastCalledWith(Enums.BlendModes.MAXIMUM_INTENSITY_BLEND);
	});

	it("does not throw when the 3D viewport has no volume actor yet", () => {
		expect(() => applyVolume3DBlend({ getDefaultActor: () => undefined }, "CT-MIP", Enums.BlendModes)).not.toThrow();
		expect(() => applyVolume3DBlend(undefined, "CT-MIP", Enums.BlendModes)).not.toThrow();
	});

	it("offers the MR list only for MR and the CT list for everything else", () => {
		expect(volume3DPresetsForModality("MR")).toBe(VOLUME_3D_PRESETS_MR);
		expect(volume3DPresetsForModality("CT")).toBe(VOLUME_3D_PRESETS);
		expect(volume3DPresetsForModality(undefined)).toBe(VOLUME_3D_PRESETS);
	});
});
