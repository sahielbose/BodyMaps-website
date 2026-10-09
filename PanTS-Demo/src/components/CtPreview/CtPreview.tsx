import { Niivue, NVImage, SLICE_TYPE } from "@niivue/niivue";
import { useEffect, useRef, useState } from "react";

// Lightweight, client-side preview of a locally-selected CT (.nii/.nii.gz) — loaded
// straight into NiiVue from the File object, no upload/server round-trip. Lets users
// verify the right file + slice orientation before running inference. Lazy-loaded by
// the upload page so NiiVue isn't pulled into that bundle until a file is chosen.

// File objects have no id of their own; the canvas is keyed by one so each file gets a
// fresh canvas (NiiVue's canvas listeners are never removed by cleanup(), so reusing
// a canvas would leave the old instance drawing over the new one).
const canvasKeys = new WeakMap<File, number>();
let nextCanvasKey = 0;
function canvasKeyFor(file: File) {
	let key = canvasKeys.get(file);
	if (key === undefined) canvasKeys.set(file, (key = nextCanvasKey++));
	return key;
}

// NiiVue has no outline or backing for the orientation letters. Each tile is the slice
// plus the margin, so half the margin is the black strip that holds the top and left
// letter, and NiiVue only draws a letter there when that half exceeds the 13px font
// plus 2px (a margin above 30). Below that the letters land on the anatomy, where a light
// "S" on bright tissue disappears. On a wide preview the strip costs each slice about a
// tenth of its size; on a phone's 2x2 grid it would cost a fifth, so narrow previews keep
// the thin gutter and the slices stay large.
const WIDE_PREVIEW_PX = 560;
function tileMarginFor(canvas: HTMLCanvasElement | null) {
	return (canvas?.clientWidth ?? 0) >= WIDE_PREVIEW_PX ? 32 : 4;
}

export default function CtPreview({ file }: { file: File }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	// Tracks which file failed rather than a bare flag, so picking another file
	// clears the message in the same render: the canvas is back in the tree before
	// the effect looks for it, instead of the load silently bailing on a null ref.
	const [failedFile, setFailedFile] = useState<File | null>(null);
	const error = failedFile === file;
	const [ready, setReady] = useState(false);

	useEffect(() => {
		let cancelled = false;
		setReady(false);
		// A file that failed earlier gets a fresh attempt when it is picked again.
		setFailedFile(null);
		const canvas = canvasRef.current;
		const nv = new Niivue({
			sliceType: SLICE_TYPE.MULTIPLANAR,
			backColor: [0.03, 0.035, 0.04, 1],
			// Radiological layout (patient right on the screen left, like the viewer) so the
			// preview can be used to check orientation; NiiVue defaults to the neurological
			// mirror. The convention flips axial and coronal only, so the sagittal tile also
			// needs the nose on the left (anterior left, posterior right) to match the viewer.
			// The 3D tile's bare full-height crosshair line is noise on a thumbnail.
			isRadiologicalConvention: true,
			sagittalNoseLeft: true,
			show3Dcrosshair: false,
			// A gutter between the three tiles, a thin translucent crosshair and lighter
			// orientation letters: with the library defaults (no margin, a full-width red
			// cross) the coronal and sagittal lines join into one stroke across the box and
			// the dim grey L/R/A/P letters are hard to read on the dark tile. The margin is
			// set by tileMarginFor below.
			tileMargin: tileMarginFor(canvas),
			crosshairColor: [1, 1, 1, 0.45],
			crosshairWidth: 0.6,
			fontColor: [0.85, 0.87, 0.9, 1],
		});
		// NiiVue's wheel listener calls preventDefault on every event, so a pointer resting
		// over the preview would stop the page scrolling. Until the canvas is clicked (or a
		// ctrl/meta key is held for zoom) the event is kept from NiiVue so the page scrolls on.
		let engaged = false;
		const onPointerDown = (e: PointerEvent) => {
			// A finger landing on the preview is usually the start of a page scroll, not a click.
			if (e.pointerType !== "touch") engaged = true;
		};
		const onPointerLeave = () => {
			engaged = false;
		};
		const onWheelCapture = (e: WheelEvent) => {
			if (engaged || e.ctrlKey || e.metaKey) return;
			e.stopImmediatePropagation();
		};
		// NiiVue's touch listeners are not passive and preventDefault touchstart and touchend, so a
		// swipe that begins over the preview would never scroll the page on a phone. Its touch
		// handling (drag, pinch, double-tap reset) lives only in those listeners, so keeping the
		// events from NiiVue makes touch tap-only here: a tap still reaches it as the browser's
		// compatibility mouse events and moves the crosshair, and a swipe scrolls the page. The
		// preview is a quick orientation check; the full viewer has the touch gestures.
		const onTouchCapture = (e: TouchEvent) => {
			e.stopImmediatePropagation();
		};
		const touchEvents = ["touchstart", "touchmove", "touchend"] as const;
		// A preview that crosses the wide breakpoint (a rotated phone, a resized window)
		// switches between the letter strip and the thin gutter.
		const resizeObserver =
			canvas && typeof ResizeObserver !== "undefined"
				? new ResizeObserver(() => {
						const margin = tileMarginFor(canvas);
						if (nv.opts.tileMargin === margin) return;
						nv.opts.tileMargin = margin;
						if (nv.gl) nv.drawScene();
					})
				: null;
		if (canvas) resizeObserver?.observe(canvas);
		const load = async () => {
			if (!canvasRef.current) return;
			try {
				nv.attachToCanvas(canvasRef.current);
				// Capture phase, so it runs before the listener NiiVue just added to this canvas.
				canvasRef.current.addEventListener("wheel", onWheelCapture, { capture: true });
				for (const type of touchEvents) canvasRef.current.addEventListener(type, onTouchCapture, { capture: true });
				// pan-y leaves vertical panning to the browser; pinch-zoom keeps page zoom working.
				canvasRef.current.style.touchAction = "pan-y pinch-zoom";
				canvasRef.current.addEventListener("pointerdown", onPointerDown);
				canvasRef.current.addEventListener("pointerleave", onPointerLeave);
				// trustCalMinMax:false → ignore any narrow window/level baked into the file
				// header and compute a robust (percentile) window from the data instead, so a
				// few bright voxels (contrast-filled vessels, bone) don't clip the rest of the
				// scan to black. Some exported CTs carry a header window that suits only their
				// source view; this keeps the preview legible for any uploaded volume.
				const nvImage = await NVImage.loadFromFile({ file, trustCalMinMax: false });
				if (cancelled) return;
				nv.addVolume(nvImage);
				nv.setSliceType(SLICE_TYPE.MULTIPLANAR);
				setReady(true);
			} catch (e) {
				console.error("CT preview failed to load", e);
				if (!cancelled) setFailedFile(file);
			}
		};
		load();
		return () => {
			cancelled = true;
			resizeObserver?.disconnect();
			canvas?.removeEventListener("wheel", onWheelCapture, { capture: true });
			for (const type of touchEvents) canvas?.removeEventListener(type, onTouchCapture, { capture: true });
			canvas?.removeEventListener("pointerdown", onPointerDown);
			canvas?.removeEventListener("pointerleave", onPointerLeave);
			// attachToCanvas adds a window resize handler and observers; without this every
			// preview (and every file switch) leaks them. NiiVue does not free the GL context
			// itself, so release it when the canvas is going away. A canvas still in the
			// document is about to be reused (StrictMode's simulated remount), and a lost
			// context is never handed back by getContext.
			try {
				nv.cleanup();
				if (!canvas?.isConnected) nv.gl?.getExtension("WEBGL_lose_context")?.loseContext();
			} catch {
				/* instance never attached or already torn down */
			}
		};
	}, [file]);

	if (error) {
		return (
			<div className="ct-preview ct-preview--msg" role="alert">
				Couldn't preview this file. You can still run a model on it.
			</div>
		);
	}

	return (
		<div className="ct-preview ct-preview--multiplanar">
			<canvas key={canvasKeyFor(file)} ref={canvasRef} className="ct-preview-canvas" role="img" aria-label="CT preview" title="Click the preview, then scroll to change slices" />
			{!ready && <div className="ct-preview-loading" role="status">Loading preview…</div>}
		</div>
	);
}
