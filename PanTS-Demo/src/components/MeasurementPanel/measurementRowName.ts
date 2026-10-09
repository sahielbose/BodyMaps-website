import { toolDisplayName } from "../../helpers/sessionReport";

// What a row is called to a screen reader: its label, else the tool and value.
export const measurementRowName = (tool: string, label: string, value: string, metaPrefix?: string) =>
	label.trim() || `${metaPrefix ? `${metaPrefix} ` : ""}${toolDisplayName(tool)} ${value}`.trim();

// Rows that share a name (two unlabeled "Distance 10.0 mm", or two equal labels)
// get their place in the list, so their buttons still differ; the rest get none.
export const duplicatePositions = (names: string[]): (string | undefined)[] =>
	names.map((name, i) => (names.filter((n) => n === name).length > 1 ? `${i + 1} of ${names.length}` : undefined));
