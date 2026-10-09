// A flyout trigger whose label follows a choice (the layout, the CT preset) is
// sized to its longest usual label, so picking "Bone" or "Coronal" doesn't
// shift every icon to its right. The other labels sit invisibly in the
// same grid cell; the trigger's aria-label names it for assistive tech.
export default function TriggerLabel({ current, options }: { current: string; options: readonly string[] }) {
	return (
		<span className="vp-tb-mini__label">
			{options.map((o) => (
				<span key={o} className="vp-tb-mini__sizer" aria-hidden="true">{o}</span>
			))}
			<span>{current}</span>
		</span>
	);
}
