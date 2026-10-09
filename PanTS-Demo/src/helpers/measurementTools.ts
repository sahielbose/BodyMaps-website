// The one table of measurement tool names. The Measure menus (single and compare
// viewer), the Measurements panel and the session report all read it, so a tool
// has the same name everywhere; `detail` is the faint second half the menus add.
// Keyed by the Cornerstone tool name, which the annotations carry in their metadata.
export type MeasurementToolInfo = {
	name: string;
	detail: string;
};

export const MEASUREMENT_TOOL_INFO: Record<string, MeasurementToolInfo> = {
	Length: { name: "Distance", detail: "Length in mm" },
	Bidirectional: { name: "Bidirectional", detail: "Long and short axis" },
	Angle: { name: "Angle", detail: "Degrees" },
	Probe: { name: "HU probe", detail: "HU at a point" },
	RectangleROI: { name: "Rectangle ROI", detail: "HU and area" },
	EllipticalROI: { name: "Ellipse ROI", detail: "HU and area" },
	PlanarFreehandROI: { name: "Freehand ROI", detail: "HU and area" },
	ArrowAnnotate: { name: "Arrow note", detail: "Label a finding" },
	AdvancedMagnify: { name: "Magnify loupe", detail: "Zoom in place" },
};

/** The display name for a tool, or the raw tool name when it is not in the table. */
export function measurementToolName(tool: string): string {
	return MEASUREMENT_TOOL_INFO[tool]?.name ?? tool;
}

/** The faint secondary description for a tool's menu row, or "" when it has none. */
export function measurementToolDetail(tool: string): string {
	return MEASUREMENT_TOOL_INFO[tool]?.detail ?? "";
}
