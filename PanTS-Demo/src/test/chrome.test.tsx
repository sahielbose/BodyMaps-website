/**
 * Site chrome: the page surface colour before the app mounts, the sticky
 * header and footer, the floating scroll-to-top button, the mobile nav drawer
 * and the account control in the nav.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuthButton from "../components/AuthButton";
import AuthModal from "../components/AuthModal";
import Header from "../components/Header";
import ScrollToTopButton from "../components/ScrollToTopButton";
import SiteFooter from "../components/SiteFooter";
import { AuthProvider } from "../contexts/authContext";
import { DARK_ROUTE_CLASS, DARK_ROUTE_PATTERN, isDarkRoute } from "../helpers/routeSurface";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const json = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => "",
	headers: { get: () => "application/json" },
});

let meUser: Record<string, unknown> | null = null;
const originalMatchMedia = window.matchMedia;

beforeEach(() => {
	meUser = null;
	localStorage.clear();
	document.body.style.overflow = "";
	global.fetch = vi.fn(async (url: RequestInfo | URL) => {
		const u = String(url);
		if (u.includes("/api/auth/me")) return json({ user: meUser });
		if (u.includes("/api/auth/oauth/providers")) return json({ google: true, github: true });
		return json({});
	}) as unknown as typeof fetch;
});

afterEach(() => {
	window.matchMedia = originalMatchMedia;
	vi.restoreAllMocks();
});

describe("page surface before the app mounts", () => {
	it("index.html paints the dark routes with the same pattern the app uses", () => {
		const html = read("index.html");
		expect(html).toContain(DARK_ROUTE_PATTERN.source);
		expect(html).toContain(`classList.add("${DARK_ROUTE_CLASS}")`);
	});

	it("marks only the viewer-type routes dark", () => {
		for (const path of ["/case/1", "/session/abc", "/reconstruction/7", "/live/r1", "/live/challenge/c",
			"/learn/quiz/p", "/dicom", "/local-nifti", "/compare", "/compare-viewer"]) {
			expect(isDarkRoute(path), path).toBe(true);
		}
		for (const path of ["/", "/dashboard", "/upload", "/team", "/contact", "/terms", "/privacy", "/account",
			"/account/plan", "/share/abc", "/reset-password", "/verify-email", "/nope"]) {
			expect(isDarkRoute(path), path).toBe(false);
		}
	});

	it("the body is light by default rather than dark navy", () => {
		const css = read("src/index.css");
		const body = css.slice(css.indexOf("\nbody {"), css.indexOf("}", css.indexOf("\nbody {")));
		expect(body).toContain("background: var(--paper)");
		expect(body).not.toContain("min-width");
		expect(css).toContain(`html.${DARK_ROUTE_CLASS} body`);
	});

	it("#root clips sideways overflow without becoming a scroll container (sticky header and footer)", () => {
		const css = read("src/App.css");
		const root = css.slice(css.indexOf("#root {"), css.indexOf("}", css.indexOf("#root {")));
		expect(root).toMatch(/overflow-x:\s*clip/);
	});

	it("the nav's outer columns are equal, so the tabs sit on the page's centre line", () => {
		const css = read("src/components/Header/Header.module.css");
		const nav = css.slice(css.indexOf(".nav {"), css.indexOf("}", css.indexOf(".nav {")));
		expect(nav).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(0, 1fr\)/);
	});

	it("buttons show a focus ring for the keyboard only, not after a click", () => {
		const css = read("src/index.css");
		expect(css).not.toMatch(/button:focus\s*,/);
		expect(css).toMatch(/button:focus-visible\s*\{\s*outline: 2px solid var\(--focus-ring\)/);
	});
});

const renderScrollButton = (path = "/team") =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<button type="button">Before</button>
			<ScrollToTopButton />
			<SiteFooter />
		</MemoryRouter>,
	);

const scrollWindowTo = (y: number) => {
	Object.defineProperty(window, "scrollY", { configurable: true, value: y });
	fireEvent.scroll(document);
};

describe("scroll-to-top button", () => {
	afterEach(() => {
		Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
	});

	it("is out of the tab order and the accessibility tree until the page is scrolled", () => {
		renderScrollButton();
		const button = document.querySelector("button[aria-label='Scroll to top']") as HTMLButtonElement;
		expect(button).toHaveAttribute("inert");
		expect(button).toHaveAttribute("aria-hidden", "true");
		expect(screen.queryByRole("button", { name: "Scroll to top" })).toBeNull();

		scrollWindowTo(600);
		const shown = screen.getByRole("button", { name: "Scroll to top" });
		expect(shown).not.toHaveAttribute("inert");
		expect(shown).not.toHaveAttribute("aria-hidden");
	});

	it("comes after the page in the DOM, so it is the last tab stop, not the first", () => {
		const app = read("src/App.tsx");
		expect(app.indexOf("<ScrollToTopButton />")).toBeGreaterThan(app.indexOf("</Suspense>"));
	});

	it("jumps without smooth scrolling for reduced motion", () => {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: query.includes("prefers-reduced-motion"),
			media: query,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})) as unknown as typeof window.matchMedia;
		const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
		renderScrollButton();
		scrollWindowTo(600);
		fireEvent.click(screen.getByRole("button", { name: "Scroll to top" }));
		expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
	});

	it("rises above the footer while the footer is on screen", () => {
		renderScrollButton();
		const footer = document.querySelector("[data-site-footer]") as HTMLElement;
		vi.spyOn(footer, "getBoundingClientRect").mockReturnValue({
			top: window.innerHeight - 60,
		} as DOMRect);
		scrollWindowTo(600);
		const button = screen.getByRole("button", { name: "Scroll to top" });
		expect(button.style.getPropertyValue("--footer-lift")).toBe("60px");
	});

	it("hides again on the next page when the page scrolled was an inner container", async () => {
		// A page that scrolls a full-height inner div (like the overview on a
		// short window), with a link to a page that doesn't scroll at all.
		function Pages() {
			const { pathname } = useLocation();
			const navigate = useNavigate();
			return (
				<>
					{pathname === "/dashboard" && <div data-testid="scroller" />}
					<button type="button" onClick={() => navigate("/team")}>Team</button>
				</>
			);
		}
		render(
			<MemoryRouter initialEntries={["/dashboard"]}>
				<Pages />
				<ScrollToTopButton />
			</MemoryRouter>,
		);
		const scroller = screen.getByTestId("scroller");
		Object.defineProperty(scroller, "clientHeight", { configurable: true, value: window.innerHeight });
		Object.defineProperty(scroller, "scrollTop", { configurable: true, value: 400 });
		fireEvent.scroll(scroller);
		expect(screen.getByRole("button", { name: "Scroll to top" })).toBeInTheDocument();

		// The new page starts at the top and the old scroller is gone; no
		// scroll event fires for that, so the button must re-check by itself.
		fireEvent.click(screen.getByRole("button", { name: "Team" }));
		const button = document.querySelector("button[aria-label='Scroll to top']") as HTMLButtonElement;
		await waitFor(() => expect(button).toHaveAttribute("inert"));
		expect(button).toHaveAttribute("aria-hidden", "true");
	});
});

/** A matchMedia whose "change" listeners the test can fire. */
function controllableMatchMedia(initial: boolean) {
	const listeners = new Set<() => void>();
	const mq = {
		matches: initial,
		media: "",
		addEventListener: (_: string, cb: () => void) => listeners.add(cb),
		removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
	};
	window.matchMedia = vi.fn(() => mq) as unknown as typeof window.matchMedia;
	return {
		set(matches: boolean) {
			mq.matches = matches;
			listeners.forEach((cb) => cb());
		},
	};
}

const renderHeader = (withModal = false) =>
	render(
		<AuthProvider>
			<MemoryRouter>
				<Header />
				<a href="#behind">Behind the drawer</a>
				{withModal && <AuthModal />}
			</MemoryRouter>
		</AuthProvider>,
	);

describe("mobile nav drawer", () => {
	it("keeps Tab and Shift+Tab inside and gives focus back to the hamburger", async () => {
		const user = userEvent.setup();
		renderHeader();
		await screen.findByRole("button", { name: "Sign in" });
		const hamburger = screen.getByRole("button", { name: "Open menu" });
		await user.click(hamburger);

		const drawer = screen.getByRole("dialog", { name: "BodyMaps" });
		expect(document.activeElement).toBe(within(drawer).getByRole("button", { name: "Close menu" }));
		expect(document.body.style.overflow).toBe("hidden");

		for (let i = 0; i < 8; i++) {
			await user.tab();
			expect(drawer.contains(document.activeElement)).toBe(true);
		}
		await user.tab({ shift: true });
		expect(drawer.contains(document.activeElement)).toBe(true);

		await user.keyboard("{Escape}");
		expect(document.activeElement).toBe(hamburger);
		expect(document.body.style.overflow).toBe("");
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("closes and frees the page when the window grows past the phone layout", async () => {
		const media = controllableMatchMedia(true);
		const user = userEvent.setup();
		renderHeader();
		await user.click(screen.getByRole("button", { name: "Open menu" }));
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(document.body.style.overflow).toBe("hidden");

		act(() => media.set(false));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.body.style.overflow).toBe("");
	});

	it("lifts the header above the scroll-to-top button while the drawer is up", async () => {
		const user = userEvent.setup();
		renderHeader();
		const header = document.querySelector("header") as HTMLElement;
		const resting = header.className;
		await user.click(screen.getByRole("button", { name: "Open menu" }));
		expect(header.className).not.toBe(resting);

		// The drawer's own z-index only counts inside the header's stacking
		// context, so the header itself has to outrank the button (--z-dropdown).
		const css = read("src/components/Header/Header.module.css");
		expect(css).toMatch(/\.headerRoot\.drawerOpen\s*\{\s*z-index:\s*calc\(var\(--z-modal\) - 1\)/);
		const button = read("src/components/ScrollToTopButton/ScrollToTopButton.module.css");
		expect(button).toMatch(/z-index:\s*var\(--z-dropdown\)/);

		await user.keyboard("{Escape}");
		await waitFor(() => expect(header.className).toBe(resting));
	});

	it("opens the account dropdown upwards from the bottom of the drawer", async () => {
		meUser = { id: "u1", email: "ada@example.com", name: "Ada", plan: "free" };
		const user = userEvent.setup();
		renderHeader();
		const topBar = await screen.findByRole("button", { name: /ada/i });
		await user.click(topBar);
		const below = document.getElementById(topBar.getAttribute("aria-controls")!) as HTMLElement;
		expect(below.className).not.toMatch(/menuUp/);
		await user.click(topBar);

		await user.click(screen.getByRole("button", { name: "Open menu" }));
		const drawer = screen.getByRole("dialog", { name: "BodyMaps" });
		const trigger = within(drawer).getByRole("button", { name: /ada/i });
		await user.click(trigger);
		const above = document.getElementById(trigger.getAttribute("aria-controls")!) as HTMLElement;
		expect(above.className).toMatch(/menuUp/);
		expect(within(above).getByRole("button", { name: "Sign out" })).toBeInTheDocument();

		const css = read("src/components/AuthButton.module.css");
		expect(css).toMatch(/\.menuUp\s*\{\s*top:\s*auto;\s*bottom:\s*calc\(100% \+ 8px\)/);
	});

	it("slides out before it unmounts, inert while it goes", async () => {
		const user = userEvent.setup();
		renderHeader();
		await user.click(screen.getByRole("button", { name: "Open menu" }));
		await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close menu" }));
		const leaving = document.querySelector("aside");
		expect(leaving).toHaveAttribute("inert");
		await waitFor(() => expect(document.querySelector("aside")).toBeNull());
	});

	it("Sign in from the drawer closes it and opens the popup, which hands focus back to the hamburger", async () => {
		const user = userEvent.setup();
		renderHeader(true);
		await screen.findByRole("button", { name: "Sign in" });
		const hamburger = screen.getByRole("button", { name: "Open menu" });
		await user.click(hamburger);
		const drawer = screen.getByRole("dialog", { name: "BodyMaps" });
		await user.click(within(drawer).getByRole("button", { name: "Sign in" }));

		const modal = await screen.findByRole("dialog", { name: "Sign in" });
		await waitFor(() => expect(document.querySelector("aside")).toBeNull());
		expect(modal.contains(document.activeElement)).toBe(true);
		expect(document.body.style.overflow).toBe("hidden");

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(hamburger);
		expect(document.body.style.overflow).toBe("");
	});
});

describe("account control in the nav", () => {
	it("holds the Sign in button's footprint while the sign-in check is in flight", async () => {
		let answerMe: (value: unknown) => void = () => {};
		global.fetch = vi.fn((url: RequestInfo | URL) => {
			if (String(url).includes("/api/auth/me")) {
				return new Promise((r) => {
					answerMe = r;
				});
			}
			return Promise.resolve(json({ google: true, github: true }));
		}) as unknown as typeof fetch;

		render(
			<AuthProvider>
				<MemoryRouter>
					<AuthButton />
				</MemoryRouter>
			</AuthProvider>,
		);
		const placeholder = document.querySelector("[data-auth-placeholder]") as HTMLElement;
		expect(placeholder).not.toBeNull();
		expect(placeholder).toHaveAttribute("aria-hidden", "true");
		expect(placeholder).toHaveTextContent("Sign in");
		expect(screen.queryByRole("button")).toBeNull();

		await act(async () => answerMe(json({ user: null })));
		const button = await screen.findByRole("button", { name: "Sign in" });
		// Same class as the button it stands in for, so the same width.
		expect(placeholder.className.split(" ")).toContain(button.className);
		expect(document.querySelector("[data-auth-placeholder]")).toBeNull();
	});

	it("is a plain disclosure: no menu roles, Escape closes it and returns focus", async () => {
		meUser = { id: "u1", email: "ada@example.com", name: "Ada", plan: "free" };
		const user = userEvent.setup();
		render(
			<AuthProvider>
				<MemoryRouter>
					<AuthButton />
				</MemoryRouter>
			</AuthProvider>,
		);
		const trigger = await screen.findByRole("button", { name: /ada/i });
		expect(trigger).not.toHaveAttribute("aria-haspopup");
		trigger.focus();
		await user.keyboard("{Enter}");
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(screen.queryByRole("menu")).toBeNull();
		expect(screen.queryByRole("menuitem")).toBeNull();

		await user.tab();
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Account settings" }));
		await user.keyboard("{Escape}");
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(document.activeElement).toBe(trigger);
	});
});
