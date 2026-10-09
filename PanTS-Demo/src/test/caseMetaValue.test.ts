import { describe, expect, it } from "vitest";
import { formatCaseMetaValue } from "../helpers/demographics";

describe("formatCaseMetaValue", () => {
	it("names sex the way the dataset and compare cards do", () => {
		expect(formatCaseMetaValue("sex", "M")).toBe("Male");
		expect(formatCaseMetaValue("sex", "f")).toBe("Female");
		expect(formatCaseMetaValue("sex", "X")).toBe("X");
		expect(formatCaseMetaValue("sex", "")).toBe("Unknown");
		expect(formatCaseMetaValue("sex", null)).toBe("Unknown");
	});

	it("keeps the tumor, number and text rows as before", () => {
		expect(formatCaseMetaValue("tumor", 1)).toBe("Yes");
		expect(formatCaseMetaValue("tumor", 0)).toBe("No");
		expect(formatCaseMetaValue("tumor", null)).toBe("Unknown");
		expect(formatCaseMetaValue("age", 54)).toBe("54");
		expect(formatCaseMetaValue("age", 54.25)).toBe("54.3");
		expect(formatCaseMetaValue("ct phase", "venous")).toBe("venous");
	});
});
