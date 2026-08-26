import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
	IconEye, IconEyeOff, IconTrash, IconPlus, IconStack2, IconSparkles,
	IconPencil,
	IconLoader2,
	IconCheck,
} from "@tabler/icons-react";
import type { CheckBoxData } from "../../types";
import "./SegmentsPopup.css";
import ApplyButton from "../ApplyButton";
import { GuidedStepModal } from "../segmentation/SliceAnchorPickerUI";

interface SegmentsPopupProps {
	/** Mirrors AnnotationToolbar's own `open` prop: the component stays
	 *  mounted (and its drag/resize state alive) at all times — closing just
	 *  renders null after the hooks have run — so a dragged position isn't
	 *  lost every time the panel is toggled off and back on. */
	open: boolean;
	segments: CheckBoxData[];
	colors: Record<number, string>;
	visibility: Record<number, boolean>;
	activeSegmentId: number | null;
	onSelect: (id: number | null) => void;
	onRename: (id: number, name: string) => boolean;
	onColorChange: (id: number, hex: string) => void;
	onToggleVisibility: (id: number) => void;
	onDelete: (id: number) => void;
	onCreate: (name: string, colorHex: string) => CheckBoxData | null;
	organCatalog: { id: number; label: string }[];
	activeCatalogOrganId: number | null;
	onSelectCatalogOrgan: (id: number | null) => void;

	/** Fires whenever the "any deletes currently in flight" state flips, so
	 *  the parent can surface it in AnnotationToolbar's own "Deleting…"
	 *  indicator (this popup lives outside that component). True from the
	 *  moment a delete is confirmed until the deleted class has actually
	 *  left `segments`. */
	onDeletingChange?: (isDeleting: boolean) => void;

	/** Refs the parent (VisualizationPage) attaches this component's outer
	 *  panel and header to, so AnnotationToolbar's Overview walkthrough can
	 *  spotlight this popup even though it lives outside that component. */
	containerRef?: React.RefObject<HTMLDivElement | null>;
	dragHandleRef?: React.RefObject<HTMLDivElement | null>;
	/** Kept for callers still passing it through (e.g. the walkthrough
	 *  spotlight rects) — there's no minimize button anymore, so nothing
	 *  attaches a ref to it, but removing the prop would be a breaking
	 *  change to every call site for no behavioral benefit. */
	minButtonRef?: React.RefObject<HTMLButtonElement | null>;

	/** "Show only target class" display preference — moved here (above the
	 *  organ/class list) from AnnotationToolbar's ribbon. On by default:
	 *  every class except whichever one is currently targeted is hidden
	 *  from the CT viewer. */
	showOnlyTargetMask: boolean;
	onShowOnlyTargetMaskChange: (v: boolean) => void;
	hasActiveTarget: boolean;
}

// Normalizes any organ label to Title Case ("Adrenal Gland Left") so the
// Existing-class list reads consistently regardless of how the source
// label was originally cased.
function toTitleCase(label: string): string {
	return label
		.split(/\s+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(" ");
}

// Suggested default swatch for the next new class — cycles through the
// Hopkins palette so a freshly-created class starts on-brand. Can still be
// repainted via the color input afterward.
const NEXT_COLOR_POOL = ["#0F172A", "#E76F51", "#2A344A", "#0F172A", "#E76F51", "#2A344A"];

// Applies to both the "add segment" and "rename" name fields.
const MAX_SEGMENT_NAME_LENGTH = 40;

interface ShowOnlyTargetToggleProps {
	checked: boolean;
	onChange: (v: boolean) => void;
	disabled: boolean;
}

// Display preference shown above the class list, centered — replaces the
// old per-tab hint text. Lives here (rather than in AnnotationToolbar)
// since it's a property of the list itself, not of any editing tool.
function ShowOnlyTargetToggle({ checked, onChange, disabled }: ShowOnlyTargetToggleProps) {
	return (
		<button
			type="button"
			className={`segpop__show-target ${disabled ? "is-disabled" : ""}`}
			role="checkbox"
			aria-checked={checked}
			aria-disabled={disabled}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			title={
				disabled
					? "Pick or create a class first."
					: checked
						? "On — every class except whichever one is currently targeted is hidden. Click to show every class's mask."
						: "Off — every class's mask is showing. Click to show only the targeted class's mask."
			}
		>
			<span className="segpop__show-target-box">
				<IconCheck aria-hidden="true" size={12} stroke={3} className="segpop__show-target-check" />
			</span>
			<span>Show only target class</span>
		</button>
	);
}// Kept in sync with the CSS transition durations in SegmentsPopup.css so
// JS timers gate the real state change at the right moment.
const EXIT_ANIM_MS = 200;

type PopupTab = "existing" | "custom";

// Small curated swatch set for the color popover — Hopkins palette first,
// then a handful of common accent colors so classes stay visually distinct.
const SWATCH_PRESETS = [
	"#0F172A", "#E76F51", "#2A344A", "#E85D5D", "#4CAF7D",
	"#F2B33D", "#9B6BD6", "#2FB6C4", "#D9645B", "#7C8A9E",
];

interface ColorPickerPopoverProps {
	value: string;
	onChange: (hex: string) => void;
	onClose: () => void;
	/** Swatch button this popover is anchored to — used only to compute a
	 *  fixed viewport position, since the popover itself portals to
	 *  <body> (see below) rather than rendering inline. */
	anchorRef: React.RefObject<HTMLElement | null>;
}

// Small anchored popover for picking a class color — a grid of preset
// swatches plus a native color input for anything custom. Gradually
// scales/fades in on open and back out on close (mirrors GuidedStepModal's
// treatment elsewhere in the annotation tool) instead of the browser's own
// abrupt native color picker being the only way in.
//
// Portals to <body> and positions itself with `fixed` coords computed from
// the swatch button's own rect, rather than rendering inline where
// .segpop__list/.segpop__row's overflow:hidden (needed for their own
// scroll/collapse animations) would otherwise clip it to the panel. This
// lets the popover spill out over the canvas instead of being boxed in.
function ColorPickerPopover({ value, onChange, onClose, anchorRef }: ColorPickerPopoverProps) {
	const [closing, setClosing] = useState(false);
	const popRef = useRef<HTMLDivElement>(null);
	const colorInputRef = useRef<HTMLInputElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

	const requestClose = () => {
		if (closing) return;
		setClosing(true);
		window.setTimeout(onClose, EXIT_ANIM_MS);
	};

	useEffect(() => {
		const compute = () => {
			const anchor = anchorRef.current;
			if (!anchor) return;
			const rect = anchor.getBoundingClientRect();
			const popW = popRef.current?.offsetWidth ?? 208;
			const popH = popRef.current?.offsetHeight ?? 0;
			const margin = 8;
			// Prefer opening to the right of the swatch; flip to the left if
			// it would run off the viewport edge, and clamp vertically so it
			// never gets pushed off the top/bottom either.
			let left = rect.right + margin;
			if (left + popW > window.innerWidth - margin) {
				left = rect.left - popW - margin;
			}
			left = Math.max(margin, Math.min(left, window.innerWidth - popW - margin));
			let top = rect.top;
			if (popH) top = Math.max(margin, Math.min(top, window.innerHeight - popH - margin));
			setPos({ top, left });
		};
		compute();
		window.addEventListener("resize", compute);
		window.addEventListener("scroll", compute, true);
		return () => {
			window.removeEventListener("resize", compute);
			window.removeEventListener("scroll", compute, true);
		};
	}, [anchorRef]);

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (popRef.current?.contains(e.target as Node)) return;
			if (anchorRef.current?.contains(e.target as Node)) return;
			// The native OS color picker (behind the "Custom…" <input
			// type="color">) can fire a synthetic mousedown on `document`
			// itself — outside both the input and this whole component tree —
			// when the user drags/picks within the OS dialog, in some
			// browsers. Without this guard that got misread as "clicked
			// outside the popover" and closed it mid-pick, which is exactly
			// why changing the color via the custom picker felt broken —
			// every drag/selection risked closing before it registered. Skip
			// closing while the color input itself still has focus.
			if (document.activeElement === colorInputRef.current) return;
			requestClose();
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (typeof document === "undefined" || !pos) return null;

	return createPortal(
		<div
			ref={popRef}
			data-color-popover-portal
			className={`segpop__color-popover segpop__color-popover--portaled ${closing ? "is-closing" : "is-open"}`}
			style={{ position: "fixed", top: pos.top, left: pos.left }}
			onClick={(e) => e.stopPropagation()}
		>
			<div className="segpop__color-popover-grid">
				{SWATCH_PRESETS.map((hex) => (
					<button
						key={hex}
						type="button"
						className={`segpop__color-popover-swatch ${value.toLowerCase() === hex.toLowerCase() ? "is-active" : ""}`}
						style={{ background: hex }}
						aria-label={hex}
						// Stages the color (updates the draft the caller holds) but does
						// NOT close the popover — picking a swatch used to auto-close
						// immediately, which looked like "nothing happened" since the
						// actual save is a separate action on the row below. Leaving it
						// open lets the person see the live preview/hex below update
						// and confirm with an explicit "Done" instead.
						onClick={() => onChange(hex)}
					/>
				))}
			</div>
			<label className="segpop__color-popover-custom">
				<input ref={colorInputRef} type="color" value={value} onChange={(e) => onChange(e.target.value)} />
				<span>Custom…</span>
			</label>
			{/* Explicit commit step for the popover itself — a live preview swatch
			    plus the hex value, so it's visually obvious a selection has been
			    made and staged, then "Done" closes the popover. This does NOT save
			    the class — that's still the row's own Save/ApplyButton — it just
			    makes clear the color choice registered before the popover goes
			    away, instead of a swatch click silently vanishing the popover with
			    no confirmation of what got picked. */}
			<div className="segpop__color-popover-footer">
				<span className="segpop__color-popover-preview" style={{ background: value }} aria-hidden="true" />
				<span className="segpop__color-popover-hex">{value.toUpperCase()}</span>
				<button type="button" className="segpop__color-popover-done" onClick={requestClose}>
					Done
				</button>
			</div>
		</div>,
		document.body
	);
}

// Replaces the old in-row Collapse (grid-template-rows / max-height) trick.
// That approach animated the *content's own* box open and closed inline in
// the list, which had two problems in practice: every existing row below it
// physically shifted up/down as the form expanded and collapsed (jarring
// next to a list the person is actively scanning), and its "done animating"
// signal was a CSS `transitionend` on `max-height` — which never fires if
// the browser coalesces the open→close flip within a frame, if the content's
// measured height doesn't actually change between states, or if a re-render
// interrupts the transition mid-flight. When that happened the row got stuck
// permanently in its "closing" bookkeeping state, and since the very next
// "Add class" button is gated on that same bookkeeping having cleared, it
// would silently stop appearing at all.
//
// This instead portals the add/edit form to <body> as a small floating
// panel anchored (fixed position, computed off the trigger button's own
// rect) next to whatever it's editing — same mechanism already proven out
// by ColorPickerPopover above. Existing rows and icons never move, because
// the form isn't part of their flex flow at all. And open/close is driven
// entirely by this component's own JS timer (mirroring
// ColorPickerPopover's `requestClose`), never by waiting on a transition
// event, so there's no path left where it can get stuck.
interface FormFlyoutProps {
	/** The button this flyout is anchored to and points at with its little
	 *  pointer/arrow — the "Add class" button, or a row's pencil icon. */
	anchorEl: HTMLElement | null;
	/** Called once the close animation has actually finished — the right
	 *  moment for the caller to unmount this flyout / clear its target id. */
	onClose: () => void;
	/** Render prop so Cancel / successful-Enter / successful-Apply inside
	 *  the form can all trigger the same gradual close by calling this,
	 *  instead of each needing its own copy of the animate-then-unmount
	 *  logic. */
	children: (requestClose: () => void) => React.ReactNode;
}

function FormFlyout({ anchorEl, onClose, children }: FormFlyoutProps) {
	const [closing, setClosing] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number; arrowLeft: number } | null>(null);

	const requestClose = () => {
		if (closing) return;
		setClosing(true);
		window.setTimeout(onClose, EXIT_ANIM_MS);
	};

	useEffect(() => {
		const compute = () => {
			if (!anchorEl) return;
			const rect = anchorEl.getBoundingClientRect();
			const panelW = panelRef.current?.offsetWidth ?? 260;
			const panelH = panelRef.current?.offsetHeight ?? 0;
			const margin = 8;
			// Prefer opening just below the trigger, left-aligned to it;
			// clamp horizontally so it never runs off the viewport edge,
			// and flip above the trigger if there isn't room below.
			let left = rect.left;
			left = Math.max(margin, Math.min(left, window.innerWidth - panelW - margin));
			let top = rect.bottom + 10;
			if (panelH && top + panelH > window.innerHeight - margin) {
				top = rect.top - panelH - 10;
			}
			// Point the little pointer at the trigger's own center, clamped
			// to stay within the panel's own width.
			const arrowLeft = Math.max(14, Math.min(rect.left + rect.width / 2 - left, panelW - 14));
			setPos({ top, left, arrowLeft });
		};
		compute();
		window.addEventListener("resize", compute);
		window.addEventListener("scroll", compute, true);
		return () => {
			window.removeEventListener("resize", compute);
			window.removeEventListener("scroll", compute, true);
		};
	}, [anchorEl]);

	useEffect(() => {
		const onDown = (e: MouseEvent) => {
			if (panelRef.current?.contains(e.target as Node)) return;
			if (anchorEl?.contains(e.target as Node)) return;
			// The color swatch popover portals to document.body on its OWN,
			// separate from this FormFlyout's portal — so a click on a preset
			// swatch or the native color input isn't a descendant of either
			// panelRef or anchorEl, and without this check got misread as
			// "clicked outside the name/color editor," closing the whole
			// editor instead of just the small color popover. The color
			// popover already closes itself independently on its own outside
			// click; this just stops THIS flyout from also reacting to a
			// click that was actually still inside it, conceptually.
			if ((e.target as Element | null)?.closest?.("[data-color-popover-portal]")) return;
			requestClose();
		};
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [anchorEl]);

	if (typeof document === "undefined" || !pos) return null;

	return createPortal(
		<div
			ref={panelRef}
			className={`segpop__form-flyout ${closing ? "is-closing" : "is-open"}`}
			style={{ position: "fixed", top: pos.top, left: pos.left }}
			onClick={(e) => e.stopPropagation()}
		>
			<span className="segpop__form-flyout-arrow" style={{ left: pos.arrowLeft }} />
			{children(requestClose)}
		</div>,
		document.body
	);
}



// Gap kept clear between the docked panel's top edge and the main topbar
// above it (--vp-topbar-h — see VisualizationPage.css). The annotation
// ribbon used to be a full-width bar docked directly under the topbar, so
// this used to also add --atb-ribbon-h/--atb-panel-h to clear it. It's now
// a small centered floating popout (see .atb-shell in AnnotationToolbar.css)
// that no longer occupies the top-right corner where this panel docks, so
// there's nothing left to clear there — the panel can sit right under the
// topbar instead of leaving room for a ribbon that isn't in its way anymore.
const DOCK_CLEARANCE = "calc(var(--vp-topbar-h, 0px) + 15px)";
const POPUP_WIDTH = 320;
const POPUP_MIN_WIDTH = 240;
const POPUP_MAX_WIDTH = 560;
const RIGHT_MARGIN = 0; // flush to the viewport edge, same as AISidebar

/**
 * Segments panel — docked to the top-right, directly beneath the main
 * topbar (the annotation ribbon floats separately as a small centered
 * popout and no longer reserves space here), like a permanent slide-in
 * side panel (same pattern as the AI sidebar) rather than a freely
 * draggable window that can end up sitting on top of the CT viewer.
 * Only its width is still adjustable
 * (drag the left edge) so it can be made more or less roomy for long
 * segment names; it never moves off its docked corner. Minimizable to a
 * small horizontal bar.
 */
export default function SegmentsPopup({
	open, segments, colors, visibility, activeSegmentId,
	onSelect, onRename, onColorChange, onToggleVisibility, onDelete, onCreate, onDeletingChange,
	organCatalog, activeCatalogOrganId, onSelectCatalogOrgan,
	containerRef, dragHandleRef,
	showOnlyTargetMask, onShowOnlyTargetMaskChange, hasActiveTarget,
}: SegmentsPopupProps) {
	// Horizontal resize — drag the left edge to widen/narrow the docked
	// panel. The handle sits on the LEFT edge (the popup is anchored to the
	// right side of the viewport) so growing it extends leftward, away from
	// the dock, while the right edge stays flush against the viewport.
	const [width, setWidth] = useState(POPUP_WIDTH);
	const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

	useEffect(() => {
		const onMove = (e: PointerEvent) => {
			const st = resizeStateRef.current;
			if (!st) return;
			const delta = st.startX - e.clientX; // dragging left = positive delta = wider
			// Also clamp against the window so the panel can never be dragged
			// wide enough to crush the CT stage on narrow screens (matches the
			// 45vw cap VisualizationPage.css puts on the reserved gutter).
			const maxW = Math.min(POPUP_MAX_WIDTH, Math.floor(window.innerWidth * 0.45));
			const next = Math.min(maxW, Math.max(POPUP_MIN_WIDTH, st.startWidth + delta));
			setWidth(next);
		};
		const onUp = () => { resizeStateRef.current = null; };
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, []);

	const startResize = (e: React.PointerEvent) => {
		e.preventDefault();
		e.stopPropagation();
		resizeStateRef.current = { startX: e.clientX, startWidth: width };
	};

	// Keep --atb-segpanel-w in sync with the panel's real width (0 when
	// closed) so VisualizationPage.css's `padding-right: var(--atb-segpanel-w)`
	// reserves the actual space instead of a hardcoded fallback, letting
	// the CT viewer shrink to make room as this panel is resized.
	useEffect(() => {
		const root = document.documentElement;
		root.style.setProperty("--atb-segpanel-w", open ? `${width}px` : "0px");
	}, [open, width]);

	const [tab, setTab] = useState<PopupTab>("existing");
	// `adding` drives whether the Add-class FormFlyout is mounted at all —
	// no separate "still animating closed" bookkeeping needed anymore since
	// FormFlyout owns its own close animation/timer internally and only
	// calls back once it's genuinely done.
	const [adding, setAdding] = useState(false);
	const [addAnchorEl, setAddAnchorEl] = useState<HTMLElement | null>(null);
	const [draftName, setDraftName] = useState("");
	const [draftColor, setDraftColor] = useState(NEXT_COLOR_POOL[segments.length % NEXT_COLOR_POOL.length]);
	const [createError, setCreateError] = useState("");
	const [addColorPopoverOpen, setAddColorPopoverOpen] = useState(false);

	// Combined name+color editor, opened via the pen icon (replaces the old
	// double-click-to-rename-only flow — both fields are changed and
	// confirmed together, in one place). Same "no separate mounted flag"
	// simplification as `adding` above — the FormFlyout itself tracks its
	// close animation.
	const [editingId, setEditingId] = useState<number | null>(null);
	const [editAnchorEl, setEditAnchorEl] = useState<HTMLElement | null>(null);
	const [editNameDraft, setEditNameDraft] = useState("");
	const [editColorDraft, setEditColorDraft] = useState("#ffffff");
	const [renameError, setRenameError] = useState<number | null>(null);
	const [editColorPopoverOpen, setEditColorPopoverOpen] = useState(false);
	// Anchors for the portaled ColorPickerPopover — one swatch button lives
	// in the add-form flyout, the other in the edit flyout, and only one of
	// either is ever mounted at a time, but keeping separate refs avoids
	// them fighting over a single ref across renders.
	const addColorBtnRef = useRef<HTMLButtonElement>(null);
	const editColorBtnRef = useRef<HTMLButtonElement>(null);

	// Deletion can take a moment on the backend — track in-flight deletes
	// locally so the row can show a spinner instead of looking unresponsive,
	// and so it can fade/collapse out smoothly before it actually leaves the
	// list rather than disappearing the instant the click lands.
	const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());
	useEffect(() => {
		setDeletingIds((prev) => {
			if (prev.size === 0) return prev;
			const stillPresent = new Set(segments.map((s) => s.id));
			const next = new Set([...prev].filter((id) => stillPresent.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [segments]);

	// Tell the parent (VisualizationPage → AnnotationToolbar) whenever the
	// "something is deleting" state actually flips, not on every render —
	// onDeletingChange isn't guaranteed to be referentially stable, so this
	// only fires on a real true/false transition.
	const wasDeletingRef = useRef(false);
	useEffect(() => {
		const isDeleting = deletingIds.size > 0;
		if (isDeleting !== wasDeletingRef.current) {
			wasDeletingRef.current = isDeleting;
			onDeletingChange?.(isDeleting);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [deletingIds]);

	// Class awaiting delete confirmation — the trash icon no longer deletes
	// on the first click; it opens this confirm overlay (same GuidedStepModal
	// treatment as the guided-flow tools) and only Delete-in-the-overlay
	// actually triggers handleDelete's fade-out + real removal.
	const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

	const handleDelete = (id: number) => {
		setDeletingIds((prev) => new Set(prev).add(id));
		// Let the row play its fade/collapse-out transition before the
		// underlying delete actually lands and yanks it out of the list.
		window.setTimeout(() => onDelete(id), EXIT_ANIM_MS);
	};

	const switchTab = (next: PopupTab) => {
		setTab(next);
		setAdding(false);
		setCreateError("");
		setEditingId(null);
		setConfirmDeleteId(null);
	};

	const startAdd = (e: React.MouseEvent<HTMLButtonElement>) => {
		setAddAnchorEl(e.currentTarget);
		setAdding(true);
		setDraftName("");
		setCreateError("");
		setDraftColor(NEXT_COLOR_POOL[segments.length % NEXT_COLOR_POOL.length]);
	};

	// Fully closes the add flyout immediately — used when something else
	// (switching tabs, deleting) needs it gone right away, with no need for
	// its own gradual close animation. The FormFlyout's own Cancel/Enter/
	// Apply paths instead call the `requestClose` it hands them, which
	// plays the close animation first and calls this once it's done.
	const closeAddForm = () => {
		setAddColorPopoverOpen(false);
		setAdding(false);
		setAddAnchorEl(null);
	};

	const commitAdd = (): boolean => {
		const trimmed = draftName.trim();
		if (!trimmed) { setCreateError("Enter a name."); return false; }
		const lower = trimmed.toLowerCase();
		const dupCustom = segments.some((s) => s.label.toLowerCase() === lower);
		const dupCatalog = organCatalog.some((o) => o.label.toLowerCase() === lower);
		if (dupCustom || dupCatalog) {
			setCreateError(
				dupCatalog
					? "That name matches an existing class — pick it from the Existing tab instead."
					: "That name is already used."
			);
			return false;
		}
		const created = onCreate(trimmed, draftColor);
		if (!created) { setCreateError("Could not create class."); return false; }
		setDraftName("");
		setCreateError("");
		// Closing the form (its own fade/collapse-out) is deferred to
		// ApplyButton's onDone, which fires once the "Added" checkmark has
		// had a beat on screen — so the confirmation is actually seen
		// before the form collapses, instead of both happening at once.
		return true;
	};

	const startEdit = (id: number, currentName: string, currentColor: string, anchorEl: HTMLElement) => {
		setEditingId(id);
		setEditAnchorEl(anchorEl);
		setEditNameDraft(currentName);
		setEditColorDraft(currentColor);
		setRenameError(null);
	};
	// Immediately closes the edit flyout — see closeAddForm's note above for
	// why this is separate from the FormFlyout's own animated requestClose.
	const closeEdit = (id: number) => {
		setEditColorPopoverOpen(false);
		setEditingId((cur) => (cur === id ? null : cur));
		setEditAnchorEl(null);
	};
	const cancelEdit = () => {
		if (editingId == null) return;
		setRenameError(null);
		closeEdit(editingId);
	};
	const commitEdit = (id: number): boolean => {
		const trimmed = editNameDraft.trim();
		if (!trimmed) { cancelEdit(); return false; }
		const lower = trimmed.toLowerCase();
		const dupCustom = segments.some((s) => s.id !== id && s.label.toLowerCase() === lower);
		const dupCatalog = organCatalog.some((o) => o.label.toLowerCase() === lower);
		if (dupCustom || dupCatalog) { setRenameError(id); return false; }
		const renamed = onRename(id, trimmed);
		if (!renamed) { setRenameError(id); return false; }
		onColorChange(id, editColorDraft);
		setRenameError(null);
		// Closing the edit row is deferred to ApplyButton's onDone (see
		// commitAdd above) so the "Saved" checkmark is visible for a beat
		// before the row collapses back to its normal state.
		return true;
	};

	const handleSelectExisting = (id: number) => {
		onSelectCatalogOrgan(id === activeCatalogOrganId ? null : id);
	};

	const isCustomActive = (id: number) => activeSegmentId === id && activeCatalogOrganId == null;


	const addClassRef = useRef<HTMLDivElement>(null);
	const tableRef = useRef<HTMLDivElement>(null);
	const tabsRef = useRef<HTMLDivElement>(null);
	const catalogListRef = useRef<HTMLDivElement>(null);




	// Bailing out here (rather than gating mount/unmount from the parent)
	// keeps drag position, resize width, editing state, etc. alive across
	// the popup being shown and hidden.
	if (typeof document === "undefined") return null;

	// Portal to <body>, like AISidebar, since the page root has
	// overflow:hidden and would otherwise clip this fixed-position panel.
	// Slides in/out via transform rather than resizing/collapsing — `open`
	// is the same boolean that shows/hides the annotation ribbon.
	return createPortal(
			<div
				ref={containerRef}
				className={`segpop segpop--anchor-top segpop--docked ${open ? "is-open" : "is-closed"}`}
				style={{
					position: "fixed",
					left: "auto",
					top: DOCK_CLEARANCE,
					bottom: 0,
					right: RIGHT_MARGIN,
					width,
				}}
			>
				{/* Resize handle: drag left to widen, right to narrow. Absolutely
				    positioned so it doesn't interfere with the column-reverse flex
				    ordering of the header/tabs/body below it. */}
				<div
					className="segpop__resize-handle"
					onPointerDown={startResize}
					title="Drag to resize"
				>
					<span className="segpop__resize-grip" />
				</div>

				{/* DOM order: body, tabs, header — column-reverse renders the last
				    child at the top, so visual order is header, tabs, body. Body
				    is the flexed, internally-scrolling region that fills the dock. */}
				<div className="segpop__body" ref={tableRef}>
						{/* Keyed on `tab` so switching between Existing/Custom plays a
						    quick fade+slide-in instead of the content just snapping to
						    the other tab's rows instantly. */}
						<div key={tab} className="segpop__tab-content">
						{tab === "existing" ? (
							<>
								<ShowOnlyTargetToggle
									checked={showOnlyTargetMask}
									onChange={onShowOnlyTargetMaskChange}
									disabled={!hasActiveTarget}
								/>
								{organCatalog.length === 0 ? (
									<div className="segpop__empty">No classes detected in this case.</div>
								) : (
									<div className="segpop__catalog-list" ref={catalogListRef}>
										{organCatalog.map((o) => (
											<button
												key={o.id}
												className={`segpop__catalog-row ${activeCatalogOrganId === o.id ? "is-active" : ""}`}
												onClick={() => handleSelectExisting(o.id)}
											>
												<span className="segpop__catalog-row-name">{toTitleCase(o.label)}</span>

											</button>
										))}
									</div>
								)}
							</>
						) : (
							<>
								<ShowOnlyTargetToggle
									checked={showOnlyTargetMask}
									onChange={onShowOnlyTargetMaskChange}
									disabled={!hasActiveTarget}
								/>
								{segments.map((s) => {
									const active = isCustomActive(s.id);
									const hex = colors[s.id] ?? "#ffffff";
									const isEditing = editingId === s.id;
									const isDeleting = deletingIds.has(s.id);
									return (
										<div
											key={s.id}
											className={`segpop__row ${active ? "is-active" : ""} ${isDeleting ? "is-deleting" : ""} ${isEditing ? "is-editing-target" : ""}`}
											onClick={() => { if (!isDeleting) { onSelect(active ? null : s.id); } }}
										>
											<button
												className="segpop__vis"
												onClick={(e) => { e.stopPropagation(); onToggleVisibility(s.id); }}
												aria-label={visibility[s.id] !== false ? "Hide" : "Show"}
												disabled={isDeleting}
											>
												{visibility[s.id] !== false ? <IconEye size={15} /> : <IconEyeOff size={15} />}
											</button>
											<span className="segpop__swatch" style={{ background: hex }} aria-hidden="true" />
											<span className="segpop__name" title={s.label}>
												{s.label}
											</span>

											{!isDeleting && (
												<button
													className={`segpop__edit-btn ${isEditing ? "is-active" : ""}`}
													onClick={(e) => { e.stopPropagation(); startEdit(s.id, s.label, hex, e.currentTarget); }}
													aria-label="Rename / recolor"
													title="Rename / recolor"
												>
													<IconPencil size={13} />
												</button>
											)}
											<button
												className="segpop__delete"
												onClick={(e) => { e.stopPropagation(); if (!isDeleting) setConfirmDeleteId(s.id); }}
												aria-label={isDeleting ? "Deleting…" : "Delete"}
												title={isDeleting ? "Deleting…" : "Delete class"}
												disabled={isDeleting}
											>
												{isDeleting ? <IconLoader2 size={13} className="segpop__spin" /> : <IconTrash size={13} />}
											</button>
										</div>
									);
								})}

								{/* Edit flyout: a single instance, floated next to whichever
								    row's pencil icon opened it, instead of expanding inline —
								    so the rest of the list never shifts and this can never get
								    stuck the way the old inline collapse could. */}
								{editingId != null && (() => {
									const s = segments.find((seg) => seg.id === editingId);
									if (!s) return null;
									const remaining = MAX_SEGMENT_NAME_LENGTH - editNameDraft.length;
									return (
										<FormFlyout anchorEl={editAnchorEl} onClose={() => closeEdit(editingId)}>
											{(requestClose) => (
												<div className="segpop__form-flyout-inner">
													<div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
														<div className="segpop__color-anchor">
															<button
																ref={editColorBtnRef}
																type="button"
																className="segpop__color segpop__color-btn"
																style={{ background: editColorDraft }}
																aria-label="Class color"
																title="Change color"
																onClick={() => setEditColorPopoverOpen((v) => !v)}
															/>
															{editColorPopoverOpen && (
																<ColorPickerPopover
																	value={editColorDraft}
																	onChange={setEditColorDraft}
																	onClose={() => setEditColorPopoverOpen(false)}
																	anchorRef={editColorBtnRef}
																/>
															)}
														</div>
														<input
															autoFocus
															className={`segpop__name-input ${renameError === s.id ? "is-error" : ""}`}
															value={editNameDraft}
															maxLength={MAX_SEGMENT_NAME_LENGTH}
															onChange={(e) => { setEditNameDraft(e.target.value); setRenameError(null); }}
															onKeyDown={(e) => {
																if (e.key === "Enter") { if (commitEdit(s.id)) requestClose(); }
																if (e.key === "Escape") requestClose();
															}}
														/>
													</div>
													{renameError === s.id && <span className="segpop__err segpop__err--block">Name in use</span>}
													{renameError !== s.id && remaining <= 10 && (
														<span className="segpop__err segpop__err--block segpop__char-count">{remaining} characters left</span>
													)}
													<div className="segpop__row-actions">
														<ApplyButton className="segpop__add-confirm" onApply={() => commitEdit(s.id)} onDone={requestClose} label="Save" applyingLabel="Saving…" successLabel="Saved" />
														<button className="atb-action-btn segpop__add-cancel-text" onClick={requestClose}>
															<span className="atb-action-btn__label">Cancel</span>
														</button>
													</div>
												</div>
											)}
										</FormFlyout>
									);
								})()}

								{confirmDeleteId != null && (
									<GuidedStepModal
										title="Delete this class?"
										instruction={`"${segments.find((s) => s.id === confirmDeleteId)?.label ?? "This class"}" and its segmentation will be permanently removed. This can't be undone.`}
										primaryLabel="Delete"
										onPrimary={() => {
											const id = confirmDeleteId;
											setConfirmDeleteId(null);
											handleDelete(id);
										}}
										secondaryLabel="Cancel"
										onSecondary={() => setConfirmDeleteId(null)}
									/>
								)}

								{/* "Add class" trigger stays put and always renders — the form
								    itself now lives in a floating FormFlyout (below) instead of
								    swapping this button out for an inline form, so there's no
								    "form got stuck open, button never came back" failure mode. */}
								<div ref={addClassRef}>
									<button className={`segpop__new ${adding ? "is-active" : ""}`} onClick={startAdd}>
										<IconPlus size={15} /> Add class
									</button>
								</div>
								{adding && (
									<FormFlyout anchorEl={addAnchorEl} onClose={closeAddForm}>
										{(requestClose) => (
											<div className="segpop__form-flyout-inner">
												<div style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
													<div className="segpop__color-anchor">
														<button
															ref={addColorBtnRef}
															type="button"
															className="segpop__color segpop__color-btn"
															style={{ background: draftColor }}
															aria-label="Class color"
															title="Change color"
															onClick={() => setAddColorPopoverOpen((v) => !v)}
														/>
														{addColorPopoverOpen && (
															<ColorPickerPopover
																value={draftColor}
																onChange={setDraftColor}
																onClose={() => setAddColorPopoverOpen(false)}
																anchorRef={addColorBtnRef}
															/>
														)}
													</div>
													<input
														autoFocus
														className={`segpop__name-input ${createError ? "is-error" : ""}`}
														placeholder="Class name"
														value={draftName}
														maxLength={MAX_SEGMENT_NAME_LENGTH}
														onChange={(e) => { setDraftName(e.target.value); setCreateError(""); }}
														onKeyDown={(e) => {
															if (e.key === "Enter") { if (commitAdd()) requestClose(); }
															if (e.key === "Escape") requestClose();
														}}
													/>
												</div>
												{createError && <span className="segpop__err segpop__err--block">{createError}</span>}
												<div className="segpop__row-actions">
													<ApplyButton className="segpop__add-confirm" onApply={commitAdd} onDone={requestClose} label="Add class" applyingLabel="Adding…" successLabel="Added" />
													<button className="atb-action-btn segpop__add-cancel-text" onClick={requestClose}>
														<span className="atb-action-btn__label">Cancel</span>
													</button>
												</div>
											</div>
										)}
									</FormFlyout>
								)}
							</>
						)}
						</div>
					</div>

					<div ref={tabsRef} className="segpop__tabs" onClick={(e) => e.stopPropagation()}>
						<button className={`segpop__tab ${tab === "existing" ? "is-active" : ""}`} onClick={() => switchTab("existing")}>
							<IconStack2 size={14} />
							Existing class
							{activeCatalogOrganId != null && <span className="segpop__tab-dot" />}
						</button>
						<button className={`segpop__tab ${tab === "custom" ? "is-active" : ""}`} onClick={() => switchTab("custom")}>
							<IconSparkles size={14} />
							Custom
							{activeSegmentId != null && activeCatalogOrganId == null && <span className="segpop__tab-dot" />}
						</button>
					</div>

					{/* Drag handle only now — the title text used to repeat
					    "Existing class"/"Custom classes" right below tab
					    buttons that already say the same thing, so it was
					    dropped. dragHandleRef still needs a DOM node to
					    attach to for the popup's drag behavior. */}
					<div ref={dragHandleRef} className="segpop__head" />


		</div>,
		document.body
	);
}