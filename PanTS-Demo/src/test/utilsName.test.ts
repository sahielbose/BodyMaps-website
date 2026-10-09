/**
 * Organ display names: sentence case everywhere (stats, compare, Organs
 * panel), acronyms keep their capitals, and mid-sentence labels drop the
 * leading capital.
 */
import { describe, expect, it } from "vitest";
import { classInSentence, filenameToName, midSentence } from "../helpers/utils.name";

describe("filenameToName", () => {
	it("turns keys and filenames into sentence case", () => {
		expect(filenameToName("adrenal_gland_left")).toBe("Adrenal gland left");
		expect(filenameToName("renal_vein-right.nii.gz")).toBe("Renal vein right");
		expect(filenameToName("LIVER.nii")).toBe("Liver");
		expect(filenameToName("")).toBe("");
	});

	it("keeps an acronym's capitals", () => {
		expect(filenameToName("cbd_stent")).toBe("CBD stent");
	});
});

describe("midSentence", () => {
	it("lower-cases the first letter unless the label opens with an acronym", () => {
		expect(midSentence("Kidney left")).toBe("kidney left");
		expect(midSentence("Urinary system")).toBe("urinary system");
		expect(midSentence("CBD stent")).toBe("CBD stent");
	});
});

describe("classInSentence", () => {
	it("lower-cases a built-in organ name but keeps a user-named class as typed", () => {
		expect(classInSentence("Spleen")).toBe("spleen");
		expect(classInSentence("Kidney left")).toBe("kidney left");
		expect(classInSentence("CBD stent")).toBe("CBD stent");
		expect(classInSentence("Tumor A")).toBe("Tumor A");
	});
});
