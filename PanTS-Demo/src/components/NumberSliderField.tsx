import { useEffect, useId, useRef, useState } from "react";
import { markEscapeUsed } from "../helpers/viewer/escapeUsed";

interface NumberSliderFieldProps {
	label?: string;
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
	step: number;
	unit?: string;
	/** Fixed decimals for the box, for panels whose action label formats the
	 *  same value with toFixed (so "3" here and "3.0mm" there can't disagree). */
	decimals?: number;
	ariaLabel?: string;
	/** Longer help text for the slider, kept out of its name (which also
	 *  prefixes the number box's) and announced as its description. */
	ariaDescription?: string;
	/** Optional: fires true while the slider (not the text box) is actively
	 *  being dragged/focused, false when released — for tools like the
	 *  brush diameter that show a live preview only while adjusting. */
	onPreviewChange?: (active: boolean) => void;
}

const formatValue = (v: number, decimals?: number) => (decimals === undefined ? String(v) : v.toFixed(decimals));

/**
 * Slider + typable number box, shared by every panel that takes a numeric
 * parameter (margin mm, smoothing kernel, level-tracing tolerance, brush
 * diameter, ...).
 *
 * The number lives in exactly one place — the typable box — with its unit
 * printed right after it. The label above is just a static caption; it does
 * not repeat the value, so nothing is shown twice.
 *
 * The box owns its own draft string while focused, independent of the
 * committed value, and only parses/clamps on blur or Enter. That's what
 * makes decimals typable: clearing "3" to type "2.5" no longer round-trips
 * through `Number("")` → 0 and snaps back to a lone "0" mid-keystroke.
 */
export default function NumberSliderField({
	label, value, onChange, min, max, step, unit, decimals, ariaLabel, ariaDescription, onPreviewChange,
}: NumberSliderFieldProps) {
	const format = (v: number) => formatValue(v, decimals);
	const descriptionId = useId();
	const [draft, setDraft] = useState(format(value));
	const [focused, setFocused] = useState(false);
	// Set by Escape, so the blur that follows (which may still see the typed
	// draft in its closure) doesn't commit it. Cleared by the next keystroke.
	const cancelledRef = useRef(false);
	// Bumped by Enter, which commits without leaving the box. The effect below
	// then shows the value the parent actually applied (it may round or clamp
	// what was typed) even though the box is still focused.
	const [enterTick, setEnterTick] = useState(0);
	const syncedTickRef = useRef(0);

	// Stay in sync with external changes (slider drags, resets) — but never
	// stomp on what the user is actively typing.
	useEffect(() => {
		const entered = enterTick !== syncedTickRef.current;
		syncedTickRef.current = enterTick;
		if (!focused || entered) setDraft(formatValue(value, decimals));
	}, [value, focused, decimals, enterTick]);

	const clamp = (v: number) => Math.min(max, Math.max(min, v));

	const commit = () => {
		const parsed = parseFloat(draft);
		if (Number.isNaN(parsed)) {
			setDraft(format(value));
			return;
		}
		// Commit what the box shows: a typed 2.55 in a one-decimal box would
		// otherwise be applied as 2.55 while the action label reads 2.5 or 2.6.
		const clamped = clamp(parsed);
		const committed = decimals === undefined ? clamped : Number(clamped.toFixed(decimals));
		// Passing through the box without editing it must not re-send the value
		// (the parent may clear its error note on any change), nor re-apply a
		// stored value the box only shows rounded.
		if (draft !== format(value) && committed !== value) onChange(committed);
		setDraft(format(committed));
	};

	return (
		<div className="atb-flyout__section">
			{label && <span className="atb-flyout__label">{label}</span>}
			{/* A hidden node still counts for aria-describedby. */}
			{ariaDescription && <span id={descriptionId} hidden>{ariaDescription}</span>}
			<div className="atb-flyout__slider-row">
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					value={value}
					onChange={(e) => onChange(Number(e.target.value))}
					onPointerDown={() => onPreviewChange?.(true)}
					onPointerUp={() => onPreviewChange?.(false)}
					onFocus={() => onPreviewChange?.(true)}
					onBlur={() => onPreviewChange?.(false)}
					// A mouse drag ends the preview on pointer up but leaves the slider focused,
					// so a following arrow key has to bring the circle back.
					onKeyDown={(e) => {
						if (/^(Arrow|Page|Home|End)/.test(e.key)) onPreviewChange?.(true);
					}}
					className="atb-flyout__range"
					aria-label={ariaLabel}
					aria-describedby={ariaDescription ? descriptionId : undefined}
				/>
				<div className="atb-flyout__slider-readout">
					<input
						type="text"
						inputMode="decimal"
						className="seg-effect__number seg-effect__number--compact"
						value={draft}
						onFocus={() => { cancelledRef.current = false; setFocused(true); }}
						onChange={(e) => {
							// A decimal-comma keypad types "," for the point; store it as ".".
							const v = e.target.value.replace(",", ".");
							cancelledRef.current = false;
							// Let the user freely type a number-in-progress: digits, one
							// optional leading minus (only if the range allows negatives),
							// one decimal point. Reject anything else instead of coercing it.
							const pattern = min < 0 ? /^-?\d*\.?\d*$/ : /^\d*\.?\d*$/;
							if (v === "" || pattern.test(v)) setDraft(v);
						}}
						onBlur={() => {
							setFocused(false);
							if (cancelledRef.current) { cancelledRef.current = false; return; }
							commit();
						}}
						onKeyDown={(e) => {
							// Focus stays in the box (a blur would drop it to <body> and break
							// the flyout's Tab hand-off); the tick resyncs the draft to the
							// value the parent applied, which may differ from what was typed.
							if (e.key === "Enter") { commit(); setEnterTick((t) => t + 1); }
							// Undoing a typed value uses up the Escape, so the settings
							// flyout around the field stays open. With nothing to undo the
							// Escape goes on to close the flyout.
							if (e.key === "Escape" && draft !== format(value)) {
								markEscapeUsed(e.nativeEvent);
								cancelledRef.current = true;
								setDraft(format(value));
							}
						}}
						aria-label={ariaLabel ? `${ariaLabel} exact value` : "Exact value"}
					/>
					{unit && <span className="seg-effect__unit">{unit}</span>}
				</div>
			</div>
		</div>
	);
}