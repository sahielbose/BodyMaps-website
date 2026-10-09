import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../contexts/authContext";
import { NONCLINICAL_WARNING } from "../helpers/copy";
import SharePatientCard from "../routes/SharePatientCard";

const REPORT = {
	case_id: "35",
	patient: { age: 60, sex: "F" },
	imaging: { study_type: "CT", contrast: "venous", spacing: [1, 1, 1], shape: [1, 1, 1] },
	organ_volumes: {
		pancreas: { volume: 80, mean_hu: 40, status: "check" },
		kidney_left: { volume: 150, mean_hu: 30, status: "check" },
		liver: { volume: 1500, mean_hu: 55, status: "normal" },
	},
	lesions: {},
	comments: "",
	impression: [],
};

const stubShare = (payload: unknown) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const data = url.includes("/api/share/") ? payload : {};
			return { ok: true, status: 200, json: async () => data };
		})
	);

// The broken-link page carries the site header, which needs the auth context.
const renderAt = (path: string) =>
	render(
		<AuthProvider>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/share/:shareId" element={<SharePatientCard />} />
				</Routes>
			</MemoryRouter>
		</AuthProvider>
	);

afterEach(() => vi.unstubAllGlobals());

describe("SharePatientCard", () => {
	it("makes the finding chips keyboard-reachable toggle buttons", async () => {
		stubShare(REPORT);
		const user = userEvent.setup();
		renderAt("/share/token");

		const group = await screen.findByRole("group", { name: "Flagged organs" });
		expect(group).toBeInTheDocument();
		const pancreas = screen.getByRole("button", { name: "Pancreas" });
		const kidney = screen.getByRole("button", { name: "Left kidney" });
		expect(pancreas).toHaveAttribute("aria-pressed", "true");
		expect(kidney).toHaveAttribute("aria-pressed", "false");

		kidney.focus();
		await user.keyboard("{Enter}");
		expect(kidney).toHaveAttribute("aria-pressed", "true");
		expect(pancreas).toHaveAttribute("aria-pressed", "false");
		expect(screen.getByRole("heading", { level: 2, name: "Left kidney" })).toBeInTheDocument();
	});

	it("uses nonclinical wording, a heading, and the nonclinical notice in the footer", async () => {
		stubShare(REPORT);
		renderAt("/share/token");

		expect(await screen.findByRole("heading", { level: 1, name: /2 organs flagged for review/ })).toBeInTheDocument();
		expect(screen.getByRole("main")).toBeInTheDocument();
		// The notice is said once, in the site footer under the card.
		expect(screen.getByRole("contentinfo")).toHaveTextContent(NONCLINICAL_WARNING);
		expect(screen.queryByText(/radiology impression/i)).toBeNull();
		expect(screen.queryByText(/healthy/i)).toBeNull();
		// No empty placeholder where an organ image or shield was meant to go.
		expect(screen.queryByAltText("Johns Hopkins University")).toBeNull();
		expect(document.body.textContent).not.toMatch(/—/);
	});

	it("turns a broken link into a branded page with a way back", async () => {
		stubShare({ error: "Invalid or expired share link" });
		renderAt("/share/does-not-exist");

		expect(await screen.findByRole("heading", { level: 1, name: "This report link isn't available" })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Browse the dataset" })).toHaveAttribute("href", "/dashboard");
		expect(screen.getByRole("contentinfo")).toHaveTextContent(/nonclinical use only/i);
	});

	it("draws the QR code on the page, so the share link never goes to a QR service", async () => {
		stubShare(REPORT);
		renderAt("/share/token");

		const qr = await screen.findByRole("img", { name: "QR code to this BodyMap" });
		expect(qr.tagName.toLowerCase()).toBe("svg");
		expect(qr.querySelector("path")?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
		expect(document.querySelector("img[src*='qrserver']")).toBeNull();
		const requested = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
		expect(requested.every((url) => !url.includes("qr"))).toBe(true);
	});
});
