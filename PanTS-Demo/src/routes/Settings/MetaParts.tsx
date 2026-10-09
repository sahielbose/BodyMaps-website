import { Fragment } from "react";
import "./analytics/dashboard.css";

/** A line of short facts. The dot between two of them is drawn in CSS by the
 *  part it leads, and clipped where a part starts a wrapped line, so a line
 *  never begins with one; the name is the one part allowed to wrap inside
 *  itself. Shared by the People and History rows. */
const MetaParts: React.FC<{ parts: (false | "" | null | undefined | { text: string; wrap?: boolean })[] }> = ({ parts }) => (
	<span className="dash-meta">
		<span className="dash-meta-row">
			{parts.map((part, i) =>
				part ? (
					<Fragment key={i}>
						{/* Flex drops the space, but it keeps the parts apart for a screen
						    reader and for copied text. */}
						{i > 0 && " "}
						<span className={`dash-meta-part${part.wrap ? " dash-meta-part--wrap" : ""}`}>{part.text}</span>
					</Fragment>
				) : null,
			)}
		</span>
	</span>
);

export default MetaParts;
