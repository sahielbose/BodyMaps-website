import { describe, expect, it } from "vitest";
import { operationLog, voxelsLog } from "./editLog";

describe("edit log wording", () => {
	it("writes the flyout label instead of the operation id", () => {
		expect(operationLog("Scissors", "eraseInside", 1234)).toBe("Scissors: erase inside (1,234 voxels)");
		expect(operationLog("Level trace", "fillOutside", 5)).toBe("Level trace: fill outside (5 voxels)");
		expect(operationLog("Scissors", "eraseOutside", 2)).toBe("Scissors: erase outside (2 voxels)");
		expect(operationLog("Level trace", "fillInside", 2)).toBe("Level trace: fill inside (2 voxels)");
	});

	it("uses the singular for one voxel and never the abbreviation", () => {
		expect(voxelsLog(1)).toBe("1 voxel");
		expect(operationLog("Scissors", "fillInside", 1)).not.toMatch(/vox\)/);
	});
});
