/**
 * The Segments popup's eyes read checkState, the record the viewer draws from.
 * The isolation effect and the no-target reset write it as well, so an eye
 * always matches the mask and a click always changes it.
 */

/** Which of the given classes are drawn right now. */
export function visibilityFromCheckState(
	organs: ReadonlyArray<{ id: number }>,
	checkState: ReadonlyArray<boolean>,
): Record<number, boolean> {
	return Object.fromEntries(organs.map((o) => [o.id, !!checkState[o.id]]));
}

/** checkState with one class's visibility flipped. */
export function toggleCheckState(checkState: ReadonlyArray<boolean>, id: number): boolean[] {
	const next = [...checkState];
	next[id] = !checkState[id];
	return next;
}

/**
 * The array the viewer's setVisibilities takes: index = segment id, slot 0 the
 * background (always drawn). Indexed by id, not by position in the class list:
 * ids are never reused, so deleting a middle custom class leaves a gap and a
 * positional build would shift every later class's state onto the id before it.
 * Ids with no class (deleted ones) are false.
 */
export function visibilityById(
	organs: ReadonlyArray<{ id: number }>,
	checkState: ReadonlyArray<boolean>,
): boolean[] {
	let maxId = 0;
	for (const o of organs) if (o.id > maxId) maxId = o.id;
	const arr: boolean[] = new Array(maxId + 1).fill(false);
	arr[0] = true;
	for (const o of organs) arr[o.id] = !!checkState[o.id];
	return arr;
}
