import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { API_BASE } from "../helpers/constants";
import { prefetchViewer } from "../helpers/prefetchViewer";
import type { CaseId } from "../helpers/search";
import type { PreviewType } from "../types";

// Touch devices have no hover phase, so hover-revealed controls would be
// unreachable there: the first tap fires mouseenter + click together and the
// card's onClick navigates immediately. Evaluated once at module load.
const canHover =
	typeof window !== "undefined" &&
	typeof window.matchMedia === "function" &&
	window.matchMedia("(hover: hover)").matches;

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
	const navigate = useNavigate();
	const [imgLoaded, setImgLoaded] = useState(false);
	const [imgError, setImgError] = useState(false);
	const [hovered, setHovered] = useState(false);
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
	const tumorLabel =
		previewMetadata.tumor === 1
			? "Tumor"
			: previewMetadata.tumor === 0
				? "No Tumor"
				: "Unknown";
	const tumorColor =
		previewMetadata.tumor === 1
			? "#ef4444"
			: previewMetadata.tumor === 0
				? "#10b981"
				: "#6b7280";

	return (
		<div
			className="bm-card rounded-xl overflow-hidden cursor-pointer group"
			style={
				hovered
					? {
							borderColor: "rgba(0,0,0,0.18)",
							boxShadow:
								"0 0 0 1px rgba(0,0,0,0.05), 0 8px 32px rgba(0,0,0,0.10), 0 2px 12px rgba(0,0,0,0.10)",
							transform: "translateY(-2px)",
					  }
					: {}
			}
			onMouseEnter={() => {
				setHovered(true);
				// The viewer JavaScript is small enough to warm safely. Do not prefetch a
				// CT here: scans are tens of MB, and background downloads can starve the
				// case the reader actually clicks (or reset its connection).
				prefetchViewer();
			}}
			onMouseLeave={() => {
				setHovered(false);
			}}
			onClick={() => navigate(`/case/${id}`)}
		>
			{/* Gradient accent line — slides in on hover */}
			<div
				style={{
					height: "1px",
					background:
						"linear-gradient(90deg, transparent, rgba(0,0,0,0.45), transparent)",
					opacity: hovered ? 1 : 0,
					transition: "opacity 0.3s",
				}}
			/>

			{/* Thumbnail */}
			<div
				className="relative overflow-hidden"
				style={{ aspectRatio: "4/3", background: "#000" }}
			>
				{!imgError && (
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
						className="w-full h-full object-contain object-center"
						style={{
							objectPosition: "center",
							// Only reveal once the image is loaded AND the grid has released
							// the batch, so cards appear together rather than popping in.
							opacity: imgLoaded && reveal ? (hovered ? 1 : 0.97) : 0,
							transform: hovered ? "scale(1.05)" : "scale(1)",
							transition: "opacity 0.4s, transform 0.5s",
						}}
					/>
				)}
				{(!imgLoaded || !reveal) && !imgError && (
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
				<div
					className="absolute inset-0"
					style={{
						background:
							"linear-gradient(to top, #f5f5f5 0%, rgba(245,245,245,0.5) 45%, transparent 80%)",
					}}
				/>

				{/* Corner brackets — appear on hover */}
				{(["tl", "tr", "bl", "br"] as const).map((corner) => (
					<div
						key={corner}
						className="absolute w-4 h-4"
						style={{
							top: corner[0] === "t" ? "8px" : "auto",
							bottom: corner[0] === "b" ? "8px" : "auto",
							left: corner[1] === "l" ? "8px" : "auto",
							right: corner[1] === "r" ? "8px" : "auto",
							borderTop: corner[0] === "t" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
							borderBottom: corner[0] === "b" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
							borderLeft: corner[1] === "l" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
							borderRight: corner[1] === "r" ? "1.5px solid rgba(255,255,255,0.55)" : "none",
							opacity: hovered ? 1 : 0,
							transition: "opacity 0.25s",
						}}
					/>
				))}

				{/* Bookmark toggle — always visible once saved (or on touch devices,
				    which have no hover), otherwise reveals on hover */}
				{onToggleSave && (saved || hovered || !canHover) && (
					<button
						type="button"
						aria-label={saved ? `Remove case ${id} from saved` : `Save case ${id}`}
						title={saved ? "Saved — click to remove" : "Save case"}
						onClick={(e) => {
							e.stopPropagation();
							onToggleSave();
						}}
						className="absolute flex items-center justify-center"
						style={{
							top: "8px",
							right: "8px",
							width: "30px",
							height: "30px",
							padding: 0,
							borderRadius: "8px",
							border: "none",
							outline: "none",
							cursor: "pointer",
							zIndex: 2,
							background: "rgba(0,0,0,0.45)",
							transition: "background 0.15s",
						}}
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,0.72)";
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,0.45)";
						}}
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
				    compare" far more clearly than a bare icon. Reveals on hover; stays + turns
				    blue once selected. Always visible on touch devices, which have no hover. */}
				{onToggleCompare && (compareSelected || hovered || !canHover) && (
					<button
						type="button"
						aria-label={compareSelected ? `Remove case ${id} from comparison` : `Add case ${id} to comparison`}
						aria-pressed={compareSelected}
						title={compareSelected ? "Selected to compare — click to remove" : "Select to compare"}
						onClick={(e) => {
							e.stopPropagation();
							onToggleCompare();
						}}
						className="absolute flex items-center"
						style={{
							bottom: "8px",
							left: "8px",
							gap: "6px",
							padding: "5px 9px 5px 7px",
							borderRadius: "8px",
							border: "none",
							outline: "none",
							cursor: "pointer",
							zIndex: 2,
							background: compareSelected ? "#2563eb" : "rgba(0,0,0,0.5)",
							transition: "background 0.15s",
						}}
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
								<svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true" style={{ display: "block", fill: "none", stroke: "#2563eb", strokeWidth: 4, strokeLinecap: "round", strokeLinejoin: "round" }}>
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

			{/* Data row */}
			<div className="p-3">
				<div className="mb-1">
					<span
						className="font-bold"
						style={{ fontSize: "13px", color: "#111111" }}
					>
						{caseIdStr}
					</span>
				</div>

				<div
					className="flex items-center gap-2"
					style={{ fontSize: "11px", fontWeight: 700, color: "#111111" }}
				>
					<span>Sex {previewMetadata.sex || "—"}</span>
					<span>Age {previewMetadata.age || "—"}y</span>
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
