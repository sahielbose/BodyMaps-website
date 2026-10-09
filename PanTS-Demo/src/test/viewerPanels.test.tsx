/**
 * The panels that open over the case viewer: the report walkthrough (its 3D
 * pane motion, story panel and toggles), reduced-motion overrides that must
 * actually win the cascade, and the live-room and session dialogs' state and
 * focus handling.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReportScreen, { cache, REPORT_PANE_SELECTOR, reportPaneCss } from "../components/ReportScreen/ReportScreen";
import FindingsTimeline from "../components/ReportScreen/FindingsTimeline";
import SessionHUD from "../components/ReadingSession/SessionHUD";
import SessionSummary from "../components/ReadingSession/SessionSummary";
import type { ReadingSession } from "../helpers/readingSession";
import { LiveRoomDock, LiveRoomHeader } from "../liveRooms/LiveRoomChrome";
import LiveRoomCreateDialog from "../liveRooms/LiveRoomCreateDialog";
import type { LiveRoomController } from "../liveRooms/types";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

// ─── A small cascade, enough to say which declaration wins ───────────────────

type Specificity = [number, number, number];
type Decl = { value: string; important: boolean; spec: Specificity; order: number; source: string };

function splitSelectorList(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = "";
	for (const ch of text) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function specificity(selector: string): Specificity {
	// :not(x) and :is(x) count as their argument; :where() counts nothing.
	let s = selector.replace(/:where\([^)]*\)/g, "").replace(/:(?:not|is)\(([^)]*)\)/g, " $1");
	const pseudoElements = (s.match(/::[\w-]+/g) || []).length;
	s = s.replace(/::[\w-]+/g, "");
	const ids = (s.match(/#[\w-]+/g) || []).length;
	const classes = (s.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
	const types = (s.replace(/\[[^\]]+\]/g, "").match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
	return [ids, classes, types + pseudoElements];
}

/**
 * Every declaration of `prop` in `cssText` that applies to `el`. Rules inside
 * an @media block count only when `mediaMatches` says that query is on.
 */
function declarationsFor(
	cssText: string,
	source: string,
	el: Element,
	prop: string,
	orderBase: number,
	mediaMatches: (media: string) => boolean = () => false,
): Decl[] {
	const style = document.createElement("style");
	style.textContent = cssText;
	document.head.appendChild(style);
	const out: Decl[] = [];
	let order = orderBase;
	const walk = (rules: CSSRuleList) => {
		for (const rule of Array.from(rules)) {
			order++;
			const media = (rule as CSSMediaRule).media;
			if (media) {
				if (mediaMatches(media.mediaText)) walk((rule as CSSMediaRule).cssRules);
				continue;
			}
			const styleRule = rule as CSSStyleRule;
			if (!styleRule.selectorText || !styleRule.style) continue;
			const value = styleRule.style.getPropertyValue(prop);
			if (!value) continue;
			for (const selector of splitSelectorList(styleRule.selectorText)) {
				let matches = false;
				try {
					matches = el.matches(selector);
				} catch {
					matches = false;
				}
				if (!matches) continue;
				out.push({
					value,
					important: styleRule.style.getPropertyPriority(prop) === "important",
					spec: specificity(selector),
					order,
					source,
				});
			}
		}
	};
	walk(style.sheet!.cssRules);
	style.remove();
	return out;
}

function winner(decls: Decl[]): Decl | undefined {
	return [...decls].sort((a, b) => {
		if (a.important !== b.important) return a.important ? -1 : 1;
		for (let i = 0; i < 3; i++) if (a.spec[i] !== b.spec[i]) return b.spec[i] - a.spec[i];
		return b.order - a.order;
	})[0];
}

const reducedMotion = (media: string) => /prefers-reduced-motion:\s*reduce/.test(media);

function setReducedMotion(on: boolean) {
	window.matchMedia = vi.fn().mockImplementation((query: string) => ({
		matches: on && /prefers-reduced-motion:\s*reduce/.test(query),
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}));
}

// ─── Report walkthrough ─────────────────────────────────────────────────────

const REPORT_ID = "panel-test";

function seedReport() {
	cache[REPORT_ID] = {
		case_id: REPORT_ID,
		patient: { age: 61, sex: "F" },
		imaging: { study_type: "CT", contrast: "yes", spacing: [1, 1, 1], shape: [1, 1, 1] },
		organ_volumes: {
			liver: { volume: 1500, mean_hu: 55, status: "normal" },
			spleen: { volume: 200, mean_hu: 45, status: "normal" },
			lung_left: { volume: 900, mean_hu: -800, status: "check" },
			kidney_left: { volume: 150, mean_hu: 30, status: "check" },
		},
		lesions: {},
		comments: "Lung: a small nodule is seen. Kidney: a simple cyst is noted.",
		impression: ["1. Lung nodule."],
	};
}

function paneCss(): string {
	return Array.from(document.querySelectorAll("style"))
		.map((s) => s.textContent ?? "")
		.find((t) => t.includes(REPORT_PANE_SELECTOR)) ?? "";
}

function renderReport(onClose = vi.fn()) {
	render(
		<ReportScreen id={REPORT_ID} onClose={onClose} onViewChange={vi.fn()} />,
	);
	return onClose;
}

describe("report walkthrough 3D pane", () => {
	// The pane as VisualizationPage renders it while the report is open.
	function renderPane(reportOpen: boolean) {
		const root = document.createElement("div");
		root.className = `VisualizationPage${reportOpen ? " report-open" : ""}`;
		root.innerHTML = '<div class="visualization-container"><div class="render vp-pane vp-pane--render"></div></div>';
		document.body.appendChild(root);
		return { pane: root.querySelector(".render")!, cleanup: () => root.remove() };
	}

	it("the report's transition beats the viewer's transition:none only while the report is open", () => {
		const viewerCss = read("src/routes/VisualizationPage.css");
		const reportCss = reportPaneCss(1, 5, false);

		const open = renderPane(true);
		const openDecls = [
			...declarationsFor(viewerCss, "viewer", open.pane, "transition", 0),
			...declarationsFor(reportCss, "report", open.pane, "transition", 100000),
		];
		// The viewer rule really does target this pane (that is why it used to win).
		expect(openDecls.some((d) => d.source === "viewer" && d.important && d.value === "none")).toBe(true);
		const openWinner = winner(openDecls)!;
		expect(openWinner.source).toBe("report");
		expect(openWinner.value).toMatch(/transform/);
		expect(openWinner.value).toMatch(/filter/);
		open.cleanup();

		// Normal viewing: the report selector no longer matches, panes still snap.
		const closed = renderPane(false);
		const closedWinner = winner([
			...declarationsFor(viewerCss, "viewer", closed.pane, "transition", 0),
			...declarationsFor(reportCss, "report", closed.pane, "transition", 100000),
		])!;
		expect(closedWinner.source).toBe("viewer");
		expect(closedWinner.value).toBe("none");
		closed.cleanup();
	});

	it("respects reduced motion with an override on the same selector", () => {
		const open = renderPane(true);
		const decls = declarationsFor(reportPaneCss(2, 5, false), "report", open.pane, "transition", 0, reducedMotion);
		expect(winner(decls)!.value).toBe("none");
		open.cleanup();
	});

	it("moves only filter and transform", () => {
		for (const [step, closing] of [[0, false], [1, false], [2, false], [4, false], [2, true]] as const) {
			const css = reportPaneCss(step, 5, closing);
			const transition = /transition: ([^!]+)!important; }/.exec(css)![1];
			const props = splitSelectorList(transition).map((part) => part.split(" ")[0]);
			expect(props).toEqual(["filter", "transform"]);
		}
	});
});

describe("annotation ribbon clearance", () => {
	it("starts every panel docked in the body row below the ribbon, not just the stage", () => {
		const viewerCss = read("src/routes/VisualizationPage.css");
		const root = document.createElement("div");
		root.className = "VisualizationPage annotation-open";
		root.innerHTML =
			'<div class="vp-body"><div class="vp-organs vp-organs--open"></div>' +
			'<div class="vp-stage"></div><div class="vp-stats"></div><div class="vp-measure"></div></div>';
		document.body.appendChild(root);
		const marginOf = (selector: string) =>
			winner(declarationsFor(viewerCss, "viewer", root.querySelector(selector)!, "margin-top", 0))?.value;

		const stage = marginOf(".vp-stage");
		expect(stage).toMatch(/--atb-ribbon-h/);
		// The Organs panel's header used to sit under the ribbon, unclickable.
		for (const selector of [".vp-organs", ".vp-stats", ".vp-measure"]) {
			expect(marginOf(selector)).toBe(stage);
		}
		root.remove();
	});
});

describe("guided flow Continue focus", () => {
	it("marks keyboard focus with an outline, which the Continue pulse's box-shadow can't cover", () => {
		// A ready Continue pulses its box-shadow from an inline animation, and
		// an animation beats any static box-shadow, focus ring included.
		expect(read("src/components/viewer/AnnotationToolbar.tsx")).toMatch(/@keyframes seg-effect-continue-pulse\s*\{[^}]*box-shadow/);

		// :focus-visible as an attribute of the same weight, so the button can
		// be matched as focused.
		const focused = (css: string) => css.replace(/:focus-visible/g, "[data-focus-visible]");
		const continueBtn = document.createElement("button");
		continueBtn.className = "atb-guided__btn atb-guided__btn--continue";
		continueBtn.setAttribute("data-focus-visible", "");
		const ring = winner([
			...declarationsFor(focused(read("src/index.css")), "index", continueBtn, "outline", 0),
			...declarationsFor(focused(read("src/components/viewer/AnnotationToolbar.css")), "toolbar", continueBtn, "outline", 10000),
		]);
		expect(ring?.value).toMatch(/^2px solid /);
	});
});

describe("viewer tool busy state", () => {
	// The `border` shorthand sets the colour too, and this small cascade
	// doesn't expand shorthands, so both compete for it.
	const borderColour = (className: string) => {
		const viewerCss = read("src/routes/VisualizationPage.css");
		const tool = document.createElement("button");
		tool.className = className;
		return winner([
			...declarationsFor(viewerCss, "viewer", tool, "border", 0),
			...declarationsFor(viewerCss, "viewer", tool, "border-color", 0),
		])?.value;
	};

	it("shows the busy border over the plain tool border", () => {
		expect(borderColour("vp-tool vp-tool--busy")).toBe("rgba(110, 168, 254, 0.55)");
	});

	it("still lets an active tool keep its white border while busy", () => {
		expect(borderColour("vp-tool vp-tool--active vp-tool--busy")).toBe("#ffffff");
	});
});

describe("ReportScreen", () => {
	beforeEach(() => {
		seedReport();
		setReducedMotion(false);
	});
	afterEach(() => {
		delete cache[REPORT_ID];
	});

	it("poses the pane per step, and Exit eases it back before closing", async () => {
		const onClose = renderReport();
		await screen.findByRole("button", { name: /Start walkthrough/ });
		expect(paneCss()).toContain("blur(12px)");

		fireEvent.click(screen.getByRole("button", { name: /Start walkthrough/ }));
		expect(paneCss()).toContain("translateX(180px)");

		fireEvent.click(screen.getByRole("button", { name: "Exit" }));
		// Not gone yet: the pane rule stays mounted and eases to rest.
		expect(onClose).not.toHaveBeenCalled();
		expect(paneCss()).toContain("filter: none !important; transform: none !important");
		expect(paneCss()).toMatch(/transition: filter \d+ms/);
		expect(screen.queryByRole("button", { name: "Exit" })).not.toBeInTheDocument();
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("closes at once with reduced motion", async () => {
		setReducedMotion(true);
		const onClose = renderReport();
		await screen.findByRole("button", { name: /Start walkthrough/ });
		fireEvent.keyDown(window, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("replays the story and evidence panels' slide-in on every step, same direction included", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		fireEvent.click(screen.getByRole("button", { name: /Explain finding/ }));

		const firstStory = screen.getByRole("heading", { name: "Left lung" }).parentElement!;
		const firstEvidence = screen.getByText("Measurements").parentElement!;
		expect(firstStory.style.animation).toMatch(/slideR/);

		fireEvent.click(screen.getByRole("button", { name: /Next finding/ }));
		const secondStory = screen.getByRole("heading", { name: "Left kidney" }).parentElement!;
		// A fresh node, so the (unchanged) slideR animation starts again.
		expect(firstStory.isConnected).toBe(false);
		expect(secondStory).not.toBe(firstStory);
		expect(secondStory.style.animation).toMatch(/slideR/);
		expect(firstEvidence.isConnected).toBe(false);
	});

	it("exposes the Patient/Doctor choice and the current step", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));

		const patient = screen.getByRole("button", { name: "Patient" });
		const doctor = screen.getByRole("button", { name: "Doctor" });
		expect(patient).toHaveAttribute("aria-pressed", "true");
		expect(doctor).toHaveAttribute("aria-pressed", "false");
		fireEvent.click(doctor);
		expect(doctor).toHaveAttribute("aria-pressed", "true");
		expect(patient).toHaveAttribute("aria-pressed", "false");

		expect(screen.getByRole("button", { name: "Step 1 of 4" })).toHaveAttribute("aria-current", "step");
		expect(screen.getByRole("button", { name: "Step 2 of 4" })).not.toHaveAttribute("aria-current");
		const share = screen.getByRole("button", { name: /Share report/ });
		expect(share).toHaveAttribute("aria-expanded", "false");
	});

	it("says one organ looks healthy, not one organs look healthy", async () => {
		delete cache[REPORT_ID].organ_volumes.spleen;
		renderReport();
		await screen.findByRole("button", { name: /Start walkthrough/ });
		expect(screen.getByText(/^1 organ looks healthy\. 2 findings will be explained\.$/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /Start walkthrough/ }));
		expect(screen.getByRole("heading", { name: "1\u00a0organ looks healthy." })).toBeInTheDocument();
	});

	it("keeps the plural for several healthy organs", async () => {
		renderReport();
		await screen.findByRole("button", { name: /Start walkthrough/ });
		expect(screen.getByText(/^2 organs look healthy\./)).toBeInTheDocument();
	});

	it("names the finding count on the last step instead of repeating its eyebrow", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		fireEvent.click(screen.getByRole("button", { name: /Explain finding/ }));
		fireEvent.click(screen.getByRole("button", { name: /Next finding/ }));
		fireEvent.click(screen.getByRole("button", { name: /Finish/ }));
		expect(screen.getByRole("heading", { name: "2 findings to review." })).toBeInTheDocument();
		expect(screen.getByText("Lung nodule.")).toBeInTheDocument();
	});

	it("names Share and Exit on the buttons themselves, so the icon-only phone layout keeps them", async () => {
		renderReport();
		await screen.findByRole("button", { name: /Start walkthrough/ });
		expect(screen.getByRole("button", { name: "Share report" })).toHaveAttribute("aria-label", "Share report");
		expect(screen.getByRole("button", { name: "Exit" })).toHaveAttribute("aria-label", "Exit");
	});

	it("points the doctor at the evidence panel on the right, or below it when the panels stack", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		fireEvent.click(screen.getByRole("button", { name: "Doctor" }));
		fireEvent.click(screen.getByRole("button", { name: /Explain finding/ }));
		const hint = screen.getByText(/Measurements are in the panel/);
		expect(hint.querySelector(".rs-where-wide")).toHaveTextContent("on the right");
		expect(hint.querySelector(".rs-where-narrow")).toHaveTextContent("below");
		const css = Array.from(document.querySelectorAll("style")).map((st) => st.textContent ?? "").join("\n");
		expect(css).toMatch(/\.rs-where-narrow \{ display: none; \}/);
		expect(css).toMatch(/@media \(max-width: 899px\)[\s\S]*\.rs-where-wide \{ display: none; \}/);
	});

	it("keeps focus inside the report while it is open", async () => {
		renderReport();
		await screen.findByRole("button", { name: /Start walkthrough/ });
		const dialog = screen.getByRole("dialog", { name: "CT scan report" });
		expect(dialog).toHaveAttribute("aria-modal", "true");
		expect(dialog.contains(document.activeElement)).toBe(true);
	});
});

describe("report step navigation", () => {
	beforeEach(() => {
		seedReport();
		setReducedMotion(false);
	});
	afterEach(() => {
		delete cache[REPORT_ID];
	});

	it("leaves the slide direction alone when the step already showing is clicked", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		fireEvent.click(screen.getByRole("button", { name: /Explain finding/ }));
		const card = () => screen.getByText("Measurements").closest(".rs-evidence")!.firstElementChild as HTMLElement;
		expect(card().style.animation).toMatch(/^slideR /);

		const current = screen.getByRole("group", { name: "Report steps" }).querySelector("[aria-current='step']") as HTMLElement;
		fireEvent.click(current);
		expect(card().style.animation).toMatch(/^slideR /);
	});
});

describe("report walkthrough on narrow screens", () => {
	// A phone matches both the 979px top bar query and the 899px panel query;
	// a 950px window matches only the first.
	const narrow = (media: string) => /max-width:\s*(899|979)px/.test(media);
	const mid = (media: string) => /max-width:\s*979px/.test(media);
	const wide = () => false;

	function reportCss(): string {
		return Array.from(document.querySelectorAll("style"))
			.map((s) => s.textContent ?? "")
			.find((t) => t.includes(".rs-stage")) ?? "";
	}
	function valueOf(el: Element, prop: string, media: (m: string) => boolean) {
		return winner(declarationsFor(reportCss(), "report", el, prop, 0, media))?.value;
	}

	beforeEach(() => {
		seedReport();
		setReducedMotion(false);
	});
	afterEach(() => {
		delete cache[REPORT_ID];
	});

	it("keeps the desktop layout: story panel left, evidence panel right, one-row top bar", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		fireEvent.click(screen.getByRole("button", { name: /Explain finding/ }));
		const story = screen.getByRole("heading", { name: "Left lung" }).closest(".rs-story")!;
		const evidence = screen.getByText("Measurements").closest(".rs-evidence")!;

		expect(valueOf(story, "position", wide)).toBe("fixed");
		expect(valueOf(story, "left", wide)).toBe("64px");
		expect(valueOf(story, "width", wide)).toBe("360px");
		expect(valueOf(evidence, "position", wide)).toBe("fixed");
		expect(valueOf(evidence, "right", wide)).toBe("72px");
		expect(valueOf(story.parentElement!, "display", wide)).toBe("contents");
		expect(valueOf(document.querySelector(".rs-topbar-brand")!, "min-width", wide)).toBe("270px");
	});

	it("stacks the panels in one column and keeps Share and Exit in view below 900px", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		fireEvent.click(screen.getByRole("button", { name: /Explain finding/ }));
		const story = screen.getByRole("heading", { name: "Left lung" }).closest(".rs-story") as HTMLElement;
		const evidence = screen.getByText("Measurements").closest(".rs-evidence") as HTMLElement;
		// The card sits in a slot that holds the strip under it free on finding steps.
		const stage = story.closest(".rs-stage") as HTMLElement;
		expect(stage).toBe(evidence.parentElement);

		expect(valueOf(stage, "display", narrow)).toBe("flex");
		expect(valueOf(stage, "flex-direction", narrow)).toBe("column");
		expect(valueOf(stage, "overflow-y", narrow)).toBe("auto");
		// The evidence card slides in from 24px right, past the 12px padding.
		expect(valueOf(stage, "overflow-x", narrow)).toBe("hidden");
		for (const panel of [story, evidence]) {
			expect(valueOf(panel, "position", narrow)).toBe("static");
			// Layout is not also set inline, where it would beat the media query.
			for (const prop of ["position", "left", "right", "top", "width", "transform"] as const) {
				expect(panel.style[prop]).toBe("");
			}
		}
		// The evidence card's fixed 330 or 350px width gives way to the column.
		const card = evidence.firstElementChild!;
		expect(winner(declarationsFor(reportCss(), "report", card, "width", 0, narrow))).toMatchObject({ value: "auto", important: true });

		// The top bar actions never shrink off the edge; the brand gives way instead.
		const exit = screen.getByRole("button", { name: "Exit" });
		const share = screen.getByRole("button", { name: /Share report/ });
		const actions = exit.parentElement!;
		expect(actions).toHaveClass("rs-topbar-actions");
		expect(actions.contains(share)).toBe(true);
		expect(valueOf(actions, "flex-shrink", narrow)).toBe("0");
		expect(valueOf(document.querySelector(".rs-topbar-brand")!, "min-width", narrow)).toBe("0");
		// The labels are visually hidden but still name the buttons.
		const exitLabel = exit.querySelector(".rs-btn-label")!;
		expect(valueOf(exitLabel, "position", narrow)).toBe("absolute");
		expect(valueOf(exitLabel, "position", wide)).toBeUndefined();

		// The Share popover spans the screen instead of hanging off a 340px box.
		fireEvent.click(share);
		const popover = document.getElementById("rs-share-popover")!;
		expect(valueOf(popover, "width", wide)).toBe("340px");
		expect(valueOf(popover, "width", narrow)).toBe("auto");
		expect(valueOf(popover, "left", narrow)).toBe("12px");
		expect(popover.style.width).toBe("");
		// The popover sits in the top bar, which must paint above the stacked
		// stage (z-index 10001, later in the DOM) or the stage covers Copy.
		const topbar = document.querySelector(".rs-topbar") as HTMLElement;
		expect(Number(topbar.style.zIndex)).toBeGreaterThan(Number(valueOf(stage, "z-index", narrow)));
	});

	it("ends the phone column with the findings timeline instead of pinning it over the story's buttons", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		const story = document.querySelector(".rs-story") as HTMLElement;
		const timeline = screen.getByRole("group", { name: "Findings in reading order" });
		const wrapper = timeline.parentElement!;
		expect(wrapper).toHaveClass("rs-timeline");
		expect(wrapper.parentElement).toBe(story.closest(".rs-stage"));
		expect(wrapper.previousElementSibling).toBe(story.parentElement);
		expect(valueOf(wrapper, "position", wide)).toBeUndefined();
		expect(wrapper.style.position).toBe("fixed");
		for (const el of [wrapper, timeline]) {
			expect(winner(declarationsFor(reportCss(), "report", el, "position", 0, narrow))).toMatchObject({ value: "static", important: true });
		}
	});

	it("wraps the top bar to two rows from 979px down while the panels stay side by side until 899px", async () => {
		renderReport();
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		const title = document.querySelector(".rs-topbar-title")!;
		const story = document.querySelector(".rs-story")!;
		expect(valueOf(title, "position", wide)).toBe("absolute");
		expect(valueOf(title, "position", mid)).toBe("static");
		expect(valueOf(story, "position", mid)).toBe("fixed");
		const exitLabel = screen.getByRole("button", { name: "Exit" }).querySelector(".rs-btn-label")!;
		expect(valueOf(exitLabel, "position", mid)).toBeUndefined();
	});
});

describe("FindingsTimeline", () => {
	afterEach(() => setReducedMotion(false));

	it("renders keyboard-reachable nodes whose pulses can be switched off", () => {
		setReducedMotion(true);
		const onNodeTap = vi.fn();
		render(
			<FindingsTimeline
				organStatuses={[{ organ: "lung_left", status: "check" }, { organ: "kidney_left", status: "check" }]}
				comments="Lung first. Kidney second."
				focusedOrgan="lung_left"
				onNodeTap={onNodeTap}
			/>,
		);
		// Reduced motion reveals every node at once instead of one by one.
		const node = screen.getByRole("button", { name: "Left lung, finding to review" });
		expect(node).toHaveAttribute("aria-current", "step");
		fireEvent.click(screen.getByRole("button", { name: "Left kidney, finding to review" }));
		expect(onNodeTap).toHaveBeenCalledWith("kidney_left");

		// Pulses are class-driven (so a media query can stop them), never an
		// inline box-shadow animation.
		expect(document.querySelectorAll(".ft-halo").length).toBe(2);
		for (const el of Array.from(document.querySelectorAll<HTMLElement>("[style]"))) {
			expect(el.style.animation).toBe("");
		}
		const css = Array.from(document.querySelectorAll("style")).map((s) => s.textContent).join("\n");
		expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*\.ft-node, \.ft-halo, \.ft-ring \{ animation: none !important; \}/);
		expect(css).not.toMatch(/box-shadow[^;]*;\s*}\s*50%/);
	});
});

// ─── Reduced-motion overrides that win ──────────────────────────────────────

describe("AI sidebar model dot", () => {
	const css = read("src/components/AIAssistant/AISidebar.css");

	function dotIn(open: boolean) {
		const aside = document.createElement("aside");
		aside.className = open ? "ai-sidebar is-open" : "ai-sidebar";
		aside.innerHTML = '<button class="ai-model-picker__button" data-state="loading"><span class="ai-model-picker__dot"></span></button>';
		document.body.appendChild(aside);
		return { dot: aside.querySelector(".ai-model-picker__dot")!, cleanup: () => aside.remove() };
	}

	it("pulses while loading in an open panel", () => {
		const { dot, cleanup } = dotIn(true);
		expect(winner(declarationsFor(css, "ai", dot, "animation", 0))!.value).toMatch(/ai-model-pulse/);
		cleanup();
	});

	it("stops when the panel is closed", () => {
		const { dot, cleanup } = dotIn(false);
		expect(winner(declarationsFor(css, "ai", dot, "animation", 0))!.value).toBe("none");
		cleanup();
	});

	it("stops under reduced motion, beating the (0,4,0) loading rule", () => {
		const { dot, cleanup } = dotIn(true);
		const decl = winner(declarationsFor(css, "ai", dot, "animation", 0, reducedMotion))!;
		expect(decl.value).toBe("none");
		expect(decl.important).toBe(true);
		cleanup();
	});
});

describe("live rooms reduced motion", () => {
	it("has a single reduced-motion block, and it stops the spinner", () => {
		const css = read("src/liveRooms/liveRooms.css");
		expect(css.match(/prefers-reduced-motion/g)).toHaveLength(1);
		const ring = document.createElement("div");
		ring.className = "lr-loading-ring";
		document.body.appendChild(ring);
		expect(winner(declarationsFor(css, "lr", ring, "animation", 0, reducedMotion))!.value).toBe("none");
		expect(winner(declarationsFor(css, "lr", ring, "animation", 0))!.value).toMatch(/lr-spin/);
		ring.remove();
	});
});

// ─── State on toggles, and dialog focus ─────────────────────────────────────

function controller(overrides: Partial<LiveRoomController> = {}): LiveRoomController {
	return {
		metadata: {
			room_id: "room-1", case_id: "35", resolution: "low",
			created_at: "2026-07-12T00:00:00Z", expires_at: "2026-07-13T00:00:00Z",
			geometry_hash: "hash", dimensions: [4, 4, 2], latest_seq: 0,
			mode: "review",
		},
		roomKey: "secret",
		maskUrl: "blob:mask",
		participantId: "self",
		name: "Ronit",
		connectionState: "connected",
		participants: [
			{ participant_id: "self", name: "Ronit", color: "#22d3ee", role: "reviewer" },
			{ participant_id: "peer", name: "Maya", color: "#f59e0b", role: "reviewer", plane: "axial" },
		],
		state: { measurements: {}, notes: {}, chat: [] },
		pendingEvents: [],
		acknowledgeEvents: vi.fn(),
		followingId: null,
		error: null,
		undoNotice: null,
		quiz: null,
		quizOwnSubmissions: {},
		quizEligible: false,
		isHost: false,
		collaborationLocked: false,
		sendDurable: vi.fn(), sendPresence: vi.fn(), sendView: vi.fn(), sendChat: vi.fn(),
		addNote: vi.fn(), deleteNote: vi.fn(), requestUndo: vi.fn(), follow: vi.fn(),
		stopFollowing: vi.fn(), copyShareLink: vi.fn(), downloadExport: vi.fn(),
		startQuiz: vi.fn(), answerQuiz: vi.fn(), closeQuiz: vi.fn(), revealQuiz: vi.fn(), advanceQuiz: vi.fn(),
		...overrides,
	};
}

describe("live room toggles", () => {
	it("Follow is a pressed-state toggle with a stable name", () => {
		const room = controller();
		const { rerender } = render(<LiveRoomDock room={room} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		const follow = screen.getByRole("button", { name: "Follow Maya" });
		expect(follow).toHaveAttribute("aria-pressed", "false");

		const following = controller({ followingId: "peer" });
		rerender(<LiveRoomDock room={following} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		const pressed = screen.getByRole("button", { name: "Follow Maya" });
		expect(pressed).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(pressed);
		expect(following.stopFollowing).toHaveBeenCalled();
	});

	it("dock tabs follow the tabs pattern", () => {
		render(<LiveRoomDock room={controller()} crosshair={null} activePlane="axial" onClose={vi.fn()} />);
		const people = screen.getByRole("tab", { name: /People/ });
		expect(people).toHaveAttribute("tabindex", "0");
		expect(screen.getByRole("tab", { name: /Notes/ })).toHaveAttribute("tabindex", "-1");

		people.focus();
		fireEvent.keyDown(people, { key: "ArrowRight" });
		const notes = screen.getByRole("tab", { name: /Notes/ });
		expect(notes).toHaveAttribute("aria-selected", "true");
		expect(document.activeElement).toBe(notes);

		fireEvent.keyDown(notes, { key: "End" });
		const chat = screen.getByRole("tab", { name: /Chat/ });
		expect(chat).toHaveAttribute("aria-selected", "true");
		expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", chat.id);

		fireEvent.keyDown(chat, { key: "ArrowRight" });
		expect(screen.getByRole("tab", { name: /People/ })).toHaveAttribute("aria-selected", "true");
	});

	it("the dock toggle says what it opens", () => {
		render(<LiveRoomHeader room={controller()} dockOpen onToggleDock={vi.fn()} />);
		expect(screen.getByRole("button", { name: "People 2/8 connected" })).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Live room")).toBeInTheDocument();
	});
});

describe("live room dialog focus", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("moves focus to the first mode, and Escape or a backdrop click closes it", () => {
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
		const onClose = vi.fn();
		render(
			<MemoryRouter>
				<LiveRoomCreateDialog caseId="35" open onClose={onClose} />
			</MemoryRouter>,
		);
		expect(screen.getByRole("heading", { name: "Live rooms" })).toBeInTheDocument();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: /Collaborative review/ }));

		fireEvent.keyDown(document.activeElement!, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);

		const backdrop = document.querySelector(".lr-modal-backdrop")!;
		fireEvent.mouseDown(backdrop);
		fireEvent.click(backdrop);
		expect(onClose).toHaveBeenCalledTimes(2);

		// A drag that starts inside the card and ends on the backdrop is not a dismissal.
		fireEvent.mouseDown(screen.getByRole("dialog"));
		fireEvent.click(backdrop);
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});

describe("reading session recording pill", () => {
	it("is a labelled group whose clock is a timer, not a live region read every second", () => {
		const session = { elapsedMs: 65000, events: [], shots: [], micGranted: false } as unknown as ReadingSession;
		render(<SessionHUD session={session} onSnapshot={vi.fn()} onStop={vi.fn()} />);
		const pill = screen.getByRole("group", { name: "Reading session recording" });
		expect(pill).not.toHaveAttribute("aria-live");
		const timer = within(pill).getByRole("timer");
		expect(timer.closest("[aria-live], [role=status], [role=alert], [role=log]")).toBeNull();
		// The one status region speaks only of starts and key images, never the clock.
		const status = screen.queryByRole("status");
		if (status) {
			expect(status).not.toContainElement(timer);
			expect(status.textContent).not.toMatch(/\d+:\d{2}/);
		}
		expect(within(pill).getByRole("button", { name: "Stop" })).toBeInTheDocument();
	});
});

describe("reading session summary", () => {
	it("is a modal dialog, and Escape backs out of the report preview", () => {
		render(
			<SessionSummary
				result={{
					caseId: "7", startedAt: 1750000000000, durationMs: 65000,
					events: [], shots: [], transcript: [], audio: null, audioExt: "webm", micGranted: false,
				}}
				measurements={[]}
				onDiscard={vi.fn()}
			/>,
		);
		const summary = screen.getByRole("dialog", { name: "Reading session captured" });
		expect(summary).toHaveAttribute("aria-modal", "true");
		expect(summary.contains(document.activeElement)).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: /Open draft report/ }));
		expect(screen.getByText("Draft report for case 7")).toBeInTheDocument();
		act(() => {
			fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
		});
		expect(screen.getByRole("dialog", { name: "Reading session captured" })).toBeInTheDocument();
	});
});
