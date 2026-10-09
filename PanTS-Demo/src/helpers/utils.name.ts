import { segmentation_categories } from "./constants";

// Organ keys are plain words apart from these, which keep their capitals.
const ACRONYMS: Record<string, string> = { cbd: "CBD" };

/**
 * Converts a raw organ filename/key (e.g. "adrenal_gland-left") into a
 * sentence-case display name ("Adrenal gland left"), the site's rule for
 * labels. Acronyms keep their capitals ("cbd_stent" -> "CBD stent").
 */
export function filenameToName(filename: string): string {
	const words = filename
		.replace(/\.nii(\.gz)?$/i, "")
		.split(/[-_]+/)
		.filter(Boolean)
		.map((word) => ACRONYMS[word.toLowerCase()] ?? word.toLowerCase());
	if (words.length === 0) return "";
	words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1);
	return words.join(" ");
}

/** A sentence-case label as it reads mid-sentence ("Jump to kidney left"):
 *  the first letter drops to lower case unless the first word is an acronym. */
export function midSentence(label: string): string {
	return /^[A-Z]{2,}\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

// Every built-in organ's display name, to tell them from classes a user named.
const ORGAN_NAMES = new Set<string>(segmentation_categories.map(filenameToName));

/** A class name as it reads mid-sentence ("Refine spleen"): a built-in organ
 *  name drops its capital, a class the user named keeps their spelling. */
export function classInSentence(label: string): string {
	return ORGAN_NAMES.has(label) ? midSentence(label) : label;
}
