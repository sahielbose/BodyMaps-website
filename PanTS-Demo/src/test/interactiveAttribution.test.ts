/**
 * The attribution line must track the licence the RUNNING model server
 * reports (via /api/interactive-capabilities), with today's weights licence
 * as the fallback — and the non-commercial clause must be a property of the
 * licence string, not baked into the sentence.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
	interactiveAttribution,
	primeInteractiveLicense,
	_resetInteractiveLicenseForTests,
} from "../helpers/viewer/interactiveAttribution";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("interactiveAttribution", () => {
	beforeEach(() => {
		_resetInteractiveLicenseForTests();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		_resetInteractiveLicenseForTests();
	});

	it("falls back to the shipped licence before any fetch answers", () => {
		const line = interactiveAttribution();
		expect(line).toContain("nnInteractive");
		expect(line).toContain("CC BY-NC-SA 4.0");
		expect(line).toContain("non-commercial");
	});

	it("shows the licence the server reports once primed", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ license: "CC BY 4.0", available: true }));
		vi.stubGlobal("fetch", fetchMock);

		primeInteractiveLicense("http://api.test");
		await vi.waitFor(() => {
			expect(interactiveAttribution()).toContain("CC BY 4.0");
		});
		// A permissive licence must not claim a non-commercial scope.
		expect(interactiveAttribution()).not.toContain("non-commercial");
		expect(fetchMock).toHaveBeenCalledWith("http://api.test/api/interactive-capabilities");
	});

	it("keeps the non-commercial clause for an NC licence from the server", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ license: "CC BY-NC-SA 4.0" })));
		primeInteractiveLicense("http://api.test");
		await vi.waitFor(() => {
			expect(interactiveAttribution()).toContain("non-commercial");
		});
	});

	it("fetches once, not per render", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ license: "CC BY 4.0" }));
		vi.stubGlobal("fetch", fetchMock);
		primeInteractiveLicense("http://api.test");
		primeInteractiveLicense("http://api.test");
		await vi.waitFor(() => expect(interactiveAttribution()).toContain("CC BY 4.0"));
		primeInteractiveLicense("http://api.test");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the fallback when the endpoint fails", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
		primeInteractiveLicense("http://api.test");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(interactiveAttribution()).toContain("CC BY-NC-SA 4.0");
	});
});
