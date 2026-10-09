import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconTrash } from "@tabler/icons-react";

// Clearing every measurement cannot be undone, so each place that offers it (the
// Measure menus of both viewers and the Measurements docks) asks once first, the
// same Keep / Discard question the reading session summary asks before it throws
// the recording away. Keep is focused, so a stray Enter never clears.

type FlyoutItemProps = {
	onClear: () => void;
	disabled?: boolean;
};

// The last row of a Measure menu: a divider, then the danger-styled Clear
// measurements row, which turns into the question in place. The menu is
// unmounted when it closes, so a half-answered question never survives a reopen.
export function ClearMeasurementsFlyoutItem({ onClear, disabled }: FlyoutItemProps) {
	const [asking, setAsking] = useState(false);
	const keepRef = useRef<HTMLButtonElement>(null);
	const rowRef = useRef<HTMLButtonElement>(null);
	const wasAsking = useRef(false);

	useEffect(() => {
		if (asking) keepRef.current?.focus();
		// A disabled row cannot take focus; the effect below has already moved it.
		else if (wasAsking.current && !rowRef.current?.disabled) rowRef.current?.focus();
		wasAsking.current = asking;
	}, [asking]);

	// The row is disabled while a live room is locked or the viewer is not ready, so a
	// question already showing when that happens is withdrawn rather than left live.
	useEffect(() => {
		if (!disabled) return;
		// The question is about to unmount and the row is disabled, so focus on Keep or on
		// Clear would fall to the page while the menu stays open. Hand it to the menu
		// panel, as Clear all does.
		const active = document.activeElement;
		const panel = active?.closest('[data-flyout-confirm]') ? active.closest<HTMLElement>('[role="dialog"]') : null;
		if (panel) {
			if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;
			panel.focus({ preventScroll: true });
		}
		setAsking(false);
	}, [disabled]);

	return (
		<>
			<div className="vp-flyout__divider" role="separator" />
			{asking ? (
				<div
					className="vp-flyout__confirm"
					role="group"
					aria-label="Clear all measurements?"
					data-flyout-confirm=""
					onKeyDown={(e) => {
						if (e.key !== "Escape") return;
						// Backs out of the question only; the menu stays open (the flyout
						// hook leaves Escape alone while this group is showing).
						e.stopPropagation();
						setAsking(false);
					}}
				>
					<span className="vp-flyout__confirm-ask">Clear all measurements?</span>
					<div className="vp-flyout__confirm-btns">
						<button ref={keepRef} type="button" className="vp-flyout__confirm-btn" onClick={() => setAsking(false)}>
							Keep
						</button>
						<button
							type="button"
							className="vp-flyout__confirm-btn vp-flyout__confirm-btn--danger"
							disabled={disabled}
							onClick={() => {
								setAsking(false);
								onClear();
							}}
						>
							Clear
						</button>
					</div>
				</div>
			) : (
				<button
					ref={rowRef}
					type="button"
					className="vp-flyout__item vp-flyout__item--danger"
					disabled={disabled}
					onClick={() => setAsking(true)}
				>
					<IconTrash size={18} />
					<span>Clear measurements</span>
				</button>
			)}
		</>
	);
}

// The Clear all chip of a Measurements dock. It becomes a Keep and Clear pair in the
// same spot, so the header keeps its height and the close button stays where it was.
export function ClearAllChips({ onClear, disabled }: { onClear: () => void; disabled?: boolean }) {
	const [asking, setAsking] = useState(false);
	const keepRef = useRef<HTMLButtonElement>(null);
	const clearRef = useRef<HTMLButtonElement>(null);
	const wasAsking = useRef(false);

	useEffect(() => {
		if (asking) keepRef.current?.focus();
		else if (wasAsking.current && !clearRef.current?.hidden) clearRef.current?.focus();
		wasAsking.current = asking;
	}, [asking]);

	// A locked or disconnected live room hides the chips. They stay mounted (just not
	// shown) so this layout effect can take focus off them before the next paint: no
	// frame of live-looking chips, and focus never falls to the page. Focus that was
	// elsewhere is left alone.
	useLayoutEffect(() => {
		if (!disabled) return;
		const active = document.activeElement;
		const onChips = active === clearRef.current || !!active?.closest(".vp-panel-head__confirm");
		const panel = onChips ? active?.closest<HTMLElement>('[role="region"]') : null;
		if (panel) {
			if (!panel.hasAttribute("tabindex")) panel.tabIndex = -1;
			panel.focus({ preventScroll: true });
		}
		setAsking(false);
	}, [disabled]);

	const hiddenStyle = disabled ? { display: "none" } : undefined;
	if (asking) {
		return (
			<div
				className="vp-panel-head__confirm"
				style={hiddenStyle}
				role="group"
				aria-label="Clear all measurements?"
				onKeyDown={(e) => {
					if (e.key !== "Escape") return;
					e.stopPropagation();
					setAsking(false);
				}}
			>
				<button ref={keepRef} type="button" className="vp-panel-head__chip" onClick={() => setAsking(false)}>
					Keep
				</button>
				<button
					type="button"
					className="vp-panel-head__chip vp-panel-head__chip--danger"
					onClick={(e) => {
						// Clearing empties the list, which unmounts this chip with focus on it.
						// Hand focus to the panel first, as deleting the last row does.
						const panel = e.currentTarget.closest<HTMLElement>('[role="region"]');
						if (panel) {
							panel.tabIndex = -1;
							panel.focus({ preventScroll: true });
						}
						setAsking(false);
						onClear();
					}}
				>
					Clear all
				</button>
			</div>
		);
	}
	return (
		<button ref={clearRef} type="button" className="vp-panel-head__chip" style={hiddenStyle} hidden={disabled} onClick={() => setAsking(true)}>
			Clear all
		</button>
	);
}
