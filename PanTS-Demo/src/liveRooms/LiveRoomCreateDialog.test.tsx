import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import LiveRoomCreateDialog from "./LiveRoomCreateDialog";

function LocationProbe() {
	const location = useLocation();
	return <output aria-label="Current route">{JSON.stringify({ pathname: location.pathname, hash: location.hash, state: location.state })}</output>;
}

function renderDialog(caseId = "35") {
	return render(
		<MemoryRouter initialEntries={[`/case/${caseId}`]}>
			<LiveRoomCreateDialog caseId={caseId} open onClose={vi.fn()} />
			<LocationProbe />
		</MemoryRouter>,
	);
}

describe("Live Room mode menu", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		sessionStorage.clear();
	});

	it("offers the curated Case 35 solo challenge and Individual Race", () => {
		renderDialog();

		const solo = screen.getByRole("button", { name: /Solo Challenge/i });
		expect(solo).toBeEnabled();
		const race = screen.getByRole("button", { name: /Individual Race/i });
		expect(race).toBeEnabled();
		fireEvent.click(race);
		expect(screen.getByRole("heading", { name: "Start an individual race" })).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "30 seconds" })).toBeChecked();

		fireEvent.click(screen.getByRole("button", { name: /Back to room modes/i }));
		fireEvent.click(screen.getByRole("button", { name: /Solo Challenge/i }));
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/live/challenge/pancreas-case-35");
	});

	it("offers playlist races outside Case 35", () => {
		renderDialog("34");
		const race = screen.getByRole("button", { name: /Individual Race/i });
		expect(race).toBeEnabled();
		fireEvent.click(race);
		expect(screen.getByRole("radio", { name: /Case 35/i })).toBeDisabled();
	});

	it("preserves the existing collaborative room form", () => {
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: /Collaborative Review/i }));

		expect(screen.getByRole("heading", { name: "Start a live room" })).toBeInTheDocument();
		expect(screen.getByLabelText("Display name")).toBeInTheDocument();
	});

	it("passes a quiz host claim only through navigation state", async () => {
		vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			if (!init?.method) return Promise.resolve(new Response(JSON.stringify({ playlists: [] }), { status: 200 }));
			return Promise.resolve(new Response(JSON.stringify({
				room_id: "room-35",
				case_id: "35",
				room_key: "room/key",
				quiz_host_claim: "one-time-claim",
				quiz_host_secret: "legacy-alias",
			}), { status: 201, headers: { "Content-Type": "application/json" } }));
		}));
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: /Individual Race/i }));
		fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Creator" } });
		fireEvent.click(screen.getByRole("button", { name: "Create race room" }));

		await waitFor(() => expect(screen.getByLabelText("Current route")).toHaveTextContent("/live/room-35"));
		const route = screen.getByLabelText("Current route").textContent || "";
		expect(route).toContain('"hash":"#room%2Fkey"');
		expect(route).toContain('"quizHostCredential":{"mode":"modern","value":"one-time-claim"}');
		expect(route).not.toContain("legacy-alias");
		const storedValues = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index) || ""));
		expect(storedValues).not.toContain("one-time-claim");
	});

	it("falls back to the old REST host secret without treating it as a modern claim", async () => {
		vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			if (!init?.method) return Promise.resolve(new Response(JSON.stringify({ playlists: [] }), { status: 200 }));
			return Promise.resolve(new Response(JSON.stringify({
				room_id: "legacy-room",
				case_id: "35",
				room_key: "legacy/key",
				quiz_host_secret: "legacy-secret",
			}), { status: 201, headers: { "Content-Type": "application/json" } }));
		}));
		renderDialog();
		fireEvent.click(screen.getByRole("button", { name: /Individual Race/i }));
		fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Legacy Creator" } });
		fireEvent.click(screen.getByRole("button", { name: "Create race room" }));

		await waitFor(() => expect(screen.getByLabelText("Current route")).toHaveTextContent("/live/legacy-room"));
		const route = screen.getByLabelText("Current route").textContent || "";
		expect(route).toContain('"quizHostCredential":{"mode":"legacy","value":"legacy-secret"}');
		expect(route).not.toContain("quizHostClaim");
		const storedValues = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.getItem(sessionStorage.key(index) || ""));
		expect(storedValues).not.toContain("legacy-secret");
	});

	it("opens and still creates the room when site data is blocked", async () => {
		// Blocked cookies or a sandboxed iframe: even reaching sessionStorage throws.
		const blocked = () => { throw new DOMException("The operation is insecure.", "SecurityError"); };
		const storage = vi.spyOn(globalThis, "sessionStorage", "get").mockImplementation(blocked);
		try {
			vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				if (!init?.method) return Promise.resolve(new Response(JSON.stringify({ playlists: [] }), { status: 200 }));
				return Promise.resolve(new Response(JSON.stringify({ room_id: "room-9", case_id: "35", room_key: "k" }), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				}));
			}));
			renderDialog();
			fireEvent.click(screen.getByRole("button", { name: /Collaborative Review/i }));
			expect(screen.getByLabelText("Display name")).toHaveValue("");
			fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Reader" } });
			fireEvent.submit(screen.getByLabelText("Display name").closest("form")!);

			await waitFor(() => expect(screen.getByLabelText("Current route")).toHaveTextContent("/live/room-9"));
			expect(screen.queryByRole("alert")).toBeNull();
		} finally {
			storage.mockRestore();
		}
	});
});

describe("Quiz practice card", () => {
	afterEach(() => vi.unstubAllGlobals());

	// Answers the case's pack lookup from `packs` (case id -> pack id) and every other GET with no playlists.
	function stubCatalog(packs: Record<string, string>) {
		const fetchMock = vi.fn((input: RequestInfo | URL) => {
			const url = new URL(String(input), "http://localhost");
			if (url.pathname.endsWith("/api/education/quiz-packs")) {
				const packId = packs[url.searchParams.get("case_id") || ""];
				return Promise.resolve(new Response(JSON.stringify({ pack: packId ? { pack_id: packId, case_id: url.searchParams.get("case_id"), title: "Quiz", difficulty: "hard" } : null }), { status: 200 }));
			}
			return Promise.resolve(new Response(JSON.stringify({ playlists: [] }), { status: 200 }));
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("opens the reviewed case 35 pack on case 35", async () => {
		stubCatalog({ "35": "radworld-case-35-v1" });
		renderDialog("35");
		const card = screen.getByRole("button", { name: /Quiz practice/i });
		await waitFor(() => expect(card).toBeEnabled());
		fireEvent.click(card);
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/learn/quiz/radworld-case-35-v1");
	});

	it("opens the pack the catalog has for any other case", async () => {
		const fetchMock = stubCatalog({ "35": "radworld-case-35-v1", "3849": "pants-case-00003849-v2" });
		renderDialog("3849");
		const card = screen.getByRole("button", { name: /Quiz practice/i });
		await waitFor(() => expect(card).toBeEnabled());
		expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/api/education/quiz-packs?case_id=3849"))).toBe(true);
		fireEvent.click(card);
		expect(screen.getByLabelText("Current route")).toHaveTextContent("/learn/quiz/pants-case-00003849-v2");
	});

	it("stays off, and says why, when no pack covers the case", async () => {
		stubCatalog({ "35": "radworld-case-35-v1" });
		renderDialog("34");
		const card = screen.getByRole("button", { name: /Quiz practice/i });
		await waitFor(() => expect(card).toHaveTextContent("No quiz pack covers this case yet."));
		expect(card).toBeDisabled();
	});

	it("stays off while the lookup runs and when it fails", async () => {
		vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
		renderDialog("35");
		const card = screen.getByRole("button", { name: /Quiz practice/i });
		expect(card).toBeDisabled();
		await waitFor(() => expect(card).toHaveTextContent("No quiz pack covers this case yet."));
		expect(card).toBeDisabled();
	});
});
