/**
 * Which organ meshes the 3D pane draws in a live quiz, a quiz practice and a solo
 * challenge, and whether the pane has nothing to draw because the answer is still
 * withheld. Kept apart from the page so both can be checked without rendering it.
 */

export interface MeshVisibilityInput {
	/** The organ tick boxes (index 0 is the background entry). */
	checkState: boolean[];
	/** 1-based mesh ID of the pancreatic lesion in the viewer's label list. */
	lesionMeshId: number;
	/** The live quiz reveal or the quiz practice conclusion asks for the lesion overlay. */
	lesionRevealed: boolean;
	mode: "liveQuiz" | "quizPractice" | "soloChallenge" | "other";
	/** Solo challenge only: the mesh ID the graded result points at. */
	soloMeshOrganId?: number;
}

/** Every mesh except the lesion, which waits for the server-authored final reveal. */
export function meshCheckStateFor({ checkState, lesionMeshId, lesionRevealed, mode, soloMeshOrganId }: MeshVisibilityInput): boolean[] {
	if (mode === "liveQuiz" || mode === "quizPractice") {
		return checkState.map((_, index) => index === 0 || lesionRevealed || index !== lesionMeshId);
	}
	if (mode !== "soloChallenge" || !soloMeshOrganId || soloMeshOrganId >= checkState.length) return checkState;
	return checkState.map((_, index) => index === 0 || index === soloMeshOrganId);
}

/**
 * A quiz practice or solo challenge loads its answer masks only once the answer is
 * graded, so until a result is in there is no organ to draw. The live quiz keeps its
 * masks from the start, so it never counts as held back.
 */
export function meshesHeldBack(mode: MeshVisibilityInput["mode"], hasResult: boolean): boolean {
	return (mode === "quizPractice" || mode === "soloChallenge") && !hasResult;
}
