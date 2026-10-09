/** The axial slice bar is turned so slice 0 is at the top, which left the native range
 *  keys backwards on it: Up raised the index and moved the thumb down. On that bar Up and
 *  Page Up step towards the top and Down and Page Down towards the bottom, so the thumb
 *  follows the key. Returns the slice step for a key, or null for keys left to the range
 *  (Left, Right, Home and End already read the same way on the turned bar). */
export function axialSliceBarKeyStep(key: string, total: number): number | null {
  const page = Math.max(1, Math.round(total / 10));
  const steps: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -page, PageDown: page };
  return key in steps ? steps[key] : null;
}
