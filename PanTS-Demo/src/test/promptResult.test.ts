/**
 * Degenerate-proposal detection for the interactive segmentation tool.
 *
 * Benchmarking on PanTS showed a point prompt on a lung returning 8 voxels
 * out of a 1.5M voxel organ; the UI applied it, logged "+8 vox", and the
 * user saw nothing. These pin the classification that turns that into an
 * honest "the prompt type failed, draw a box or lasso" message, without
 * flagging the small deltas that are normal during refinement.
 */
import { describe, expect, it } from "vitest";
import {
	DEGENERATE_PROPOSAL_VOXELS,
	isDegenerateProposal,
} from "../helpers/viewer/promptResult";

const base = { added: 8, removed: 0, firstPrompt: true, include: true };

describe("isDegenerateProposal", () => {
	it("flags the measured lung case: first click lands 8 voxels", () => {
		expect(isDegenerateProposal(base)).toBe(true);
	});

	it("does not flag a first click that lands a real structure", () => {
		// Smallest testable PanTS structures are a few hundred voxels; even
		// on the low-res grid a genuine hit stays above the threshold.
		expect(isDegenerateProposal({ ...base, added: 180 })).toBe(false);
		expect(
			isDegenerateProposal({ ...base, added: DEGENERATE_PROPOSAL_VOXELS }),
		).toBe(false);
	});

	it("does not flag refinement clicks, where tiny deltas are normal", () => {
		expect(isDegenerateProposal({ ...base, firstPrompt: false })).toBe(false);
	});

	it("does not flag corrective right-clicks", () => {
		expect(
			isDegenerateProposal({ ...base, include: false, removed: 3, added: 0 }),
		).toBe(false);
	});

	it("does not flag a session response that retracted voxels", () => {
		// A retraction means there was an accumulated object, so this cannot
		// be a from-scratch prompt regardless of the added count.
		expect(isDegenerateProposal({ ...base, removed: 12 })).toBe(false);
	});

	it("stays out of the way when nothing was added at all", () => {
		// added === 0 is the existing "nothing changed" error path, which
		// already speaks up; the degenerate path must not shadow it.
		expect(isDegenerateProposal({ ...base, added: 0 })).toBe(false);
	});
});
