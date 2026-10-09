import { useState } from "react";
import { count } from "./format";

// When people are here — by day of the week, or by hour of the day. Wix's
// "average sessions by time", and the same dropdown to swap between the two.
//
// Plain divs rather than SVG: this is a row of rectangles with labels under
// them, which is what a flex row already is. The bars in BarList are horizontal
// because their labels are words of unpredictable length; these are vertical
// because a day or an hour is a position on an axis, and reading Monday-to-
// Sunday left to right is the whole point.
//
// Counted in sessions, not events: "when do people come here" is a question
// about visits. Counting events would make one long viewer session look like a
// crowd.

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Point = { sessions: number; people: number };
type Mode = "weekday" | "hour";

/** Hour labels are dense — 24 of them across a panel — so only every third
 *  gets one. The bars are all still there; the axis just isn't shouting. */
const hourLabel = (hour: number) => (hour % 3 === 0 ? `${hour}` : "");

const TimeBars: React.FC<{
	weekday: { weekday: number; sessions: number; people: number }[];
	hour: { hour: number; sessions: number; people: number }[];
}> = ({ weekday, hour }) => {
	const [mode, setMode] = useState<Mode>("weekday");
	// The slot whose figures are showing. Set by hover, focus or a tap, so the
	// numbers are reachable without a mouse; a title attribute is not.
	const [picked, setPicked] = useState<number | null>(null);

	// Filled from a zeroed array rather than mapped from the response: a day
	// with no visits has no row on the server, and it is precisely the gap the
	// chart needs to show.
	const slots: Point[] = Array.from(
		{ length: mode === "weekday" ? 7 : 24 },
		() => ({ sessions: 0, people: 0 }),
	);
	if (mode === "weekday") {
		weekday.forEach((d) => {
			if (d.weekday >= 0 && d.weekday < 7) slots[d.weekday] = d;
		});
	} else {
		hour.forEach((h) => {
			if (h.hour >= 0 && h.hour < 24) slots[h.hour] = h;
		});
	}

	const max = slots.reduce((m, s) => Math.max(m, s.sessions), 0);
	const total = slots.reduce((sum, s) => sum + s.sessions, 0);

	if (!total) return <p className="dash-empty">No visits recorded in this range.</p>;

	const slotName = (i: number) => (mode === "weekday" ? DAY_NAMES[i] : `${i}:00`);
	const slotFigures = (i: number) =>
		`${slotName(i)}: ${count(slots[i].sessions)} ${
			slots[i].sessions === 1 ? "visit" : "visits"
		} by ${count(slots[i].people)} ${slots[i].people === 1 ? "person" : "people"}`;

	return (
		<>
			<div className="dash-timebars-head">
				<select
					className="set-select dash-input"
					value={mode}
					onChange={(e) => {
						setMode(e.target.value as Mode);
						setPicked(null);
					}}
					aria-label="Group visits by"
				>
					<option value="weekday">By day of the week</option>
					<option value="hour">By hour of the day</option>
				</select>
				{/* Not a footnote: a chart read in the wrong timezone is wrong in a
				    way that looks perfectly plausible. The server derives the
				    weekday from the same UTC timestamps as the hour, so both
				    views carry it. */}
				<span className="dash-timebars-note">Server time (UTC)</span>
			</div>

			<div
				className={`dash-timebars${mode === "hour" ? " dash-timebars--dense" : ""}`}
				data-picked={picked !== null || undefined}
			>
				{slots.map((slot, i) => {
					const label = mode === "weekday" ? DAY_NAMES[i] : hourLabel(i);
					// The same sentence three times: the tooltip for a mouse, the
					// accessible name for a screen reader, and the readout under the
					// bars for touch and keyboard.
					const figures = slotFigures(i);
					return (
						<button
							type="button"
							className={`dash-timebar${picked === i ? " dash-timebar--on" : ""}`}
							key={i}
							aria-label={figures}
							aria-pressed={picked === i}
							title={figures}
							onMouseEnter={() => setPicked(i)}
							onFocus={() => setPicked(i)}
							onClick={() => setPicked(i)}
						>
							<span
								className="dash-timebar-fill"
								// A visited hour always shows something: a 1px sliver
								// is the difference between "quiet" and "nobody", and
								// rounding it to nothing loses that.
								style={{
									height: max
										? `${Math.max(slot.sessions ? 2 : 0, (slot.sessions / max) * 100)}%`
										: "0%",
								}}
							/>
							<span className="dash-timebar-label" aria-hidden="true">{label}</span>
						</button>
					);
				})}
			</div>

			<div className="dash-trend-readout" aria-live="polite">
				{picked !== null ? (
					slotFigures(picked)
				) : (
					<span className="dash-trend-hint">Tap or hover a bar for its numbers</span>
				)}
			</div>
		</>
	);
};

export default TimeBars;
