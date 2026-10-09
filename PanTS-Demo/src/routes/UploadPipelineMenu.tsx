import React, { useEffect, useId, useRef, useState } from "react";

// One pipeline step's picker on the Upload page (Preprocessing, Model,
// Postprocessing), built as an ARIA menu button so it works from the
// keyboard: Enter, Space or ArrowDown opens it on the current choice, the
// arrows (plus Home and End) move between rows, Enter or Space picks, and
// Escape closes it and hands focus back to the trigger. "Coming soon" rows
// are aria-disabled and skipped. A row with a submenu (LesionSegmenter's
// lesion picker) opens it with ArrowRight, Enter or Space and leaves it with
// ArrowLeft or Escape. The styling classes are the ones the page already
// used, so it looks the same as the mouse-only version it replaces.

export type PipelineMenuSubItem = { id: string; label: string; checked: boolean };

export type PipelineMenuItem = {
  id: string;
  label: string;
  desc: string;
  checked: boolean;
  /** Not available yet: shown, announced as disabled, never selectable. */
  disabled?: boolean;
  /** Outside the plan: still operable (it explains the lock), just dimmed. */
  locked?: boolean;
  /** Small pill beside the row, e.g. "Coming soon" or "Donate". */
  badge?: string;
  submenu?: PipelineMenuSubItem[];
};

type Props = {
  /** Id of the visible step label, so the trigger reads "Model, ePAI". */
  labelId: string;
  valueText: string;
  hasValue: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PipelineMenuItem[];
  onSelect: (id: string) => void;
  onSelectSub?: (itemId: string, subId: string) => void;
  /** Extra controls under the rows (the admin coupon form). Plain tab stops,
   *  outside the menu role, since they aren't menu items. */
  footer?: React.ReactNode;
};

type FocusTarget = "checked" | "first" | "last";

const enabledRows = (menu: HTMLElement | null): HTMLElement[] =>
  Array.from(menu?.querySelectorAll<HTMLElement>("[data-menu-row]") ?? []).filter(
    (el) => el.getAttribute("aria-disabled") !== "true",
  );

const CheckIcon = ({ className }: { className?: string }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={className} aria-hidden="true">
    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const UploadPipelineMenu: React.FC<Props> = ({
  labelId,
  valueText,
  hasValue,
  open,
  onOpenChange,
  items,
  onSelect,
  onSelectSub,
  footer,
}) => {
  const uid = useId();
  const menuId = `${uid}-menu`;
  const valueId = `${uid}-value`;
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Where focus lands when the menu opens (ArrowUp on the trigger means the
  // last row; everything else means the current choice).
  const openTargetRef = useRef<FocusTarget>("checked");
  // Which row's submenu the keyboard opened (hover opens it through CSS).
  const [subOpenId, setSubOpenId] = useState<string | null>(null);

  // The rows the arrow keys visit: every top-level row except disabled ones.
  const rows = () => enabledRows(menuRef.current);

  const openMenu = (target: FocusTarget) => {
    openTargetRef.current = target;
    setSubOpenId(null);
    onOpenChange(true);
  };

  const closeMenu = (returnFocus: boolean) => {
    setSubOpenId(null);
    onOpenChange(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Move focus into the menu once it has rendered.
  useEffect(() => {
    if (!open) return;
    const enabled = enabledRows(menuRef.current);
    const target =
      openTargetRef.current === "last"
        ? enabled[enabled.length - 1]
        : openTargetRef.current === "first"
          ? enabled[0]
          : enabled.find((el) => el.dataset.checked === "true") ?? enabled[0];
    target?.focus();
    openTargetRef.current = "checked";
  }, [open]);

  // A press anywhere outside closes it, the way it always has.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setSubOpenId(null);
        onOpenChange(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onOpenChange]);

  const onTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (open) {
        // Already open (focus came back to the trigger with Shift+Tab): the
        // [open] effect won't run again, so move focus in directly.
        const enabled = rows();
        const target =
          e.key === "ArrowUp"
            ? enabled[enabled.length - 1]
            : enabled.find((el) => el.dataset.checked === "true") ?? enabled[0];
        target?.focus();
        return;
      }
      openMenu(e.key === "ArrowUp" ? "last" : "checked");
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      closeMenu(true);
    }
  };

  const focusSub = (itemId: string, which: "checked" | "first") => {
    const sub = menuRef.current?.querySelector<HTMLElement>(`[data-submenu-for="${itemId}"]`);
    const subRows = Array.from(sub?.querySelectorAll<HTMLElement>("[data-submenu-row]") ?? []);
    const target =
      (which === "checked" ? subRows.find((el) => el.getAttribute("aria-checked") === "true") : undefined) ??
      subRows[0];
    target?.focus();
  };

  const openSub = (itemId: string) => {
    setSubOpenId(itemId);
    // The submenu is always in the DOM (CSS shows it), so focus can move now.
    focusSub(itemId, "checked");
  };

  const activate = (item: PipelineMenuItem) => {
    if (item.disabled) return;
    if (item.submenu) {
      openSub(item.id);
      return;
    }
    onSelect(item.id);
    closeMenu(true);
  };

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inSub = target.hasAttribute("data-submenu-row");

    if (inSub) {
      const sub = target.closest<HTMLElement>("[data-submenu-for]");
      const parentId = sub?.dataset.submenuFor ?? "";
      const subRows = Array.from(sub?.querySelectorAll<HTMLElement>("[data-submenu-row]") ?? []);
      const i = subRows.indexOf(target);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        subRows[(i + step + subRows.length) % subRows.length]?.focus();
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        subRows[e.key === "Home" ? 0 : subRows.length - 1]?.focus();
      } else if (e.key === "ArrowLeft" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSubOpenId(null);
        menuRef.current?.querySelector<HTMLElement>(`[data-row-id="${parentId}"]`)?.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const subId = target.dataset.subId ?? "";
        onSelectSub?.(parentId, subId);
        closeMenu(true);
      }
      return;
    }

    const enabled = rows();
    const i = enabled.indexOf(target);
    const item = items.find((it) => it.id === target.dataset.rowId);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      enabled[(i + step + enabled.length) % enabled.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      enabled[e.key === "Home" ? 0 : enabled.length - 1]?.focus();
    } else if (e.key === "ArrowRight" && item?.submenu) {
      e.preventDefault();
      openSub(item.id);
    } else if ((e.key === "Enter" || e.key === " ") && item) {
      e.preventDefault();
      activate(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    }
  };

  // Escape from anywhere else inside the picker (the coupon footer sits
  // outside the trigger and the menu) closes it too. The trigger, the rows
  // and an open submenu already handled theirs, so a handled key is left alone.
  const onWrapKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open && !e.defaultPrevented) {
      e.preventDefault();
      closeMenu(true);
    }
  };

  // Tab (or anything else) moving focus out of the whole picker closes it.
  // Only a move to a real element counts: clicking dead space inside the menu
  // blurs to nothing, and that shouldn't snap it shut.
  const onWrapBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (open && next && !wrapRef.current?.contains(next)) {
      setSubOpenId(null);
      onOpenChange(false);
    }
  };

  return (
    <div className="model-dropdown" ref={wrapRef} onBlur={onWrapBlur} onKeyDown={onWrapKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={`model-dropdown-btn${hasValue ? " has-value" : ""}${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        title={valueText}
        onClick={() => (open ? closeMenu(false) : openMenu("checked"))}
        onKeyDown={onTriggerKeyDown}
      >
        <span id={valueId} className="model-dropdown-value">
          {valueText}
        </span>
        <svg
          className={`model-dropdown-chevron${open ? " rotated" : ""}`}
          width="10"
          height="6"
          viewBox="0 0 10 6"
          fill="none"
          aria-hidden="true"
        >
          <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="model-dropdown-menu">
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-labelledby={labelId}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item) => {
              const nameId = `${uid}-${item.id || "none"}-name`;
              const descId = `${uid}-${item.id || "none"}-desc`;
              const badgeId = `${uid}-${item.id || "none"}-badge`;
              const describedBy = [descId, item.badge ? badgeId : ""].filter(Boolean).join(" ");
              const subExpanded = subOpenId === item.id;
              return (
                <div
                  key={item.id}
                  data-menu-row=""
                  data-row-id={item.id}
                  data-checked={item.checked ? "true" : undefined}
                  // A row that opens a submenu is a plain menuitem (it owns
                  // the submenu); the lesion rows inside it carry the check.
                  role={item.submenu ? "menuitem" : "menuitemradio"}
                  aria-checked={item.submenu ? undefined : item.checked}
                  aria-haspopup={item.submenu ? "menu" : undefined}
                  aria-expanded={item.submenu ? subExpanded : undefined}
                  aria-disabled={item.disabled || undefined}
                  aria-labelledby={nameId}
                  aria-describedby={describedBy}
                  tabIndex={-1}
                  className={`model-dropdown-item${item.checked ? " selected" : ""}${item.locked ? " locked" : ""}${item.submenu ? " has-submenu" : ""}${subExpanded ? " submenu-open" : ""}`}
                  onClick={() => {
                    if (item.disabled) return;
                    // A mouse click on the LesionSegmenter row picks it with
                    // the lesion it already has, as before; the flyout is
                    // for changing the lesion.
                    onSelect(item.id);
                    closeMenu(true);
                  }}
                >
                  <div className="model-dropdown-item-content">
                    {/* The pill sits beside the name, so the description keeps
                        the row's full width instead of wrapping to a lone word. */}
                    <div className="model-dropdown-item-head">
                      <span id={nameId} className="model-dropdown-item-name">
                        {item.label}
                      </span>
                      {item.badge && (
                        <span id={badgeId} className="model-dropdown-lock">
                          {item.badge}
                        </span>
                      )}
                    </div>
                    <span id={descId} className="model-dropdown-item-desc">
                      {item.desc}
                    </span>
                  </div>
                  <div className="model-dropdown-item-side">
                    {item.submenu ? (
                      <svg className="model-submenu-arrow" width="7" height="10" viewBox="0 0 7 10" fill="none" aria-hidden="true">
                        <path d="M1 1l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      !item.disabled && !item.locked && item.checked && <CheckIcon className="model-dropdown-check" />
                    )}
                  </div>
                  {item.submenu && (
                    <div className="model-submenu" role="menu" aria-labelledby={nameId} data-submenu-for={item.id}>
                      {item.submenu.map((sub) => (
                        <div
                          key={sub.id}
                          data-submenu-row=""
                          data-sub-id={sub.id}
                          role="menuitemradio"
                          aria-checked={sub.checked}
                          tabIndex={-1}
                          className={`model-submenu-item${sub.checked ? " selected" : ""}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectSub?.(item.id, sub.id);
                            closeMenu(true);
                          }}
                        >
                          <span className="model-submenu-check">{sub.checked && <CheckIcon />}</span>
                          <span className="model-submenu-label">{sub.label}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
};

export default UploadPipelineMenu;
