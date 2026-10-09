// helpers/viewer/crosshairMode.ts
//
// The Crosshair toolbar button's state. Crosshair navigation only owns the
// primary mouse button while nothing else is armed, so the button reads as on
// only then, and a click from any other tool is a request to get back to
// navigating rather than a toggle.

export interface CrosshairModeInput {
	/** The viewer's crosshair-navigation flag. */
	crosshairToolActive: boolean;
	/** A measurement tool (distance, ROI, ...) owns the primary button. */
	measureToolArmed: boolean;
	/** A mask edit mode (brush, eraser, lasso, seeds) owns the primary button. */
	editToolArmed: boolean;
	/** An nnInteractive prompt tool owns the primary button. */
	promptToolArmed: boolean;
}

/** Whether crosshair navigation is what the mouse does right now. */
export function crosshairModeShown(s: CrosshairModeInput): boolean {
	return s.crosshairToolActive && !s.measureToolArmed && !s.editToolArmed && !s.promptToolArmed;
}

/** The crosshair-navigation flag after a click on the Crosshair button: on
 *  when leaving another tool (one click, not two), off only when crosshair
 *  mode was already the active one. */
export function crosshairAfterClick(s: CrosshairModeInput): boolean {
	return !crosshairModeShown(s);
}
