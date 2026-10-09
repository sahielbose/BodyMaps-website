import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconPhotoOff } from "@tabler/icons-react";
import { API_BASE } from "../helpers/constants";
import { formatSex, formatTumor } from "../helpers/demographics";
import { prefetchViewer } from "../helpers/prefetchViewer";
import type { CaseId } from "../helpers/search";
import type { PreviewType } from "../types";

// Hover effects, the keyboard-focus reveal of the save and compare buttons and
// the stretched case link are CSS (the .bm-card rules in App.css), so a
// keyboard user sees what a mouse user sees and hovering re-renders nothing.

type Props = {
	id: CaseId;
	previewMetadata: PreviewType;
	saved?: boolean;
	onToggleSave?: () => void;
	compareSelected?: boolean;
	onToggleCompare?: () => void;
	// When the grid coordinates a synchronized reveal, it holds every card hidden
	// (spinner) until the whole batch has settled, then flips `reveal` true for all
	// of them at once. `onSettled` fires once, when this card's image loads or fails.
	reveal?: boolean;
	onSettled?: () => void;
};

export default function Preview({
	id,
	previewMetadata,
	saved = false,
	onToggleSave,
	compareSelected = false,
	onToggleCompare,
	reveal = true,
	onSettled,
}: Props) {
	const [imgLoaded, setImgLoaded] = useState(false);
	const [imgError, setImgError] = useState(false);
	// Report "settled" exactly once (load or terminal error) so the grid can count
	// down to an all-at-once reveal without a broken thumbnail double-counting.
	const settledRef = useRef(false);
	const settle = () => {
		if (!settledRef.current) {
			settledRef.current = true;
			onSettled?.();
		}
	};
	// Prefer the lab's local data via the existing backend endpoint; fall back to
	// the HuggingFace dataset if the local profile image isn't available on the
	// server (so thumbnails never break regardless of deployment). Loaded natively
	// (no blob round-trip) so the browser streams cards in parallel and caches them.
	const [thumbUrl, setThumbUrl] = useState(
		`${API_BASE}/api/get_image_preview/${id}`
	);

	if (!previewMetadata) return null;

	// CancerVerse ids arrive as full strings ("CV_00000001"); PanTS as bare numbers.
	const caseIdStr =
		typeof id === "string" && id.toUpperCase().startsWith("CV")
			? id
			: `PanTS_${id.toString().padStart(8, "0")}`;
	// HuggingFace fallback, routed through the backend's same-origin proxy. A *direct*
	// cross-origin image is blocked by the viewer's COEP: require-corp header (which is
	// why thumbnails went missing); the proxy keeps it same-origin, matching home.html.
	const hfProfileUrl = `https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/profile_only/${caseIdStr}/profile.jpg`;
	const proxyThumbUrl = `${API_BASE}/api/proxy-image?url=${encodeURIComponent(hfProfileUrl)}`;
	const handleImgError = () => {
		if (thumbUrl !== proxyThumbUrl) {
			setThumbUrl(proxyThumbUrl); // local failed — retry via the same-origin HF proxy
		} else {
			setImgError(true); // both sources failed
			settle(); // count it as settled so one dead thumbnail can't stall the grid
		}
	};
	const tumorLabel = formatTumor(previewMetadata.tumor);
	// Deep shades so the 11px label clears 4.5:1 on the card background.
	const tumorColor =
		previewMetadata.tumor === 1
			? "#b91c1c"
			: previewMetadata.tumor === 0
				? "#047857"
				: "#5a6175";
	// Fields the metadata does not record are left off the card rather than
	// shown as a placeholder dash. Age 0 is how an unknown age arrives.
	const sex = formatSex(previewMetadata.sex);
	const age = previewMetadata.age > 0 ? previewMetadata.age : null;
	// Only reveal once the image is loaded AND the grid has released the batch,
	// so cards appear together rather than popping in.
	const shown = imgLoaded && reveal;

	return (
		<div
			className="bm-card"
			onMouseEnter={() => {
				// The viewer JavaScript is small enough to warm safely. Do not prefetch a
				// CT here: scans are tens of MB, and background downloads can starve the
				// case the reader actually clicks (or reset its connection).
				prefetchViewer();
			}}
		>
			{/* Gradient accent line — fades in on hover and keyboard focus */}
			<div className="bm-card__line" aria-hidden="true" />

			{/* Thumbnail */}
			<div className={`bm-card__thumb${imgError ? " bm-card__thumb--failed" : ""}`}>
				{imgError ? (
					<div className="bm-card__fallback">
						<IconPhotoOff size={22} stroke={1.5} aria-hidden="true" />
						<span>Preview unavailable</span>
					</div>
				) : (
					<img
						src={thumbUrl}
						alt={`Case ${id} CT scan`}
						// Eager, not lazy: the grid holds a synchronized reveal until every
						// card settles, and a lazy image below the fold never fires onLoad
						// until scrolled — which stalled the whole reveal to the safety cap.
						loading="eager"
						decoding="async"
						onLoad={() => {
							setImgLoaded(true);
							settle();
						}}
						onError={handleImgError}
						className={`bm-card__img w-full h-full object-contain object-center${shown ? " is-shown" : ""}`}
					/>
				)}
				{!shown && !imgError && (
					<div className="absolute inset-0 flex items-center justify-center">
						<div
							className="w-7 h-7 rounded-full animate-spin"
							style={{
								border: "2px solid rgba(255,255,255,0.15)",
								borderTopColor: "rgba(255,255,255,0.6)",
							}}
						/>
					</div>
				)}

				{/* Bottom fade to card bg */}
				{!imgError && (
					<div
						className="absolute inset-0"
						style={{
							background:
								"linear-gradient(to top, #f5f5f5 0%, rgba(245,245,245,0.5) 45%, transparent 80%)",
						}}
					/>
				)}

				{/* Corner brackets — appear on hover and keyboard focus */}
				{(["tl", "tr", "bl", "br"] as const).map((corner) => (
					<div
						key={corner}
						className="bm-card__corner absolute w-4 h-4"
						aria-hidden="true"
						style={{
							top: corner[0] === "t" ? "8px" : "auto",
							bottom: corner[0] === "b" ? "8px" : "auto",
							left: corner[1] === "l" ? "8px" : "auto",
							right: corner[1] === "r" ? "8px" : "auto",
							borderTop: corner[0] === "t" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
							borderBottom: corner[0] === "b" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
							borderLeft: corner[1] === "l" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
							borderRight: corner[1] === "r" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
						}}
					/>
				))}

				{/* Bookmark toggle. Always in the tab order; shown once saved, on touch
				    devices (no hover), and on hover or keyboard focus otherwise. */}
				{onToggleSave && (
					<button
						type="button"
						aria-label={`Save case ${id}`}
						aria-pressed={saved}
						title={saved ? "Saved, click to remove" : "Save case"}
						onClick={onToggleSave}
						className={`bm-card__control bm-card__save${saved ? " is-on" : ""}`}
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							aria-hidden="true"
							style={{ display: "block", fill: saved ? "#facc15" : "rgba(255,255,255,0.92)", stroke: "none" }}
						>
							<path d="M6 2a1 1 0 0 0-1 1v18l7-4 7 4V3a1 1 0 0 0-1-1H6z" />
						</svg>
					</button>
				)}

				{/* Compare selector — a labelled checkbox in the bottom-left (kept away from the
				    top-right bookmark to avoid mis-taps). A checkbox + text reads as "select to
				    compare" far more clearly than a bare icon. Revealed like the bookmark;
				    stays and turns JHU blue once selected. */}
				{onToggleCompare && (
					<button
						type="button"
						aria-label={`Compare case ${id}`}
						aria-pressed={compareSelected}
						title={compareSelected ? "Selected to compare, click to remove" : "Select to compare"}
						onClick={onToggleCompare}
						className={`bm-card__control bm-card__compare${compareSelected ? " is-on" : ""}`}
					>
						<span
							className="flex items-center justify-center"
							style={{
								width: "14px",
								height: "14px",
								borderRadius: "4px",
								border: compareSelected ? "none" : "1.5px solid rgba(255,255,255,0.85)",
								background: compareSelected ? "#fff" : "transparent",
							}}
						>
							{compareSelected && (
								<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block", fill: "none", stroke: "#002d72", strokeWidth: 4, strokeLinecap: "round", strokeLinejoin: "round" }}>
									<path d="M5 13l4 4L19 7" />
								</svg>
							)}
						</span>
						<span style={{ fontSize: "11px", fontWeight: 600, color: "#fff", letterSpacing: "0.01em" }}>
							Compare
						</span>
					</button>
				)}
			</div>

			{/* Data row. The case ID is the card's link; its ::after covers the whole
			    card, so a click anywhere opens the case and so do Enter and a
			    middle-click or cmd-click into a new tab. */}
			<div className="p-3">
				<div className="mb-1">
					<Link to={`/case/${id}`} className="bm-card__link" onFocus={prefetchViewer}>
						{caseIdStr}
					</Link>
				</div>

				{/* Wraps rather than spilling past the card edge on the narrowest cards. */}
				<div
					className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
					style={{ fontSize: "11px", fontWeight: 700, color: "#111111" }}
				>
					{sex && <span>{sex}</span>}
					{age !== null && <span>Age {age}y</span>}
					<span
						style={{
							color: tumorColor,
							fontWeight: 600,
						}}
					>
						{tumorLabel}
					</span>
				</div>
			</div>
		</div>
	);
}

// Loading placeholder with the card's exact box model (1px line, 4:3
// thumbnail, data row with the same type sizes), so the grid keeps its height
// when the real cards replace it.
export function PreviewSkeleton() {
	return (
		<div className="bm-card-skeleton" aria-hidden="true">
			<div style={{ height: "1px" }} />
			<div className="bm-card-skeleton__thumb" />
			<div className="p-3">
				<div className="mb-1">
					<span className="bm-card-skeleton__text" style={{ fontSize: "13px", width: "62%" }}>
						&nbsp;
					</span>
				</div>
				<div className="flex items-center gap-2" style={{ fontSize: "11px" }}>
					<span className="bm-card-skeleton__text" style={{ width: "22%" }}>&nbsp;</span>
					<span className="bm-card-skeleton__text" style={{ width: "24%" }}>&nbsp;</span>
					<span className="bm-card-skeleton__text" style={{ width: "26%" }}>&nbsp;</span>
				</div>
			</div>
		</div>
	);
}
