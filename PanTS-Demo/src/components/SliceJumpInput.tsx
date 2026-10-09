import { forwardRef, useEffect, useRef, useState } from "react";
import { setPaneSliceIndex, stepPaneSlice, type CinePane, type SliceInfo } from "../helpers/CornerstoneNifti2";

type Props = {
    pane: CinePane;
    info: SliceInfo;
}

// Narrowest the jump field gets, so a short caption still leaves room to type.
const MIN_FIELD_WIDTH = 44;

const SliceJumpInput = forwardRef<HTMLDivElement, Props>(function SliceJumpInput({ pane, info }, ref) {
    const [isEditing, setIsEditing] = useState(false);
    const [inputValue, setInputValue] = useState(String(info.current + 1));
    const captionRef = useRef<HTMLButtonElement>(null);
    // The caption's width when editing starts, so the field that replaces it
    // takes the same room and the chip does not resize under the pointer.
    const [fieldWidth, setFieldWidth] = useState<number | undefined>(undefined);
    // Set when the edit ends from the keyboard (Enter or Escape), so focus
    // goes back to the caption instead of falling to the page.
    const refocusCaption = useRef(false);
    // What the field showed when editing started. An untouched field is not a
    // typed jump: committing it would snap the pane back after the user
    // scrolled to another slice meanwhile.
    const startedWith = useRef("");

    useEffect(() => {
        if (isEditing || !refocusCaption.current) return;
        refocusCaption.current = false;
        captionRef.current?.focus();
    }, [isEditing]);

    const startEditing = () => {
        startedWith.current = String(info.current + 1);
        setInputValue(startedWith.current);
        const captionWidth = captionRef.current?.offsetWidth;
        setFieldWidth(captionWidth ? Math.max(captionWidth, MIN_FIELD_WIDTH) : undefined);
        setIsEditing(true);
    };

    // Names the control for a screen reader: the three panes' counters would
    // otherwise read the same ("Slice 256 of 512" for sagittal and coronal).
    const paneName = pane.charAt(0).toUpperCase() + pane.slice(1);

    const commitEdit = () => {
        const typedNumber = Number(inputValue);
        // A whole number past either end goes to the nearest slice, like the
        // slider fields; an empty or fractional entry is ignored, and so is an
        // entry the user never changed.
        if (inputValue !== startedWith.current && inputValue.trim() !== "" && Number.isInteger(typedNumber)) {
            setPaneSliceIndex(pane, Math.min(info.total, Math.max(1, typedNumber)) - 1);
        }
        setIsEditing(false);
    };

    return (
        <div
            ref={ref}
            // Stays under the phone sheets (z-index 30 in VisualizationPage.css): the pane
            // wrap is not a stacking context, so a higher value here would paint over them.
            // Sized to the caption and anchored on its right edge, so a longer total
            // ("129/256", four digits) grows leftwards instead of past right: 10.
            style={{ position: "absolute", right: 10, bottom: 10, zIndex: 6, width: "max-content", textAlign: "right" }}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            {isEditing ? (
                <input
                    type="number"
                    className="vp-slice-jump-input"
                    aria-label={`Jump to ${pane} slice, 1 to ${info.total}`}
                    style={{ position: "static", width: fieldWidth, boxSizing: "border-box", pointerEvents: "auto" }}
                    value={inputValue}
                    autoFocus
                    // A script focus puts the caret after the current number, so the first
                    // keystroke would append to it; selecting it makes typing replace it.
                    onFocus={(e) => e.currentTarget.select()}
                    min={1}
                    step={1}
                    max={info.total}
                    onChange={(e) => setInputValue(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key !== "Enter" && e.key !== "Escape") return;
                        // Focus is about to land on the caption, which would
                        // otherwise take this same key press as its own Enter
                        // and reopen the field.
                        e.preventDefault();
                        refocusCaption.current = true;
                        if (e.key === "Enter") commitEdit();
                        else setIsEditing(false);
                    }}
                />
            ) : (
                <button
                    type="button"
                    ref={captionRef}
                    className="vp-slice-caption"
                    style={{ position: "static", pointerEvents: "auto" }}
                    title="Click to jump to a slice, or scroll"
                    aria-label={`${paneName} slice ${info.current + 1} of ${info.total}. Jump to a slice`}
                    onClick={startEditing}
                    onWheel={(e) => {
                        // A sideways swipe has no vertical step.
                        if (e.deltaY === 0) return;
                        e.stopPropagation();
                        // Same direction as the wheel over the image: down goes to the next slice.
                        // Steps from the slice the pane is on now, so several events per frame add up.
                        stepPaneSlice(pane, e.deltaY > 0 ? 1 : -1);
                    }}
                >
                    {info.current + 1}/{info.total}
                </button>
            )}
        </div>
    );
});

export default SliceJumpInput;
