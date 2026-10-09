// helpers/viewer/editLog.ts
//
// Wording for the edit lines that go into the reading session timeline (and so
// into the draft report, which other people read). The operation ids are
// internal; the labels are the ones the Scissors and Level tracing flyouts show.

const OPERATION_LABELS: Record<string, string> = {
	eraseInside: "erase inside",
	eraseOutside: "erase outside",
	fillInside: "fill inside",
	fillOutside: "fill outside",
};

/** "1 voxel" / "1,234 voxels". */
export const voxelsLog = (n: number) => `${n.toLocaleString()} ${n === 1 ? "voxel" : "voxels"}`;

/** "Scissors: erase inside (1,234 voxels)". */
export function operationLog(tool: string, operation: string, voxels: number) {
	return `${tool}: ${OPERATION_LABELS[operation] ?? operation} (${voxelsLog(voxels)})`;
}
