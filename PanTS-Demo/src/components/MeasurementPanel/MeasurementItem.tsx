import { useEffect, useRef } from "react";
import { IconCrosshair, IconTrash } from "@tabler/icons-react";
import { toolDisplayName } from "../../helpers/sessionReport";
import { measurementRowName } from "./measurementRowName";

type Props = {
	tool: string;
	/** User-assigned name; empty until renamed. */
	label: string;
	value: string;
	/** Text before the tool name in the meta line (the compare panel's "Case A"). */
	metaPrefix?: string;
	/** "2 of 3", set only when another row has the same name, so the names stay distinct. */
	position?: string;
	canJump: boolean;
	/** Renaming and deleting are off (a locked or disconnected live room); jumping still works. */
	readOnly?: boolean;
	onRename: (label: string) => void;
	onJump: () => void;
	onDelete: () => void;
};

// Keeps a number with its unit (and "mean" with its number) on one line, so a
// wrapped value never strands "HU" or "mm" by itself.
const glueUnits = (value: string) => value.replace(/(mean|[\d.×]) (?=[-\d×]|HU\b|mm|cm|°)/g, "$1\u00a0");

// A ROI value is "area · mean x HU". Each part goes on its own nowrap line
// (the dot is dropped), so a narrow panel never breaks a line on the dot. An
// arrow note is the user's own text, so if one ever arrives as a value it
// stays one wrapping line.
const valueParts = (tool: string, value: string) =>
	tool === "ArrowAnnotate" ? [value] : value.split(" \u00b7 ");

// One row of the Measurements panel, shared by the single and compare viewers:
// the editable name on its own line (a long value can no longer squeeze it to
// a few letters), the tool and the value stacked under it, jump and delete beside both.
function MeasurementItem({ tool, label, value, metaPrefix, position, canJump, readOnly, onRename, onJump, onDelete }: Props) {
	// Names the row for the buttons and the field, so a list of them is not
	// three identical "Delete this measurement" buttons.
	const name = measurementRowName(tool, label, value, metaPrefix);
	const lockedHint = "Editing is off while the live room is locked or reconnecting";
	const who = position ? `${name}, ${position}` : name;
	const parts = valueParts(tool, value);
	const rowRef = useRef<HTMLDivElement>(null);
	const labelRef = useRef<HTMLInputElement>(null);
	// The name the field last showed from the saved label, so leaving it can tell
	// an edit from a rename that landed while it had focus.
	const shownRef = useRef(label);
	// A rename from elsewhere (a live room peer) replaces the text, unless it is
	// being typed in. The field is not remounted for it, so focus stays put.
	useEffect(() => {
		const field = labelRef.current;
		if (field && document.activeElement !== field) {
			field.value = label;
			shownRef.current = label;
		}
	}, [label]);
	// Enter and Escape end the edit on the row's Jump button (or the row itself when
	// it cannot jump) instead of dropping focus to the page; never on Delete, which
	// the same Enter could otherwise activate. Moving focus blurs the field, which commits it.
	const leaveLabel = () => {
		const row = rowRef.current;
		const jump = row?.querySelector<HTMLElement>(".vp-measure__btn:not(.vp-measure__btn--danger):not(:disabled)");
		if (jump) {
			jump.focus({ preventScroll: true });
		} else if (row) {
			row.tabIndex = -1;
			row.focus({ preventScroll: true });
		}
	};
	// Deleting removes the row that holds focus, which would drop it to <body>.
	// Hand it to the neighbouring row's delete button first (the rows are keyed,
	// so that element survives the removal), or to the panel itself when this
	// was the last row.
	const deleteAndKeepFocus = () => {
		const row = rowRef.current;
		const neighbour = row?.nextElementSibling ?? row?.previousElementSibling;
		const next = neighbour?.querySelector<HTMLElement>(".vp-measure__btn--danger");
		if (next) {
			next.focus({ preventScroll: true });
		} else {
			const panel = row?.closest<HTMLElement>('[role="region"]');
			if (panel) {
				panel.tabIndex = -1;
				panel.focus({ preventScroll: true });
			}
		}
		onDelete();
	};
	return (
		<div className="vp-measure__item" ref={rowRef} role="group" aria-label={who}>
			<div className="vp-measure__main">
				<input
					ref={labelRef}
					className="vp-measure__label"
					defaultValue={label}
					placeholder="Add a label"
					aria-label={`Label for ${who}`}
					disabled={readOnly}
					title={readOnly ? lockedHint : undefined}
					onBlur={(e) => {
						// Untouched since it last synced: take the current name instead of
						// writing the stale text back over a peer's rename.
						if (e.target.value === shownRef.current) {
							e.target.value = label;
							shownRef.current = label;
						} else if (e.target.value.trim() !== label) {
							onRename(e.target.value);
						}
					}}
					onKeyDown={(e) => {
						// Enter picks an IME candidate and Escape cancels the composition; neither ends the edit.
						if (e.nativeEvent.isComposing || e.keyCode === 229) return;
						if (e.key !== "Enter" && e.key !== "Escape") return;
						// The key's default is dropped, or the browser would send the same Enter
						// to the button that just took focus and click it.
						e.preventDefault();
						// Escape puts the saved name back, so leaving the field commits nothing.
						if (e.key === "Escape") {
							e.currentTarget.value = label;
							shownRef.current = label;
						}
						leaveLabel();
					}}
				/>
			</div>
			<div className="vp-measure__meta">
				<span className="vp-measure__type">
					{metaPrefix ? `${metaPrefix} · ` : ""}
					{toolDisplayName(tool)}
				</span>
				{value && (
					<span
						className={[
							"vp-measure__value",
							parts.length > 1 ? "vp-measure__value--parts" : "",
							// No number to show: the muted colour tells it apart from a real value.
							value === "Not computed" || value === "Outside the scan" ? "vp-measure__value--none" : "",
						]
							.filter(Boolean)
							.join(" ")}
						title={parts.length > 1 ? value : undefined}
					>
						{parts.map((part, i) => (
							<span key={i} className="vp-measure__value-part">
								{glueUnits(part)}
							</span>
						))}
					</span>
				)}
			</div>
			<div className="vp-measure__btns">
				<button
					type="button"
					className="vp-measure__btn"
					title="Jump to this measurement"
					aria-label={`Jump to ${who}`}
					disabled={!canJump}
					onClick={onJump}
				>
					<IconCrosshair size={15} />
				</button>
				<button
					type="button"
					className="vp-measure__btn vp-measure__btn--danger"
					title={readOnly ? lockedHint : "Delete this measurement"}
					aria-label={`Delete ${who}`}
					disabled={readOnly}
					onClick={deleteAndKeepFocus}
				>
					<IconTrash size={15} />
				</button>
			</div>
		</div>
	);
}

export default MeasurementItem;
