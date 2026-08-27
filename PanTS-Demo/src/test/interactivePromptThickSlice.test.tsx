/**
 * Arm-time thick-slice notice.
 *
 * Measured on real PanTS: on 7.5 mm and 5 mm scans soft-tissue scores
 * collapse, some structures are unreachable by any prompt, and the failure
 * direction flips by prompt type (a box overshoots on large solid organs
 * while a point still works). The hook must say that BEFORE the first click,
 * once per case, and stay quiet on well-spaced scans.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

describe("useInteractivePromptTool thick-slice notice", () => {
	beforeEach(() => {
		vi.resetModules();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	async function renderWithSpacing(
		spacing: [number, number, number] | null,
		{ caseId = 1 }: { caseId?: number } = {},
	) {
		vi.doMock("../helpers/CornerstoneNifti2", async (importOriginal) => {
			const mod = await importOriginal<typeof import("../helpers/CornerstoneNifti2")>();
			return { ...mod, getSegmentationSpacing: () => spacing };
		});
		const { useInteractivePromptTool } = await import("../helpers/viewer/useInteractivePromptTool");
		return renderHook(
			(props: { enabled: boolean; caseId: number }) =>
				useInteractivePromptTool({
					enabled: props.enabled,
					mode: "point",
					apiBase: "http://api.test",
					caseId: props.caseId,
					activeSegmentIndex: 7,
					res: "low",
				} as any),
			{ initialProps: { enabled: true, caseId } },
		);
	}

	it("warns before the first click on a 7.5 mm scan", async () => {
		const hook = await renderWithSpacing([0.818, 0.818, 7.5]);
		expect(hook.result.current.status).toBe("notice");
		const msg = hook.result.current.statusMessage ?? "";
		expect(msg).toContain("7.5 mm");
		expect(msg).toMatch(/box tends to overshoot/i);
		expect(msg).toMatch(/single click/i);
	});

	it("stays quiet on an isotropic scan", async () => {
		const hook = await renderWithSpacing([1.5, 1.5, 1.5]);
		expect(hook.result.current.status).toBe("idle");
		expect(hook.result.current.statusMessage).toBeNull();
	});

	it("stays quiet just under the threshold", async () => {
		// 2.6:1 is the measured case where the tool still behaves normally.
		const hook = await renderWithSpacing([0.961, 0.961, 2.5]);
		expect(hook.result.current.status).toBe("idle");
	});

	it("does nothing when no labelmap is loaded yet", async () => {
		const hook = await renderWithSpacing(null);
		expect(hook.result.current.status).toBe("idle");
	});

	it("warns once per case, not on every re-arm", async () => {
		const { act } = await import("@testing-library/react");
		const hook = await renderWithSpacing([0.781, 0.781, 5.0]);
		expect(hook.result.current.status).toBe("notice");
		await act(async () => hook.result.current.dismissStatus());
		expect(hook.result.current.status).toBe("idle");

		hook.rerender({ enabled: false, caseId: 1 });
		hook.rerender({ enabled: true, caseId: 1 });
		expect(hook.result.current.status).toBe("idle");
	});
});
