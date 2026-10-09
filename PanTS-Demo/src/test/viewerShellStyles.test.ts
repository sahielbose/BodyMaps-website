/**
 * Case viewer styles that a keyboard or low-vision user depends on: every
 * focusable pane control shows where focus is, and small text clears 4.5:1
 * on the dark surfaces it sits on.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// cwd is PanTS-Demo (see brand.test.ts).
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const viewerCss = read("src/routes/VisualizationPage.css");
const indexCss = read("src/index.css");

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
/** `fg` at `alpha` over `bg`, as the browser paints it. */
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as Rgb;
const luminance = (rgb: Rgb) => {
	const [r, g, b] = rgb.map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};
const token = (css: string, name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(css)![1].trim();

// The viewer's dark surfaces: the page, flyouts, and the stats dock.
const PAGE = hex(token(indexCss, "--vp-bg"));
const FLYOUT = hex("#16181d");
const STATS_DOCK = over([14, 15, 18], 0.92, PAGE);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|}|\\*/)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
	if (!match) throw new Error(`no rule for ${selector}`);
	return match[1];
}

describe("slice scrollbar", () => {
	it("shows a focus ring for the keyboard, like the caption next to it", () => {
		expect(rule(viewerCss, ".vp-slice-scrollbar:focus-visible")).toMatch(/outline:\s*2px solid var\(--vp-accent\)/);
	});
});

describe("slice scrollbar placement", () => {
	// The bar is a range input rotated -90deg about its centre, so its visual
	// right edge sits at pane - right - length / 2 + 3 (half the 6px track).
	const px = (expr: string, pane: number) => {
		const length = Math.min(0.55 * pane, 200);
		const js = expr
			.replace(/min\(55%,\s*200px\)/g, String(length))
			.replace(/calc\(/g, "(")
			.replace(/px/g, "");
		return Function(`"use strict"; return (${js});`)() as number;
	};
	const decls = rule(viewerCss, ".vp-slice-scrollbar");
	const right = /(?:^|;)\s*right:\s*([^;]+);/.exec(decls)![1];
	const width = /(?:^|;)\s*width:\s*([^;]+);/.exec(decls)![1];

	it.each([187, 260, 400, 900])("stays 8px inside a %ipx pane", (pane) => {
		const length = px(width, pane);
		const visualRight = pane - px(right, pane) - length / 2 + 3;
		expect(visualRight).toBeCloseTo(pane - 8, 5);
	});
});

describe("flagged organ stats", () => {
	const accent = hex(token(indexCss, "--vp-accent"));

	it("use the viewer's dark-surface blue everywhere they are highlighted", () => {
		expect(rule(viewerCss, ".vp-stats__summary strong")).toMatch(/color:\s*var\(--vp-accent\)/);
		expect(rule(viewerCss, ".vp-stats__pct--flag")).toMatch(/color:\s*var\(--vp-accent\)/);
		expect(rule(viewerCss, ".vp-spark__marker--flag")).toMatch(/background:\s*var\(--vp-accent\)/);
	});

	it("read at 4.5:1 or better on the dock and on the amber summary banner", () => {
		const banner = over([255, 180, 84], 0.1, STATS_DOCK);
		expect(contrast(accent, STATS_DOCK)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(accent, banner)).toBeGreaterThanOrEqual(4.5);
	});
});

describe("faint viewer text", () => {
	const alpha = (css: string) => Number(/rgba\(255, 255, 255, ([\d.]+)\)/.exec(token(css, "--vp-text-faint"))![1]);
	const WHITE: Rgb = [255, 255, 255];
	const surfaces: Record<string, Rgb> = {
		page: PAGE,
		panel: over(WHITE, 0.045, PAGE),
		flyout: FLYOUT,
		"hovered flyout row": over(WHITE, 0.1, FLYOUT),
		"stats dock": STATS_DOCK,
	};

	it.each(Object.keys(surfaces))("reads at 4.5:1 or better on the %s", (name) => {
		const bg = surfaces[name];
		expect(contrast(over(WHITE, alpha(indexCss), bg), bg)).toBeGreaterThanOrEqual(4.5);
	});

	it("is the same in the compare viewer, which redeclares the tokens", () => {
		expect(alpha(read("src/routes/CompareViewerPage.css"))).toBe(alpha(indexCss));
	});
});

describe("dim viewer text", () => {
	const alphaOf = (css: string, name: string) => Number(/rgba\(255, 255, 255, ([\d.]+)\)/.exec(token(css, name))![1]);

	it.each([
		["the case viewer", indexCss],
		["the compare viewer", read("src/routes/CompareViewerPage.css")],
	])("sits between body and faint text in %s", (_, css) => {
		const dim = alphaOf(css, "--vp-text-dim");
		expect(dim).toBeGreaterThan(alphaOf(css, "--vp-text-faint"));
		expect(dim).toBeLessThan(alphaOf(css, "--vp-text"));
	});
});
