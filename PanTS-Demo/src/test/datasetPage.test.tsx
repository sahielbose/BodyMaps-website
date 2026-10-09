/**
 * Dataset page (/dashboard): case cards open and toggle from the keyboard,
 * the grid reveals as soon as its thumbnails load, toggles expose their
 * state, and empty, error and failed-facet states each say one accurate
 * thing with a way forward.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, type ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Preview from "../components/Preview";
import { track } from "../helpers/analytics";
import { AuthProvider } from "../contexts/authContext";
import Homepage from "../routes/Homepage";
import CaseGrid from "../routes/Homepage/components/CaseGrid";

vi.mock("../helpers/analytics", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../helpers/analytics")>();
	return { ...actual, track: vi.fn() };
});

const META = { sex: "F", age: 54, tumor: 1 as const };

function renderCard(ui: ReactElement) {
	return render(
		<MemoryRouter initialEntries={["/dashboard"]}>
			<Routes>
				<Route path="/dashboard" element={ui} />
				<Route path="/case/:caseId" element={<p>Case page</p>} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("case card", () => {
	it("is a real link that opens the case with Enter", async () => {
		const user = userEvent.setup();
		renderCard(<Preview id={17} previewMetadata={META} />);
		const link = screen.getByRole("link", { name: "PanTS_00000017" });
		expect(link).toHaveAttribute("href", "/case/17");
		await user.tab();
		expect(link).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(await screen.findByText("Case page")).toBeInTheDocument();
	});

	it("keeps the save and compare buttons in the tab order without a hover", async () => {
		const user = userEvent.setup();
		const onToggleSave = vi.fn();
		const onToggleCompare = vi.fn();
		renderCard(
			<Preview
				id={17}
				previewMetadata={META}
				onToggleSave={onToggleSave}
				onToggleCompare={onToggleCompare}
			/>,
		);
		const save = screen.getByRole("button", { name: "Save case 17" });
		const compare = screen.getByRole("button", { name: "Compare case 17" });
		expect(save).toHaveAttribute("aria-pressed", "false");
		expect(compare).toHaveAttribute("aria-pressed", "false");

		await user.tab();
		expect(save).toHaveFocus();
		await user.keyboard("{Enter}");
		expect(onToggleSave).toHaveBeenCalledTimes(1);
		await user.tab();
		expect(compare).toHaveFocus();
		await user.keyboard(" ");
		expect(onToggleCompare).toHaveBeenCalledTimes(1);
		await user.tab();
		expect(screen.getByRole("link", { name: "PanTS_00000017" })).toHaveFocus();
		// Toggling a control never opens the case.
		expect(screen.queryByText("Case page")).not.toBeInTheDocument();
	});

	it("reports the saved and selected state on the same names", () => {
		renderCard(
			<Preview
				id={17}
				previewMetadata={META}
				saved
				onToggleSave={() => {}}
				compareSelected
				onToggleCompare={() => {}}
			/>,
		);
		expect(screen.getByRole("button", { name: "Save case 17" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Compare case 17" })).toHaveAttribute("aria-pressed", "true");
	});

	it("leaves unrecorded sex and age off instead of printing a dash", () => {
		const { container } = renderCard(
			<Preview id={17} previewMetadata={{ sex: "", age: 0, tumor: 0 }} />,
		);
		expect(container.textContent).not.toMatch(/—/);
		expect(screen.queryByText(/^Sex/)).not.toBeInTheDocument();
		expect(screen.queryByText(/^Age/)).not.toBeInTheDocument();
		expect(screen.getByText("No tumor")).toBeInTheDocument();
	});

	it("says the preview is unavailable when both thumbnail sources fail", () => {
		renderCard(<Preview id={17} previewMetadata={META} />);
		// Local endpoint fails, then the HuggingFace proxy fails.
		fireEvent.error(screen.getByRole("img"));
		fireEvent.error(screen.getByRole("img"));
		expect(screen.getByText("Preview unavailable")).toBeInTheDocument();
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});
});

// Fires every thumbnail's load event during the commit, before any passive
// effect runs, the way already-cached images can in a browser.
function LoadThumbnailsEarly() {
	useLayoutEffect(() => {
		document.querySelectorAll("img").forEach((img) => fireEvent.load(img));
	});
	return null;
}

const gridProps = {
	showSaved: false,
	savedCases: [],
	skeletonCount: 8,
	resultCount: null,
	hasFilters: false,
	onResetFilters: () => {},
	savedIds: new Set<number>(),
	compareIds: [],
	onToggleSave: () => {},
	onToggleCompare: () => {},
};

describe("case grid", () => {
	it("reveals a batch as soon as every thumbnail has loaded", () => {
		vi.useFakeTimers();
		try {
			const { container } = render(
				<MemoryRouter>
					<CaseGrid
						{...gridProps}
						loading={false}
						previewIds={[1, 2, 3]}
						previewMetadata={{ 1: META, 2: META, 3: META }}
					/>
					<LoadThumbnailsEarly />
				</MemoryRouter>,
			);
			// No waiting on the 2.5 s safety cap.
			expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
			expect(container.querySelectorAll("img.is-shown")).toHaveLength(3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows as many skeletons as cards are coming", () => {
		const { container } = render(
			<MemoryRouter>
				<CaseGrid
					{...gridProps}
					loading
					skeletonCount={16}
					previewIds={[]}
					previewMetadata={{}}
				/>
			</MemoryRouter>,
		);
		expect(container.querySelectorAll(".bm-card-skeleton")).toHaveLength(16);
	});

	it("offers Clear filters when applied filters match nothing", () => {
		const onResetFilters = vi.fn();
		render(
			<MemoryRouter>
				<CaseGrid
					{...gridProps}
					loading={false}
					resultCount={0}
					hasFilters
					onResetFilters={onResetFilters}
					previewIds={[]}
					previewMetadata={{}}
				/>
			</MemoryRouter>,
		);
		expect(screen.getByText("No cases match these filters.")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(onResetFilters).toHaveBeenCalledTimes(1);
	});

	it("words the empty saved list without a dash", () => {
		const { container } = render(
			<MemoryRouter>
				<CaseGrid {...gridProps} showSaved loading={false} previewIds={[]} previewMetadata={{}} />
			</MemoryRouter>,
		);
		expect(container.textContent).toMatch(/^No saved cases yet\. /);
		expect(container.textContent).not.toMatch(/—/);
	});
});

// ── The whole page, with the API stubbed per endpoint ──

type Reply = { status?: number; body?: unknown };
let replies: { search: Reply; facets: Reply };

const json = ({ status = 200, body = {} }: Reply) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

const EMPTY = { items: [], total: 0 };

beforeEach(() => {
	localStorage.clear();
	replies = { search: { body: EMPTY }, facets: { body: {} } };
	global.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/api/facets")) return json(replies.facets);
		// The featured strip asks for tumor=1 and tumor=0 with no dataset param.
		if (url.includes("/api/search") && url.includes("dataset=")) return json(replies.search);
		if (url.includes("/api/search") || url.includes("/api/random")) return json({ body: EMPTY });
		return json({ body: {} });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	vi.restoreAllMocks();
});

const renderPage = () =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={["/dashboard"]}>
				<Homepage />
			</MemoryRouter>
		</AuthProvider>,
	);

describe("dataset page", () => {
	it("has a main landmark and an h1", async () => {
		renderPage();
		expect(screen.getByRole("main")).toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 1, name: "Browse the library" })).toBeInTheDocument();
		await screen.findByText("No cases are available right now.");
	});

	it("gives an empty dataset one accurate message and logs no error", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		renderPage();
		expect(await screen.findByText("No cases are available right now.")).toBeInTheDocument();
		expect(screen.queryByText(/Could not load cases/)).not.toBeInTheDocument();
		expect(errors).not.toHaveBeenCalled();

		// Browse all with no filters: the same message, not "match these filters".
		fireEvent.click(screen.getByRole("button", { name: "Browse all" }));
		await waitFor(() =>
			expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining("dataset=all")),
		);
		expect(await screen.findByText("No cases are available right now.")).toBeInTheDocument();
		expect(screen.queryByText(/match these filters/)).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
	});

	it("shows a readable Retry when the case list fails, and retries", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		replies.search = { status: 500, body: { error: "boom" } };
		renderPage();
		await screen.findByText("No cases are available right now.");
		fireEvent.click(screen.getByRole("button", { name: "Browse all" }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("Could not load cases.");
		const retry = within(alert).getByRole("button", { name: "Retry" });

		replies.search = { body: EMPTY };
		const calls = vi.mocked(global.fetch).mock.calls.length;
		fireEvent.click(retry);
		await waitFor(() => expect(vi.mocked(global.fetch).mock.calls.length).toBeGreaterThan(calls));
		expect(await screen.findByText("No cases are available right now.")).toBeInTheDocument();
	});

	it("labels the search input and exposes the filter toggle's state", async () => {
		renderPage();
		expect(screen.getByRole("textbox", { name: "Search by case ID" })).toBeInTheDocument();
		const toggle = screen.getByRole("button", { name: /Advanced filters/ });
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(toggle).not.toHaveAttribute("aria-controls");

		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		const panelId = toggle.getAttribute("aria-controls");
		expect(panelId).toBeTruthy();
		expect(document.getElementById(panelId!)).toBeInTheDocument();
		await screen.findByText("No cases are available right now.");
	});

	it("marks the chosen filter pill with aria-pressed", async () => {
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: /Advanced filters/ }));
		const sex = screen.getByRole("group", { name: "Sex" });
		const any = within(sex).getByRole("button", { name: "Any" });
		const male = within(sex).getByRole("button", { name: /^Male/ });
		expect(any).toHaveAttribute("aria-pressed", "true");
		expect(male).toHaveAttribute("aria-pressed", "false");

		fireEvent.click(male);
		expect(male).toHaveAttribute("aria-pressed", "true");
		expect(any).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByRole("group", { name: "CT phase" })).toBeInTheDocument();
		await screen.findByText("No cases are available right now.");
	});

	it("counts a search whether it starts from Search or from Apply filters", async () => {
		vi.mocked(track).mockClear();
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: /Advanced filters/ }));
		fireEvent.click(within(screen.getByRole("group", { name: "Sex" })).getByRole("button", { name: /^Male/ }));
		fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
		expect(track).toHaveBeenCalledTimes(1);
		expect(track).toHaveBeenCalledWith("dataset_search");

		// Search with filters applies them once, so it is one search, not two.
		vi.mocked(track).mockClear();
		fireEvent.click(screen.getByRole("button", { name: "Search" }));
		expect(track).toHaveBeenCalledTimes(1);
		await screen.findByText(/No cases/);
	});

	it("shows an error with Retry when the facet options fail to load", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		replies.facets = { status: 400, body: { error: "bad" } };
		renderPage();
		fireEvent.click(screen.getByRole("button", { name: /Advanced filters/ }));

		const manufacturer = screen.getByRole("group", { name: "Manufacturer" });
		// One message and one Retry above the groups, not one per group.
		expect(await screen.findByText(/Couldn't load options/)).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);

		replies.facets = {
			body: { facets: { manufacturer: [{ value: "SIEMENS", count: 12 }] }, total: 12 },
		};
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await within(manufacturer).findByRole("button", { name: /SIEMENS/ })).toBeInTheDocument();
		// A group the dataset has no values for says so in words.
		expect(within(screen.getByRole("group", { name: "Site" })).getByText("None recorded")).toBeInTheDocument();
	});

	it("keeps one search button whose label names what it will do", async () => {
		const user = userEvent.setup();
		renderPage();
		const input = screen.getByRole("textbox", { name: "Search by case ID" });
		const button = screen.getByRole("button", { name: "Search" });
		await user.type(input, "17123");
		expect(button).toHaveAccessibleName("Go to case");
		await user.clear(input);
		expect(button).toHaveAccessibleName("Search");
		await screen.findByText("No cases are available right now.");
	});

	it("announces an invalid case ID through a region that was already there", async () => {
		const user = userEvent.setup();
		renderPage();
		const input = screen.getByRole("textbox", { name: "Search by case ID" });
		const region = document.querySelector<HTMLElement>("p[aria-live='polite']");
		expect(region).toBeInTheDocument();
		expect(region).toBeEmptyDOMElement();

		await user.type(input, "99999");
		await act(async () => {
			fireEvent.keyDown(input, { key: "Enter" });
		});
		expect(region).toHaveTextContent("Case IDs are 1 to 9901.");
		expect(input).toHaveAttribute("aria-invalid", "true");
		await screen.findByText("No cases are available right now.");
	});
});

// ── Where the paged list is, kept in the URL ──

/** 50 cases, 16 to a page: four pages, each reply the page that was asked for. */
function stubPagedSearch() {
	global.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/api/search") && url.includes("dataset=")) {
			const page = Number(new URL(url, "http://localhost").searchParams.get("page") ?? "1");
			const items = Array.from({ length: 16 }, (_, i) => ({
				case_id: (page - 1) * 16 + i + 1, tumor: 1, sex: "F", age: 50,
			}));
			return json({ body: { items, total: 50, page } });
		}
		if (url.includes("/api/search") || url.includes("/api/random")) return json({ body: EMPTY });
		return json({ body: {} });
	}) as unknown as typeof fetch;
}

const searchedPages = () =>
	vi.mocked(global.fetch).mock.calls
		.map(([input]) => String(input))
		.filter((url) => url.includes("/api/search") && url.includes("dataset="))
		.map((url) => new URL(url, "http://localhost").searchParams.get("page"));

function Where() {
	const { pathname, search } = useLocation();
	return <output data-testid="where">{pathname + search}</output>;
}

function CaseStub() {
	const navigate = useNavigate();
	return <button type="button" onClick={() => navigate(-1)}>Back</button>;
}

const renderWithCase = (entry = "/dashboard") =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[entry]}>
				<Routes>
					<Route path="/dashboard" element={<Homepage />} />
					<Route path="/case/:caseId" element={<CaseStub />} />
				</Routes>
				<Where />
			</MemoryRouter>
		</AuthProvider>,
	);

describe("dataset page position in the URL", () => {
	beforeEach(() => {
		stubPagedSearch();
		vi.spyOn(window, "scrollTo").mockImplementation(() => {});
	});

	it("comes back to the same page of Browse all after opening a case", async () => {
		const user = userEvent.setup();
		renderWithCase();
		await user.click(await screen.findByRole("button", { name: "Browse all" }));
		await screen.findAllByText(/Page 1 of 4/);
		expect(screen.getByTestId("where")).toHaveTextContent("/dashboard?browse=1");

		await user.click(screen.getByRole("button", { name: /Next/ }));
		await screen.findAllByText(/Page 2 of 4/);
		expect(screen.getByTestId("where")).toHaveTextContent("/dashboard?browse=1&page=2");

		await user.click(await screen.findByRole("link", { name: "PanTS_00000017" }));
		await user.click(await screen.findByRole("button", { name: "Back" }));

		expect(await screen.findAllByText(/Page 2 of 4/)).not.toHaveLength(0);
		expect(await screen.findByRole("link", { name: "PanTS_00000017" })).toBeInTheDocument();
		expect(searchedPages().at(-1)).toBe("2");
	});

	it("opens a filtered link at the page it names", async () => {
		renderWithCase("/dashboard?dataset=pants&tumor=1&page=3");
		expect(await screen.findAllByText(/Page 3 of 4/)).not.toHaveLength(0);
		expect(searchedPages()).toEqual(["3"]);
	});

	it("keeps filter links without a page working, at page 1", async () => {
		renderWithCase("/dashboard?dataset=pants&tumor=1");
		expect(await screen.findAllByText(/Page 1 of 4/)).not.toHaveLength(0);
		expect(searchedPages()).toEqual(["1"]);
	});
});

describe("filter pills", () => {
  it("keeps a selected pill's border when it is hovered", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/routes/Homepage/components/FilterPanel/FilterPanel.module.css"),
      "utf8",
    );
    const start = css.indexOf(".pillActive:hover {");
    expect(start).toBeGreaterThanOrEqual(0);
    // .pill:hover sets a faded border and outranks .pillActive, so the
    // selected border has to be restated for the hovered, selected pill.
    expect(css.slice(start, css.indexOf("}", start))).toMatch(/border-color:\s*#002d72/);
  });
});
