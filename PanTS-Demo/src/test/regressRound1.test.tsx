/**
 * Regressions found in review round 1, one describe per fix.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MessagePage from "../components/MessagePage";
import ScrollToTopButton from "../components/ScrollToTopButton";
import ReportScreen, { cache } from "../components/ReportScreen/ReportScreen";
import { AuthProvider, useAuth } from "../contexts/authContext";

const viewerDispose = vi.hoisted(() => vi.fn());
const viewerVolumeSequence = vi.hoisted(() => ({ value: 0 }));

// The CT viewer relies on WebGL (Niivue + Cornerstone) and a three.js loader,
// none of which run under jsdom/CI (no GPU). Mock those modules so we can verify
// the page component itself mounts and wires up without crashing.
vi.mock("@niivue/niivue", () => ({
	Niivue: class {
		attachToCanvas() {}
		loadVolumes() {
			return Promise.resolve();
		}
		setSliceType() {}
		setInterpolation() {}
		drawScene() {}
	},
}));

vi.mock("../helpers/CornerstoneNifti2", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
	return {
		...actual,
		getOrganLabelOnClick: vi.fn(),
		getOrganLabelAtPoint: vi.fn(() => undefined),
		moveCornerstoneCrosshairToMm: vi.fn(),
		renderVisualization: vi.fn().mockImplementation(async () => ({
			renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() },
			viewportIds: [],
			volumeId: `test-volume-${++viewerVolumeSequence.value}`,
			dispose: viewerDispose,
		})),
		setFillOpacity: vi.fn(),
		setPaneSliceIndex: vi.fn(),
		subscribeToSliceChanges: vi.fn(() => () => {}),
		setOutlineOpacity: vi.fn(),
		setVisibilities: vi.fn(),
		subscribeToCrosshairChanges: vi.fn(),
		subscribeToVolumeProgress: vi.fn(() => () => {}),
		toggleCrosshairTool: vi.fn(),
		setActiveMeasurementTool: vi.fn(),
		clearMeasurements: vi.fn(),
		applyRemoteMeasurement: vi.fn(),
		removeRemoteMeasurement: vi.fn(),
		getCrosshairMm: vi.fn(() => null),
		getOrganCentroids: vi.fn(() => null),
		// Measurement inventory + reading-session capture APIs
		getMeasurementSummaries: vi.fn(() => []),
		subscribeToMeasurementChanges: vi.fn(() => () => {}),
		captureViewportImages: vi.fn(async () => []),
		renameMeasurement: vi.fn(),
		removeMeasurement: vi.fn(),
		jumpToMeasurement: vi.fn(() => null),
		// Zoom controls in the top toolbar
		setZoom: vi.fn(),
		centerOnCursor: vi.fn(),
		zoomToFit: vi.fn(),
		zoomToCursor: vi.fn(),
		// Progressive full-res upgrade + shaded volume rendering (3D pane)
		upgradeCtVolume: vi.fn(async () => null),
		enableVolume3D: vi.fn(async () => false),
		disableVolume3D: vi.fn(),
		applyVolume3DPreset: vi.fn(),
		getCurrentVolumeModality: () => undefined,
		// Mask editing (brush/eraser + labelmap export)
		setActiveMaskEditTool: vi.fn(),
		setActiveEditSegment: vi.fn(),
		setMaskBrushSize: vi.fn(),
		undoMaskEdit: vi.fn(),
		redoMaskEdit: vi.fn(),
		getMaskEditHistoryState: vi.fn(() => ({ canUndo: false, canRedo: false })),
		subscribeToSegmentationEdits: vi.fn(() => () => {}),
		getEditedSegments: vi.fn(() => new Set()),
		getSegmentationExport: vi.fn(() => null),
		hasSegmentation: vi.fn(() => false),
		getPresentSegmentIndices: vi.fn(() => null),
		buildMaskFilter: vi.fn(() => () => true),
		setBrushMaskingScope: vi.fn(),
		// Cine playback + oblique-MPR reset
		startCine: vi.fn(() => false),
		stopCine: vi.fn(),
		setReferenceLinesEnabled: vi.fn(),
		flipPaneHorizontal: vi.fn(),
		rotatePane90Clockwise: vi.fn(),
		resetMprOrientation: vi.fn(),
	};
});

// A local NIfTI arrives as a blob: URL over the decompressed file.
vi.mock("../helpers/localNifti", () => ({
	loadLocalNiftiAsRawBlobUrl: vi.fn(async () => "blob:local-ct"),
	getLocalNiftiFile: vi.fn(() => null),
	setLocalNiftiFile: vi.fn(),
}));

import { renderVisualization } from "../helpers/CornerstoneNifti2";
import { DARK_ROUTE_CLASS, isDarkRoute, isFixedViewerRoute } from "../helpers/routeSurface";
import VerifyEmail from "../routes/VerifyEmail";
import VisualizationPage from "../routes/VisualizationPage";

/** The body of the `@media` block whose query is exactly `query`. */
function mediaBlock(css: string, query: string): string {
	const start = css.indexOf(`@media (${query}) {`);
	if (start < 0) throw new Error(`no @media (${query})`);
	let depth = 0;
	for (let i = css.indexOf("{", start); i < css.length; i++) {
		if (css[i] === "{") depth++;
		if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", start) + 1, i);
	}
	throw new Error("unbalanced");
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(css: string, selector: string): string {
	const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`(?:^|[};/])\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
	if (!match) throw new Error(`no rule for ${selector}`);
	return match[1];
}

describe("report walkthrough story card on a phone", () => {
	const source = readFileSync(resolve(process.cwd(), "src/components/ReportScreen/ReportScreen.tsx"), "utf8");
	const STYLES = /const STYLES = `([\s\S]*?)`;/.exec(source)![1];
	const ID = "regress-r1-story";

	beforeEach(() => {
		cache[ID] = {
			case_id: ID,
			patient: { age: 61, sex: "F" },
			imaging: { study_type: "CT", contrast: "yes", spacing: [1, 1, 1], shape: [1, 1, 1] },
			organ_volumes: {
				liver: { volume: 1500, mean_hu: 55, status: "normal" },
				lung_left: { volume: 900, mean_hu: -800, status: "check" },
			},
			lesions: {},
			comments: "Lung: a small nodule is seen.",
			impression: ["1. Lung nodule."],
		};
	});
	afterEach(() => {
		delete cache[ID];
		vi.restoreAllMocks();
	});

	it("does not let the scrolling story card shrink inside the fixed-height stage column", () => {
		const narrow = mediaBlock(STYLES, "max-width: 899px");
		// The stage is a fixed-height column that scrolls, and the card scrolls too.
		expect(rule(narrow, ".rs-stage")).toMatch(/flex-direction: column/);
		expect(rule(narrow, ".rs-stage")).toMatch(/overflow-y: auto/);
		const story = rule(narrow, ".rs-story");
		expect(story).toMatch(/max-height: 46vh/);
		expect(story).toMatch(/overflow-y: auto/);
		// A flex item with overflow other than visible has a minimum height of 0,
		// so without this it collapses under the evidence panel and the timeline
		// and the column never scrolls.
		expect(story).toMatch(/flex(?:-shrink)?:\s*(?:none|0)\b/);
	});

	it("still keeps the Back and Next row pinned inside the card on a finding step", async () => {
		render(<ReportScreen id={ID} onClose={vi.fn()} onViewChange={vi.fn()} />);
		fireEvent.click(await screen.findByRole("button", { name: /Start walkthrough/ }));
		fireEvent.click(screen.getByRole("button", { name: /Explain finding/ }));
		const story = document.querySelector(".rs-story")!;
		// The stacked column the card has to hold its size in: story, evidence, timeline.
		const stage = story.closest(".rs-stage")!;
		expect(stage.querySelector(".rs-evidence")).not.toBeNull();
		expect(stage.querySelector(".rs-timeline")).not.toBeNull();
		expect(story.querySelector(".rs-story-actions")).toContainElement(screen.getByRole("button", { name: /Back/ }));
		const actions = rule(mediaBlock(STYLES, "max-width: 899px"), ".rs-story-actions");
		expect(actions).toMatch(/position: sticky/);
		expect(actions).toMatch(/bottom: -24px/);
	});
});

describe("the scan-unavailable page and signing in", () => {
	const account = { id: "u1", email: "reader@example.com", name: null };
	let signedIn = false;
	/** Which account the session-ct probe treats as the owner: null lets anyone in once signed in. */
	let sessionOwner: string | null = null;
	let probes = 0;

	const json = (body: unknown, status = 200) => ({
		ok: status >= 200 && status < 300,
		status,
		arrayBuffer: async () => new ArrayBuffer(0),
		blob: async () => new Blob(),
		json: async () => body,
		text: async () => "",
		headers: { get: () => "application/json" },
	});

	function stubFetch() {
		global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/session-ct/")) {
				probes += 1;
				if (!signedIn) return json({}, 401);
				return json({}, sessionOwner === null || sessionOwner === account.id ? 200 : 403);
			}
			if (url.includes("/api/auth/me")) return json({ user: signedIn ? account : null });
			if (url.includes("/api/auth/login") && init?.method === "POST") {
				signedIn = true;
				return json({ user: account });
			}
			if (url.includes("/api/auth/oauth/providers")) return json({ google: false, github: false });
			return json({});
		}) as unknown as typeof fetch;
	}

	/** Stands in for the header popup's submit: the same signIn the popup calls. */
	function Controls() {
		const { signIn, authPrompt } = useAuth();
		return (
			<>
				<button type="button" onClick={() => void signIn(account.email, "pw")}>
					Submit sign in
				</button>
				<output data-testid="prompt">{authPrompt.open ? authPrompt.mode : "closed"}</output>
			</>
		);
	}

	function renderSession() {
		return render(
			<AuthProvider>
				<MemoryRouter initialEntries={["/session/abc"]}>
					<Routes>
						<Route path="/session/:sessionId" element={<VisualizationPage />} />
					</Routes>
					<Controls />
				</MemoryRouter>
			</AuthProvider>
		);
	}

	const refusedHeading = () => screen.findByRole("heading", { level: 1, name: "This scan isn't available" });
	/** The header shows Sign in only once the first check of the session cookie has come back. */
	const signedOutHeader = () => screen.findAllByRole("button", { name: "Sign in" });
	/** Lets the auth check and any effects it triggers settle. */
	const settle = async () => {
		for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(renderVisualization).mockImplementation(async () => ({
			renderingEngine: { resize: vi.fn(), render: vi.fn(), getViewport: vi.fn() } as never,
			viewportIds: [],
			volumeId: `test-volume-${++viewerVolumeSequence.value}`,
			dispose: viewerDispose,
		}));
		signedIn = false;
		sessionOwner = null;
		probes = 0;
		stubFetch();
	});

	it("opens the scan once the visitor signs in from the page, without a reload", async () => {
		renderSession();
		await refusedHeading();
		await signedOutHeader();
		expect(probes).toBe(1);
		expect(renderVisualization).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Submit sign in" }));

		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		expect(screen.queryByText("This scan isn't available")).toBeNull();
		expect(probes).toBe(2);
	});

	it("says the scan is unavailable again if the account that signed in cannot open it either", async () => {
		sessionOwner = "someone-else";
		renderSession();
		await refusedHeading();
		await signedOutHeader();

		fireEvent.click(screen.getByRole("button", { name: "Submit sign in" }));
		await waitFor(() => expect(probes).toBe(2));
		await settle();

		expect(await refusedHeading()).toBeInTheDocument();
		// One more probe for the new account, and no loop after it.
		expect(probes).toBe(2);
		expect(renderVisualization).not.toHaveBeenCalled();
	});

	it("does not probe again for a refusal given to the account that turns out to be signed in", async () => {
		signedIn = true;
		sessionOwner = "someone-else";
		renderSession();
		await refusedHeading();
		expect(await screen.findByText(account.email)).toBeInTheDocument();
		await settle();
		expect(probes).toBe(1);
	});

	it("does not reload a scan that opened before the account was found", async () => {
		signedIn = true;
		renderSession();
		await waitFor(() => expect(renderVisualization).toHaveBeenCalled());
		// The viewer has no account control, so wait on the auth check itself.
		await waitFor(() =>
			expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/api/auth/me"))).toBe(true),
		);
		await settle();
		expect(probes).toBe(1);
		expect(renderVisualization).toHaveBeenCalledTimes(1);
	});

	it("offers Sign in as a button that opens the popup on this page instead of linking to /upload", async () => {
		renderSession();
		await refusedHeading();
		const main = within(screen.getByRole("main"));

		expect(main.queryByRole("link", { name: "Sign in" })).toBeNull();
		fireEvent.click(await main.findByRole("button", { name: "Sign in" }));

		expect(screen.getByTestId("prompt")).toHaveTextContent("signin");
		expect(screen.getByRole("heading", { level: 1, name: "This scan isn't available" })).toBeInTheDocument();
	});

	it("draws a button action in the shared message page like its link actions", () => {
		const onClick = vi.fn();
		render(
			<AuthProvider>
				<MemoryRouter>
					<MessagePage title="Nothing here" actions={[{ label: "Home", to: "/" }, { label: "Sign in", onClick }]} />
				</MemoryRouter>
			</AuthProvider>
		);
		const button = within(screen.getByRole("main")).getByRole("button", { name: "Sign in" });
		expect(button.className).toContain("secondary");
		fireEvent.click(button);
		expect(onClick).toHaveBeenCalledTimes(1);
		const css = readFileSync(resolve(process.cwd(), "src/components/MessagePage/MessagePage.module.css"), "utf8");
		// Without the reset a <button> keeps the browser's grey face and border.
		expect(rule(css, "button.secondary")).toMatch(/background:\s*none/);
		expect(css).toMatch(/button\.primary,\s*button\.secondary\s*\{[^}]*border:\s*0/);
	});

	it("leaves out Sign in for someone who is already signed in", async () => {
		signedIn = true;
		sessionOwner = "someone-else";
		renderSession();
		await refusedHeading();
		// The header has the account by now, so the auth check has settled.
		expect(await screen.findByText(account.email)).toBeInTheDocument();

		expect(within(screen.getByRole("main")).queryByText("Sign in")).toBeNull();
		expect(within(screen.getByRole("main")).getByRole("link", { name: "Browse the dataset" })).toBeInTheDocument();
	});
});

describe("scroll-to-top button on the dark routes", () => {
	const scrollWindowTo = (y: number) => {
		Object.defineProperty(window, "scrollY", { configurable: true, value: y });
		fireEvent.scroll(document);
	};
	const renderButton = (path: string) =>
		render(
			<MemoryRouter initialEntries={[path]}>
				<ScrollToTopButton />
			</MemoryRouter>
		);

	beforeEach(() => {
		document.documentElement.classList.add(DARK_ROUTE_CLASS);
	});
	afterEach(() => {
		document.documentElement.classList.remove(DARK_ROUTE_CLASS);
		Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
	});

	it("is still there on the compare page, which scrolls the document", () => {
		expect(isDarkRoute("/compare")).toBe(true);
		renderButton("/compare");
		scrollWindowTo(600);
		expect(screen.getByRole("button", { name: "Scroll to top" })).not.toHaveAttribute("inert");
	});

	it.each([
		"/case/17",
		"/session/abc",
		"/reconstruction/abc",
		"/live/room1",
		"/live/challenge/c1",
		"/learn/quiz/p1",
		"/dicom",
		"/local-nifti",
		"/compare-viewer",
	])("is not rendered on the fixed viewer %s", (path) => {
		renderButton(path);
		expect(screen.queryByLabelText("Scroll to top")).toBeNull();
	});

	it("comes back on a viewer route once a light message page has taken the dark class off", () => {
		document.documentElement.classList.remove(DARK_ROUTE_CLASS);
		renderButton("/session/abc");
		scrollWindowTo(600);
		expect(screen.getByRole("button", { name: "Scroll to top" })).toBeInTheDocument();
	});

	it("only lists fixed viewers among the dark routes, and leaves out the ones that scroll", () => {
		for (const path of ["/case/1", "/session/x", "/reconstruction/x", "/live/r", "/live/challenge/c", "/learn/quiz/p", "/dicom", "/local-nifti", "/compare-viewer"]) {
			expect(isFixedViewerRoute(path)).toBe(true);
			expect(isDarkRoute(path)).toBe(true);
		}
		expect(isFixedViewerRoute("/compare")).toBe(false);
		for (const path of ["/", "/dashboard", "/upload", "/team", "/account", "/learn"]) {
			expect(isFixedViewerRoute(path)).toBe(false);
		}
	});
});

describe("verify-email card before the session check returns", () => {
	const account = {
		id: "u1",
		email: "reader@example.com",
		name: null,
		plan: "free",
		email_verified: false,
		roles: [] as string[],
	};
	const json = (body: unknown, ok = true, status = 200) => ({
		ok,
		status,
		json: async () => body,
		text: async () => "",
		headers: { get: () => "application/json" },
	});
	/** Lets the test decide when GET /api/auth/me answers, and who it says is signed in. */
	let releaseMe: (signedIn: boolean) => void;
	let verifyResult: "expired" | "verified";

	beforeEach(() => {
		verifyResult = "expired";
		global.fetch = vi.fn(async (url: RequestInfo | URL) => {
			const u = String(url);
			if (u.includes("/api/auth/verify-email")) {
				return verifyResult === "verified"
					? json({ ok: true, user: account })
					: json({ error: "This link has expired." }, false, 400);
			}
			if (u.includes("/api/auth/me")) {
				return new Promise((resolve) => {
					releaseMe = (signedIn) => resolve(json({ user: signedIn ? account : null }));
				});
			}
			return json({ google: false, github: false });
		}) as unknown as typeof fetch;
	});
	afterEach(() => vi.restoreAllMocks());

	const renderAt = (url: string) =>
		render(
			<AuthProvider>
				<MemoryRouter initialEntries={[url]}>
					<Routes>
						<Route path="/verify-email" element={<VerifyEmail />} />
					</Routes>
				</MemoryRouter>
			</AuthProvider>
		);
	const meAnswers = (signedIn: boolean) => act(async () => releaseMe(signedIn));

	it("shows neither the signed-out note nor a Sign in button to someone who is signed in", async () => {
		renderAt("/verify-email");
		await screen.findByText("Couldn't verify");

		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
		expect(screen.queryByRole("link", { name: "Open settings" })).toBeNull();
		const note = screen.queryByText(/After signing in/);
		if (note) expect(note).not.toBeVisible();

		await meAnswers(true);
		expect(await screen.findByRole("link", { name: "Open settings" })).toHaveAttribute("href", "/account");
		expect(screen.queryByText(/After signing in/)).toBeNull();
		expect(screen.getByText(/^You can ask for a fresh link/)).toBeVisible();
		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
	});

	it("holds the note's and the action's place while the check is out, so the card does not jump", async () => {
		renderAt("/verify-email");
		await screen.findByText("Couldn't verify");

		const note = document.querySelector("p.authm-sent + p.authm-sent") as HTMLElement;
		const action = document.querySelector(".rp-action") as HTMLElement;
		for (const held of [note, action]) {
			expect(held).not.toBeNull();
			expect(held).toHaveAttribute("aria-hidden", "true");
			expect(held).not.toBeVisible();
		}
		// A placeholder, not a control: nothing to tab to or activate.
		expect(action.tagName).toBe("SPAN");
	});

	it("offers Sign in once the check says nobody is signed in", async () => {
		renderAt("/verify-email");
		await screen.findByText("Couldn't verify");
		expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();

		await meAnswers(false);
		expect(await screen.findByRole("button", { name: "Sign in" })).toBeVisible();
		expect(screen.getByText(/^After signing in, you can ask/)).toBeVisible();
	});

	it("does not tell a signed-in reader to sign in on the success card either", async () => {
		verifyResult = "verified";
		renderAt("/verify-email?token=good");
		const status = await screen.findByText(/Your email address is confirmed/);
		expect(status).not.toHaveTextContent("Sign in to continue.");

		await meAnswers(true);
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("You're all set."));
		expect(screen.getByRole("status")).not.toHaveTextContent("Sign in to continue.");
	});
});
