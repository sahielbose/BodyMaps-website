import { geoNaturalEarth1, geoPath } from "d3-geo";
import { useEffect, useMemo, useRef, useState } from "react";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { alpha2ForFeatureId } from "./isoCountries";
import { count } from "./format";

// Sessions by country, as a choropleth — the panel this dashboard was missing
// and the one thing Wix's traffic overview does that a bar list can't: "most of
// our traffic is European" is a shape, not a ranking.
//
// Drawn as plain SVG from d3-geo's projection maths. No map library and no
// tiles: tiles would mean requests to a third party on an admin page whose
// whole point is that nothing about this site's visitors leaves the server.
//
// The topology is loaded on demand rather than imported at the top. It is
// ~100KB of JSON that only admins ever see, and bundling it statically would
// put it in the chunk every visitor downloads.

const NATURAL_EARTH_RATIO = 0.49; // height/width of the projection's extent
const WIDTH = 900;
const HEIGHT = Math.round(WIDTH * NATURAL_EARTH_RATIO);

// Five steps of the brand blue. A sequential ramp, because the quantity is a
// count with a meaningful zero; the lightest step is the same wash the bars use
// for their track, so "some" and "none" stay visibly different.
const RAMP = [
	"rgba(0, 45, 114, 0.10)",
	"rgba(0, 45, 114, 0.28)",
	"rgba(0, 45, 114, 0.46)",
	"rgba(0, 45, 114, 0.68)",
	"rgba(0, 45, 114, 0.92)",
];
const NO_DATA = "rgba(0, 0, 0, 0.045)";

type CountryRow = {
	country_code: string;
	country_name: string;
	sessions: number;
	people: number;
};

type Props = {
	rows: CountryRow[];
	/** Currently drilled-into country (alpha-2), or "" for the whole world. */
	selected: string;
	onSelect: (countryCode: string) => void;
};

type Hover = {
	name: string;
	sessions: number;
	people: number;
	x: number;
	y: number;
	/** Width of the map wrapper, so the tip can flip before it leaves it. */
	width: number;
};

/** Which of the five bands a country's sessions fall in.
 *
 *  Bands are cut on the square root of the maximum rather than linearly:
 *  traffic is long-tailed — one country usually has an order of magnitude more
 *  than the rest — and linear cuts would put everywhere except the leader in
 *  the palest band, which is the map saying nothing. */
const bandFor = (sessions: number, max: number): number => {
	if (sessions <= 0 || max <= 0) return -1;
	const scaled = Math.sqrt(sessions) / Math.sqrt(max);
	return Math.min(RAMP.length - 1, Math.floor(scaled * RAMP.length));
};

const WorldMap: React.FC<Props> = ({ rows, selected, onSelect }) => {
	const [land, setLand] = useState<FeatureCollection<Geometry> | null>(null);
	const [failed, setFailed] = useState(false);
	const [hover, setHover] = useState<Hover | null>(null);
	const wrapRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		import("world-atlas/countries-110m.json")
			.then((mod) => {
				if (!live) return;
				// Through `unknown`: TypeScript infers the imported JSON's literal
				// shape, where `transform.scale` is number[] rather than the
				// [number, number] tuple topojson's Topology declares. The two
				// don't overlap enough for a direct cast, and the file really is
				// a Topology — it is topojson's own published atlas.
				const topology = (mod.default ?? mod) as unknown as Topology;
				const collection = feature(
					topology,
					topology.objects.countries,
				) as FeatureCollection<Geometry>;
				setLand(collection);
			})
			.catch(() => live && setFailed(true));
		return () => { live = false; };
	}, []);

	const byCountry = useMemo(
		() => new Map(rows.map((r) => [r.country_code, r])),
		[rows],
	);
	const max = useMemo(
		() => rows.reduce((m, r) => Math.max(m, r.sessions), 0),
		[rows],
	);

	// The projection is fixed, so the path generator is built once rather than
	// per country per render — there are ~180 of them.
	const path = useMemo(() => {
		const projection = geoNaturalEarth1().fitSize([WIDTH, HEIGHT], { type: "Sphere" });
		return geoPath(projection);
	}, []);

	// A tap on a phone fires no mouseleave, so the tip would stay up after it.
	// Any press that does not land on a country with visits closes it.
	const tipShown = hover !== null;
	useEffect(() => {
		if (!tipShown) return;
		const close = (e: PointerEvent) => {
			const target = e.target as Element | null;
			if (!target?.closest?.(".dash-map-country--live")) setHover(null);
		};
		document.addEventListener("pointerdown", close);
		return () => document.removeEventListener("pointerdown", close);
	}, [tipShown]);

	if (failed) {
		return <p className="dash-empty">Couldn't load the map outline.</p>;
	}
	if (!land) {
		return <p className="dash-empty">Loading the map…</p>;
	}
	if (!rows.length) {
		return (
			<p className="dash-empty">No visitor locations recorded for these filters.</p>
		);
	}

	const enter = (e: React.MouseEvent, row: CountryRow) => {
		const box = wrapRef.current?.getBoundingClientRect();
		setHover({
			name: row.country_name,
			sessions: row.sessions,
			people: row.people,
			x: e.clientX - (box?.left ?? 0),
			y: e.clientY - (box?.top ?? 0),
			width: box?.width ?? 0,
		});
	};

	return (
		<div className="dash-map" ref={wrapRef}>
			<svg
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				className="dash-map-svg"
				role="img"
				aria-label="Sessions by country. The same figures are listed beside the map."
			>
				{(land.features as Feature<Geometry>[]).map((shape, i) => {
					const code = alpha2ForFeatureId(shape.id as string | number | undefined);
					const row = code ? byCountry.get(code) : undefined;
					const band = row ? bandFor(row.sessions, max) : -1;
					const isSelected = !!code && code === selected;
					const d = path(shape) || undefined;
					if (!d) return null;

					// Countries with no sessions are drawn but inert: they are the
					// outline that makes the filled ones legible, not data.
					return (
						<path
							key={shape.id != null ? String(shape.id) : `shape-${i}`}
							d={d}
							className={`dash-map-country${row ? " dash-map-country--live" : ""}${
								isSelected ? " dash-map-country--on" : ""}`}
							fill={band >= 0 ? RAMP[band] : NO_DATA}
							onMouseMove={row ? (e) => enter(e, row) : undefined}
							onMouseLeave={row ? () => setHover(null) : undefined}
							onClick={row && code ? () => onSelect(isSelected ? "" : code) : undefined}
						/>
					);
				})}
			</svg>

			{hover && (
				<div
					// Past the middle the tip opens to the left of the pointer, so on a
					// phone it is not cut off at the edge of the page.
					className={`dash-map-tip${hover.x > hover.width / 2 ? " dash-map-tip--left" : ""}`}
					style={{ left: hover.x, top: hover.y }}
					aria-hidden="true"
				>
					<strong>{hover.name}</strong>
					<br />
					{count(hover.sessions)} {hover.sessions === 1 ? "visit" : "visits"} ·{" "}
					{count(hover.people)} {hover.people === 1 ? "person" : "people"}
				</div>
			)}

			<div className="dash-map-key" aria-hidden="true">
				<span className="dash-map-key-label">Fewer</span>
				{RAMP.map((fill) => (
					<span key={fill} className="dash-map-key-step" style={{ background: fill }} />
				))}
				<span className="dash-map-key-label">More</span>
			</div>
		</div>
	);
};

export default WorldMap;
