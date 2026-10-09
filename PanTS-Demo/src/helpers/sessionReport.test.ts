import { describe, expect, it } from "vitest";
import {
	buildReportHtml,
	buildReportMarkdown,
	condenseEvents,
	formatClock,
	summarizeTechnique,
	type ReportInput,
} from "./sessionReport";

const baseInput: ReportInput = {
	caseId: "42",
	startedAt: 1750000000000,
	durationMs: 219000,
	events: [
		{ t: 0, type: "session", detail: "Reading session started — narration recording" },
		{ t: 4000, type: "preset", detail: "Applied Lung window" },
		{ t: 5000, type: "navigate", detail: "Navigated to (1, 2, 3) mm" },
		{ t: 6000, type: "navigate", detail: "Navigated to (4, 5, 6) mm" },
		{ t: 9000, type: "view", detail: "Switched to sagittal view" },
		{ t: 12000, type: "measure", detail: "Distance measured: 23.1 mm" },
	],
	shots: [
		{
			t: 12100,
			label: "Distance — 23.1 mm",
			images: [{ name: "sagittal", dataUrl: "data:image/png;base64,AAAA" }],
		},
	],
	transcript: [{ t: 11000, text: "small lesion in the liver dome" }],
	measurements: [{ tool: "Length", label: "lesion", value: "23.1 mm" }],
};

describe("formatClock", () => {
	it("formats sub-hour times as MM:SS", () => {
		expect(formatClock(0)).toBe("00:00");
		expect(formatClock(83000)).toBe("01:23");
	});
	it("grows to H:MM:SS past an hour", () => {
		expect(formatClock(3661000)).toBe("1:01:01");
	});
});

describe("condenseEvents", () => {
	it("collapses same-type bursts, keeping the final detail", () => {
		const condensed = condenseEvents(baseInput.events);
		const navigate = condensed.find((e) => e.type === "navigate");
		expect(navigate?.count).toBe(2);
		expect(navigate?.detail).toBe("Navigated to (4, 5, 6) mm");
		// non-repeated events stay singular
		expect(condensed.filter((e) => e.type === "preset")[0].count).toBe(1);
	});
});

describe("summarizeTechnique", () => {
	it("derives views and presets actually used", () => {
		const lines = summarizeTechnique(baseInput.events);
		expect(lines.join("\n")).toContain("sagittal");
		expect(lines.join("\n")).toContain("Lung");
	});
});

describe("buildReportMarkdown", () => {
	it("includes dictation, measurements and timeline", () => {
		const md = buildReportMarkdown(baseInput);
		expect(md).toContain("# Draft reading report for case 42");
		expect(md).toContain("small lesion in the liver dome");
		expect(md).toContain("| 1 | Distance | lesion | 23.1 mm |");
		expect(md).toContain("Applied Lung window");
		expect(md).toContain("not medical advice");
	});
});

describe("report template copy", () => {
	// The fixture's own event and shot text is user data; strip it so only
	// the template's words are checked.
	const plain: ReportInput = {
		...baseInput,
		events: [{ t: 0, type: "session", detail: "Reading session started" }],
		shots: [],
		measurements: [{ tool: "Length", label: "", value: "12 mm" }],
	};

	it("uses no em dashes, even for a measurement with no label", () => {
		const md = buildReportMarkdown(plain);
		const html = buildReportHtml(plain);
		expect(md).not.toMatch(/\u2014/);
		expect(html).not.toMatch(/\u2014/);
		expect(md).toContain("| 1 | Distance | No label | 12 mm |");
		expect(html).toContain("<td>No label</td>");
		expect(html).toContain("<h1>Draft reading report for case 42</h1>");
	});
});

describe("buildReportHtml", () => {
	it("embeds screenshots and escapes user text", () => {
		const html = buildReportHtml({
			...baseInput,
			transcript: [{ t: 0, text: "<script>alert(1)</script>" }],
		});
		expect(html).toContain("data:image/png;base64,AAAA");
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});
