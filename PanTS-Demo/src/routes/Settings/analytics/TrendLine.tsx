import { useRef, useState } from "react";
import { plural, shortDay } from "./format";

// Activity over the range: one series, one line, hover (or arrow keys) for the
// day's numbers.
//
// A line rather than bars because the question is the shape of the trend, not
// the comparison of individual days. Single series, so no legend — the panel
// heading names it.

type Point = { day: string; events: number; people: number };

const W = 720;
const H = 160;
const PAD = { top: 12, right: 12, bottom: 22, left: 12 };

const dayString = (d: Date): string =>
	`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** One entry per calendar day of the range. The server only has rows for days
 *  with events, so a quiet day is filled in as zero: without it the line joins
 *  the busy days as neighbours and a silent week reads as a gentle slope.
 *  The end is exclusive when it is a picked "to" date (the next midnight),
 *  the same reading `lastDay` gives it. */
const everyDay = (points: Point[], start: string, end: string): Point[] => {
	const byDay = new Map(points.map((p) => [p.day, p]));
	const first = new Date(`${start.slice(0, 10)}T00:00:00`);
	const last = new Date(`${end.slice(0, 10)}T00:00:00`);
	if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return points;
	if (/T00:00:00(\.0+)?$/.test(end)) last.setDate(last.getDate() - 1);
	const days: Point[] = [];
	for (const d = first; d <= last; d.setDate(d.getDate() + 1)) {
		const day = dayString(d);
		days.push(byDay.get(day) ?? { day, events: 0, people: 0 });
	}
	// A row outside the stated range (a timezone edge) is kept, not dropped.
	const shown = new Set(days.map((p) => p.day));
	const extra = points.filter((p) => !shown.has(p.day));
	return extra.length ? [...days, ...extra].sort((a, b) => (a.day < b.day ? -1 : 1)) : days;
};

const TrendLine: React.FC<{ points: Point[]; start: string; end: string }> = ({
	points: rows, start, end,
}) => {
	const [hover, setHover] = useState<number | null>(null);
	// Set when the chart took focus from a click or tap rather than the keyboard.
	const pointerFocus = useRef(false);
	const points = everyDay(rows, start, end);

	if (points.length < 2) {
		return <p className="dash-empty">Not enough days in this range to draw a trend.</p>;
	}

	const max = Math.max(...points.map((p) => p.events), 1);
	const innerW = W - PAD.left - PAD.right;
	const innerH = H - PAD.top - PAD.bottom;

	const x = (i: number) => PAD.left + (i / (points.length - 1)) * innerW;
	const y = (v: number) => PAD.top + innerH - (v / max) * innerH;

	const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.events)}`).join(" ");
	const area = `${line} L${x(points.length - 1)},${PAD.top + innerH} L${x(0)},${PAD.top + innerH} Z`;

	// Only the ends are labelled: a date under every point collides as soon as
	// the range is longer than a fortnight.
	const active = hover !== null ? points[hover] : null;

	return (
		<div className="dash-trend">
			<svg
				viewBox={`0 0 ${W} ${H}`}
				className="dash-trend-svg"
				// A slider rather than an image: the arrows, Home and End step
				// through the days, and screen readers pass those keys through to
				// a slider. One tab stop for the whole chart rather than one per
				// day, since a range can be months long.
				role="slider"
				aria-label={`Events per day, ${shortDay(points[0].day)} to ${shortDay(points[points.length - 1].day)}`}
				aria-orientation="horizontal"
				aria-valuemin={1}
				aria-valuemax={points.length}
				aria-valuenow={(hover ?? 0) + 1}
				aria-valuetext={active ? `${shortDay(active.day)}, ${plural(active.events, "event", "events")}, ${plural(active.people, "person", "people")}` : undefined}
				tabIndex={0}
				onFocus={() => setHover((h) => h ?? 0)}
				// Only a mousedown that moves focus marks this as pointer focus. A click on
				// a chart that is already focused leaves the mark alone, so a keyboard
				// place is kept and a chart the mouse focused still clears on leave.
				onMouseDown={(e) => {
					if (document.activeElement !== e.currentTarget) pointerFocus.current = true;
				}}
				onKeyDown={(e) => {
					const last = points.length - 1;
					const next = e.key === "ArrowRight" ? Math.min((hover ?? -1) + 1, last)
						: e.key === "ArrowLeft" ? Math.max((hover ?? last + 1) - 1, 0)
						: e.key === "Home" ? 0
						: e.key === "End" ? last
						: null;
					if (next === null) return;
					e.preventDefault();
					pointerFocus.current = false;
					setHover(next);
				}}
				onBlur={() => {
					pointerFocus.current = false;
					setHover(null);
				}}
				// The same state holds the keyboard's place, so a pointer leaving a
				// chart that still has keyboard focus must not take that place away.
				// A chart focused by the click itself has no keyboard place to keep.
				onMouseLeave={(e) => {
					if (pointerFocus.current || document.activeElement !== e.currentTarget) setHover(null);
				}}
			>
				<path d={area} className="dash-trend-area" />
				<path d={line} className="dash-trend-line" />

				{active && (
					<line
						x1={x(hover!)} x2={x(hover!)}
						y1={PAD.top} y2={PAD.top + innerH}
						className="dash-trend-crosshair"
					/>
				)}
				{points.map((p, i) => (
					<circle
						key={p.day}
						cx={x(i)}
						cy={y(p.events)}
						r={hover === i ? 4.5 : 0}
						className="dash-trend-dot"
					/>
				))}

				{/* Hit areas: a full-height column per point, so the line doesn't
				    have to be hit precisely. */}
				{points.map((p, i) => (
					<rect
						key={`hit-${p.day}`}
						x={x(i) - innerW / (points.length - 1) / 2}
						y={PAD.top}
						width={innerW / (points.length - 1)}
						height={innerH}
						fill="transparent"
						onMouseEnter={() => setHover(i)}
					/>
				))}

				<text x={PAD.left} y={H - 6} className="dash-trend-axis">
					{shortDay(points[0].day)}
				</text>
				<text x={W - PAD.right} y={H - 6} textAnchor="end" className="dash-trend-axis">
					{shortDay(points[points.length - 1].day)}
				</text>
			</svg>

			<div className="dash-trend-readout" aria-live="polite">
				{active ? (
					<>
						<strong>{shortDay(active.day)}</strong> · {plural(active.events, "event", "events")} ·{" "}
						{plural(active.people, "person", "people")}
					</>
				) : (
					<span className="dash-trend-hint">Hover or focus a day for its numbers</span>
				)}
			</div>
		</div>
	);
};

export default TrendLine;
