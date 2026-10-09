// A ranked bar list: the answer to "which of these is used most".
//
// One hue for every bar, on purpose. Colour here would encode rank, and rank is
// already encoded by length and order — a per-row colour would mean a filter
// that drops one row repaints all the others, which reads as the data changing
// when only the selection did. The row label carries identity; the bar carries
// magnitude and nothing else.

export type Bar = {
	/** The row's identity. Also the tooltip's title. */
	label: string;
	/** What the bar length is proportional to. */
	value: number;
	/** Shown at the end of the bar. Defaults to the value. */
	display?: string;
	/** Small grey text after the label — a count, a share, a second measure. */
	note?: string;
	/** Full sentence on hover. */
	title?: string;
	/** What onSelect is called with. Only rows with one can be picked. */
	id?: string;
};

const BarList: React.FC<{
	bars: Bar[];
	empty?: string;
	/** Makes each row's label a toggle button (the country list beside the
	 *  map, so its filter works from the keyboard too, not only by clicking
	 *  the map). */
	onSelect?: (id: string) => void;
	/** The id currently picked, if any. */
	selected?: string;
}> = ({
	bars,
	empty = "Nothing recorded in this range.",
	onSelect,
	selected,
}) => {
	if (!bars.length) return <p className="dash-empty">{empty}</p>;

	// Scaled to the largest bar, not to the sum: this answers "which is biggest",
	// and a share-of-total scale would leave every bar short and unreadable when
	// there are twenty of them.
	const max = Math.max(...bars.map((b) => b.value), 1);

	return (
		<ol className="dash-bars">
			{bars.map((b) => (
				<li className="dash-bar-row" key={b.label} title={b.title}>
					<span className="dash-bar-label">
						{onSelect && b.id ? (
							<button
								type="button"
								className="dash-bar-pick"
								aria-pressed={selected === b.id}
								onClick={() => onSelect(b.id!)}
							>
								{b.label}
							</button>
						) : (
							b.label
						)}
						{b.note && <span className="dash-bar-note">{b.note}</span>}
					</span>
					<span className="dash-bar-track">
						<span
							className="dash-bar-fill"
							style={{ width: `${Math.max((b.value / max) * 100, b.value > 0 ? 1.5 : 0)}%` }}
						/>
					</span>
					<span className="dash-bar-value">{b.display ?? b.value.toLocaleString()}</span>
				</li>
			))}
		</ol>
	);
};

export default BarList;
