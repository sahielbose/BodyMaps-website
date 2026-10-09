import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ComparePage from "../routes/ComparePage";

const NORMS = {
	version: 1,
	min_n: 1,
	percentile_grid: [0, 50, 100],
	organs: { liver: { "M|60-69": { n: 100, q: [1000, 1500, 2000] } } },
};

// Different liver volume per case so a real delta shows. Case 3 has a snake_case organ
// id to check the table shows a readable name; 99999999 does not exist.
const METRICS: Record<string, unknown> = {
	"1": { organ_metrics: [{ organ_name: "liver", volume_cm3: 1500, mean_hu: 52 }] },
	"2": { organ_metrics: [{ organ_name: "liver", volume_cm3: 1725, mean_hu: 54 }] },
	"3": { organ_metrics: [{ organ_name: "adrenal_gland_left", volume_cm3: 5, mean_hu: 30 }] },
	"99999999": { error: "Case not found" },
};

beforeEach(() => {
	global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const body = (data: unknown) => ({
			ok: true,
			status: 200,
			json: async () => data,
			text: async () => "",
			blob: async () => new Blob(),
			arrayBuffer: async () => new ArrayBuffer(0),
			headers: { get: () => "application/json" },
		});
		if (url.includes("/organ_norms.json")) return body(NORMS);
		if (url.includes("/api/search")) return body({ items: [{ sex: "M", age: 66, tumor: 0 }] });
		if (url.includes("/api/mask-data")) {
			const key = String((init?.body as FormData)?.get?.("sessionKey") ?? "");
			return body(METRICS[key] ?? { organ_metrics: [] });
		}
		return body({});
	}) as unknown as typeof fetch;
});

afterEach(() => vi.clearAllMocks());

const renderAt = (path: string) =>
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="/compare" element={<ComparePage />} />
			</Routes>
		</MemoryRouter>
	);

describe("ComparePage", () => {
	it("shows two cases' organ volumes side by side with a delta", async () => {
		renderAt("/compare?a=1&b=2");

		// The stats table now lives in a popup — open it first.
		fireEvent.click(await screen.findByText(/View organ statistics/));

		// Both cases' liver volumes appear…
		expect(await screen.findByText("1500 cm³")).toBeTruthy();
		expect(await screen.findByText("1725 cm³")).toBeTruthy();
		// …and the volume delta (B − A = +225).
		expect(await screen.findByText("+225 cm³")).toBeTruthy();
		// …and the mean HU delta (B − A = 54 - 52 = +2).
		expect(await screen.findByText("+2 HU mean")).toBeTruthy();
	});

	it("prompts when only one case id is provided", async () => {
		renderAt("/compare?a=1");
		expect(await screen.findByText(/Enter two case ids/i)).toBeTruthy();
	});

	it("is a viewer-family page: its own bar with a main landmark, a sentence-case h1 and a way back, no site chrome", async () => {
		renderAt("/compare?a=1&b=2");
		expect(screen.getByRole("main")).toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 1, name: "Compare cases" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Back to the dataset" })).toHaveAttribute("href", "/dashboard");
		expect(screen.queryByRole("banner")).toBeNull();
		expect(screen.queryByRole("contentinfo")).toBeNull();
		await screen.findByText(/View organ statistics/);
	});

	it("moves focus into the stats dialog, keeps Tab inside, and Escape returns focus to the trigger", async () => {
		const user = userEvent.setup();
		renderAt("/compare?a=1&b=2");
		const trigger = await screen.findByRole("button", { name: /View organ statistics/ });
		await user.click(trigger);

		const dialog = screen.getByRole("dialog", { name: "Organ statistics" });
		expect(dialog).toContainElement(document.activeElement as HTMLElement);

		// Tab through every stop and past the end: focus never leaves the dialog.
		for (let i = 0; i < 6; i++) {
			await user.tab();
			expect(dialog).toContainElement(document.activeElement as HTMLElement);
		}
		await user.tab({ shift: true });
		expect(dialog).toContainElement(document.activeElement as HTMLElement);

		await user.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(document.activeElement).toBe(trigger);
	});

	it("shows readable organ names in the stats table, not snake_case ids", async () => {
		renderAt("/compare?a=3&b=3");
		fireEvent.click(await screen.findByText(/View organ statistics/));
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Adrenal gland left")).toBeInTheDocument();
		expect(within(dialog).queryByText(/adrenal_gland_left/)).toBeNull();
	});

	it("says which case failed and offers no half-empty stats table when one case fails", async () => {
		renderAt("/compare?a=99999999&b=2");
		const status = screen.getByRole("status");
		await waitFor(() =>
			expect(status).toHaveTextContent("Organ statistics couldn't be loaded for case 99999999")
		);
		expect(screen.queryByRole("button", { name: /View organ statistics/ })).toBeNull();
		// The failed case's own card says so too; the other case is not blamed.
		expect(screen.getAllByText(/couldn't be loaded for this case/)).toHaveLength(1);
		expect(status).not.toHaveTextContent("case 2");
	});
});
