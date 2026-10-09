import type { ReactNode } from "react";
import { IconX } from "@tabler/icons-react";

type Props = {
	title: string;
	/** Lets the panel's region be labelled by its visible title. */
	titleId?: string;
	closeLabel: string;
	onClose: () => void;
	/** Export / clear / toggle chips, drawn before the close button. Use .vp-panel-head__chip. */
	children?: ReactNode;
};

// The one header of the viewer's four docks (Organs, Organ statistics, Case
// metadata, Measurements): same height, title style and close button, so the
// docks read as one family and swapping between them does not jump the layout.
function PanelHeader({ title, titleId, closeLabel, onClose, children }: Props) {
	return (
		<div className="vp-panel-head">
			<span className="vp-panel__title" id={titleId}>{title}</span>
			<div className="vp-panel-head__actions">
				{children}
				<button type="button" className="vp-panel-head__close" onClick={onClose} aria-label={closeLabel}>
					<IconX size={16} aria-hidden="true" />
				</button>
			</div>
		</div>
	);
}

export default PanelHeader;
