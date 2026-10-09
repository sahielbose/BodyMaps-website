/**
 * The report backdrop's camera refit: <Bounds observe> refits the whole scene on
 * every canvas resize, so the visible-organ fit has to rerun after a resize too.
 */
import { render } from "@testing-library/react";
import { createRef } from "react";
import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fit = vi.fn();
const bounds = vi.hoisted(() => ({ api: undefined as unknown }));
const canvasSize = vi.hoisted(() => ({ value: { width: 800, height: 600 } }));

vi.mock("@react-three/drei", () => ({
	Bounds: () => null,
	OrbitControls: () => null,
	useBounds: () => bounds.api,
}));
vi.mock("@react-three/fiber", () => ({
	Canvas: () => null,
	useThree: (select: (state: { size: unknown }) => unknown) => select({ size: canvasSize.value }),
}));

import { RefitToVisibleOrgans } from "../components/viewer/MeshViewer";

function groupWith(...visible: boolean[]) {
	const group = new THREE.Group();
	visible.forEach((v, i) => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
		mesh.position.set(i * 10, 0, 0);
		mesh.visible = v;
		group.add(mesh);
	});
	group.updateMatrixWorld(true);
	return group;
}

describe("RefitToVisibleOrgans", () => {
	beforeEach(() => {
		fit.mockClear();
		canvasSize.value = { width: 800, height: 600 };
		const api = { refresh: vi.fn(() => api), clip: vi.fn(() => api), fit };
		bounds.api = api;
	});

	it("fits the shown organs, and again after the canvas resizes", () => {
		const ref = createRef<THREE.Group>();
		(ref as { current: THREE.Group }).current = groupWith(true, false);
		const { rerender } = render(<RefitToVisibleOrgans groupRef={ref} signature="1" />);
		expect(fit).toHaveBeenCalledTimes(1);
		const api = bounds.api as { refresh: ReturnType<typeof vi.fn> };
		// Only the visible organ's box (centred on x = 0, one unit wide).
		const box = api.refresh.mock.calls[0][0] as THREE.Box3;
		expect(box.max.x).toBeCloseTo(0.5);

		rerender(<RefitToVisibleOrgans groupRef={ref} signature="1" />);
		expect(fit).toHaveBeenCalledTimes(1); // nothing changed

		canvasSize.value = { width: 500, height: 600 };
		rerender(<RefitToVisibleOrgans groupRef={ref} signature="1" />);
		expect(fit).toHaveBeenCalledTimes(2);
	});
});
