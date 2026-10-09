/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th", 21 -> "21st". */
export function ordinal(n: number): string {
	const lastTwo = Math.abs(n) % 100;
	const last = lastTwo % 10;
	const suffix = lastTwo >= 11 && lastTwo <= 13 ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
	return `${n}${suffix}`;
}
