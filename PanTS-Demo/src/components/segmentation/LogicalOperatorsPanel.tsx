import { useState } from "react";
import type { LogicalOperation } from "../../helpers/CornerstoneNifti2";
import type { CheckBoxData } from "../../types";
import ApplyButton from "../ApplyButton";
import { GrandchildRow, MenuColumn } from "../viewer/FlyoutPrimitives";
import { classInSentence } from "../../helpers/utils.name";

interface LogicalOperatorsPanelProps {
	segments: CheckBoxData[];
	targetSegmentId: number;
	/** Returns the edit's result when the caller has one. A null result or zero
	 *  changed voxels keeps the flyout open with a note; returning nothing
	 *  (undefined) is treated as applied. */
	onApply: (operation: LogicalOperation, sourceSegmentId: number | null, bypassMasking: boolean) => { changedVoxels: number } | null | void;
	operation: LogicalOperation;
	onOperationChange: (op: LogicalOperation) => void;
	sourceId: number | null;
	onSourceIdChange: (id: number | null) => void;
	bypassMasking: boolean;
	onBypassMaskingChange: (v: boolean) => void;
	/** Called right after Apply runs — tells the toolbar to close this
	 *  tool's settings and drop its "selected" highlight. */
	onApplied?: () => void;
	/** Mirrors the running state up to the toolbar so the single pulsing
	 *  "Applying…" indicator at the right of the ribbon can show while this
	 *  is in flight, instead of this panel owning its own separate spinner. */
	onBusyChange?: (busy: boolean) => void;
}

const OPERATIONS: { value: LogicalOperation; label: string; needsSource: boolean }[] = [
	{ value: "copy", label: "Copy", needsSource: true },
	{ value: "add", label: "Add", needsSource: true },
	{ value: "invert", label: "Invert", needsSource: false },
	{ value: "clear", label: "Clear", needsSource: false },
	{ value: "fill", label: "Fill", needsSource: false },
];

// Shown when an operation ran but left every voxel as it was, so the flyout
// stays open instead of reporting an edit that never happened.
const NOTHING_CHANGED: Record<LogicalOperation, string> = {
	copy: "Nothing changed. The two classes may already match, or both may be empty.",
	add: "Nothing changed. The picked class may be empty, or already part of this class.",
	invert: "Nothing changed.",
	clear: "Nothing changed. This class may already be empty.",
	fill: "Nothing changed. There was nothing left to fill.",
};

// With Bypass masking off, a write never lands on another class's voxels, and
// Clear only writes empty voxels, so it is the one operation this can't explain.
function getNothingChangedNote(op: LogicalOperation, bypassMasking: boolean): string {
	if (!bypassMasking && op !== "clear") return "Nothing changed. Turn on Bypass masking to overwrite another class's voxels.";
	return NOTHING_CHANGED[op];
}

// Plain-language description of what Apply will do, shown on the button
// itself. Source is blank ("___") until a class is picked.
function getApplyLabel(def: typeof OPERATIONS[number], target: string, source: string): string {
	const targetLabel = classInSentence(target);
	const sourceLabel = classInSentence(source);
	switch (def.value) {
		case "copy":
			return `Replace ${targetLabel} with ${sourceLabel}`;
		case "add":
			return `Combine ${targetLabel} and ${sourceLabel}`;
		case "invert":
			return `Invert ${targetLabel}`;
		case "clear":
			return `Clear ${targetLabel}`;
		case "fill":
			return `Fill ${targetLabel}`;
	}
}

// Plain-language copy for the source picker, since "Source class" alone
// doesn't say what picking one does for this operation.
function getSourceCopy(def: typeof OPERATIONS[number], targetLabel: string): { placeholder: string; title: string } {
	switch (def.value) {
		case "copy":
			return {
				placeholder: "Copy from…",
				title: `${targetLabel} will be replaced by the picked class's shape.`,
			};
		case "add":
			return {
				placeholder: "Combine with…",
				title: `The picked class will be merged into ${classInSentence(targetLabel)}.`,
			};
		default:
			return { placeholder: "Source class…", title: "Source class" };
	}
}

// One row in the operations column: clicking opens its grandchild, which
// holds the source-segment picker (Copy/Add only), the bypass-masking
// toggle, and the Apply button for that operation.
function OperationRow({
	def, segments, targetSegmentId, sourceId, onSourceIdChange,
	bypassMasking, onBypassMaskingChange, onApply, onDone, expanded, onToggle, note,
}: {
	def: typeof OPERATIONS[number];
	segments: CheckBoxData[];
	targetSegmentId: number;
	sourceId: number | null;
	onSourceIdChange: (id: number | null) => void;
	bypassMasking: boolean;
	onBypassMaskingChange: (v: boolean) => void;
	onApply: () => boolean | void;
	onDone: () => void;
	expanded: boolean;
	onToggle: () => void;
	note: string | null;
}) {
	const otherSegments = segments.filter((s) => s.id !== targetSegmentId);
	const targetLabel = segments.find((s) => s.id === targetSegmentId)?.label ?? "___";
	// The stored source can outlive its class (deleted, or now the target), so
	// only a class still in the dropdown counts as picked.
	const effectiveSource = otherSegments.some((s) => s.id === sourceId) ? sourceId : null;
	const sourceLabel = otherSegments.find((s) => s.id === effectiveSource)?.label ?? "___";

	return (
		<GrandchildRow label={def.label} expanded={expanded} onToggle={onToggle}>
			{def.needsSource && otherSegments.length === 0 && (
				<p className="atb-flyout-note">Add another class first, then pick it here.</p>
			)}
			{def.needsSource && otherSegments.length > 0 && (
				<select
					className="seg-effect__select"
					value={effectiveSource ?? ""}
					onChange={(e) => onSourceIdChange(e.target.value === "" ? null : Number(e.target.value))}
					title={getSourceCopy(def, targetLabel).title}
				>
					<option value="" disabled>
						{getSourceCopy(def, targetLabel).placeholder}
					</option>
					{otherSegments.map((s) => (
						<option key={s.id} value={s.id}>
							{s.label}
						</option>
					))}
				</select>
			)}

			<label
				style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "#fff", cursor: "pointer" }}
				title={
					bypassMasking
						? "Ignores class ownership, so it can overwrite any voxel, even another class's."
						: "Can only touch empty voxels and this class's own."
				}
			>
				<input type="checkbox" checked={bypassMasking} onChange={(e) => onBypassMaskingChange(e.target.checked)} />
				Bypass masking
			</label>

			{note && (
				<p className="atb-flyout-note atb-flyout-note--error" role="alert">
					{note}
				</p>
			)}

			<ApplyButton
				disabled={def.needsSource && effectiveSource === null}
				onApply={onApply}
				onDone={onDone}
				label={getApplyLabel(def, targetLabel, sourceLabel)}
				successLabel="Applied"
			/>
		</GrandchildRow>
	);
}

export default function LogicalOperatorsPanel({
	segments,
	targetSegmentId,
	onApply,
	operation,
	onOperationChange,
	sourceId,
	onSourceIdChange,
	bypassMasking,
	onBypassMaskingChange,
	onApplied,
	onBusyChange,
}: LogicalOperatorsPanelProps) {
	const [pendingOp, setPendingOp] = useState<LogicalOperation>(operation);
	// Which row's grandchild is open — only one at a time.
	const [expandedOp, setExpandedOp] = useState<LogicalOperation | null>(null);

	// A source picked for one operation has no guaranteed meaning for
	// another, so switching which row's grandchild is "current" forgets it.
	// Set when the last Apply changed nothing, so the flyout stays open with a
	// note under that row's button.
	const [note, setNote] = useState<{ op: LogicalOperation; text: string } | null>(null);

	const selectOperation = (op: LogicalOperation) => {
		setPendingOp(op);
		onOperationChange(op);
		onSourceIdChange(null);
	};

	const runApply = (def: typeof OPERATIONS[number]) => {
		// Re-applying the open row keeps its picked source, so a no-op can be retried.
		if (pendingOp === def.value) onOperationChange(def.value);
		else selectOperation(def.value);
		setNote(null);
		onBusyChange?.(true);
		const sourceStillValid = segments.some((s) => s.id === sourceId && s.id !== targetSegmentId);
		const r = onApply(def.value, def.needsSource && sourceStillValid ? sourceId : null, bypassMasking);
		if (r !== undefined && !r?.changedVoxels) {
			// No success beat and no close: ApplyButton skips onDone on false.
			onBusyChange?.(false);
			setNote({ op: def.value, text: getNothingChangedNote(def.value, bypassMasking) });
			return false;
		}
	};

	// Fires once ApplyButton's own success checkmark has had its beat on
	// screen — this is what actually clears the busy dot and lets the tool
	// deselect, instead of that happening in the same tick as the click.
	const finishApply = () => {
		onBusyChange?.(false);
		onApplied?.();
	};

	return (
		<MenuColumn>
			{OPERATIONS.map((def) => (
				<OperationRow
					key={def.value}
					def={def}
					segments={segments}
					targetSegmentId={targetSegmentId}
					sourceId={pendingOp === def.value ? sourceId : null}
					onSourceIdChange={(id) => { setPendingOp(def.value); onOperationChange(def.value); onSourceIdChange(id); setNote(null); }}
					bypassMasking={bypassMasking}
					onBypassMaskingChange={(v) => { onBypassMaskingChange(v); setNote(null); }}
					note={note?.op === def.value ? note.text : null}
					onApply={() => runApply(def)}
					onDone={finishApply}
					expanded={expandedOp === def.value}
					onToggle={() => setExpandedOp((prev) => (prev === def.value ? null : def.value))}
				/>
			))}
		</MenuColumn>
	);
}