/**
 * Classification of an interactive-segment result after it has been applied.
 *
 * Benchmarking against PanTS ground truth showed a failure mode the UI used
 * to hide: a point prompt on a large air-filled structure (a 1.5M voxel lung)
 * can come back with single-digit voxels. The request succeeds, the apply
 * succeeds, the log says "+8 vox", and the user sees nothing appear. A box on
 * the same organ scores 0.97, so the honest response is to tell the user the
 * prompt type failed, not to report success.
 *
 * Kept as its own module (rather than living in CornerstoneNifti2) so it can
 * be unit tested without pulling the Cornerstone stack into vitest.
 */

/**
 * Below this many newly added voxels, a first include prompt is treated as a
 * failed prompt rather than a small success. The smallest testable PanTS
 * structures are a few hundred voxels at full res and roughly 1/8 of that on
 * the low-res grid, so a legitimate hit stays above this even for tiny ducts;
 * the degenerate lung case lands at 8.
 */
export const DEGENERATE_PROPOSAL_VOXELS = 50;

export interface ProposalOutcome {
	/** Voxels this apply newly set to the active segment. */
	added: number;
	/** Voxels this apply retracted (session refinements only). */
	removed: number;
	/** True when there was no session baseline and no seed label, i.e. the
	 * model was asked to find the structure from scratch. */
	firstPrompt: boolean;
	/** True for an additive prompt (left click / box / lasso), false for a
	 * corrective right-click. */
	include: boolean;
}

/**
 * True when the prompt technically succeeded but landed so few voxels that,
 * in user terms, it failed. Only a first additive prompt qualifies: during
 * refinement, small deltas are normal and corrective clicks legitimately
 * remove more than they add.
 */
export function isDegenerateProposal(o: ProposalOutcome): boolean {
	return (
		o.include &&
		o.firstPrompt &&
		o.removed === 0 &&
		o.added > 0 &&
		o.added < DEGENERATE_PROPOSAL_VOXELS
	);
}
