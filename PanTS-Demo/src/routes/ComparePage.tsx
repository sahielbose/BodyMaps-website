// Side-by-side comparison of two dataset cases: previews + demographics + an aligned
// organ-stats table with per-organ volume/percentile deltas. Reuses the same
// computeStatRows + population-norms pipeline as the viewer's Organ Statistics panel, so
// the numbers match. Data-only (no WebGL), so it loads fast and works without the viewer.
// The two case ids live in the URL (?a=&b=) → the whole comparison is shareable.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { prefetchCompareViewerChunk } from "../helpers/compareSources";
import { alignStatRows } from "../helpers/compareStats";
import { API_BASE } from "../helpers/constants";
import { loadOrganNorms, type OrganNorms } from "../helpers/organNorms";
import { computeStatRows, KURTOSIS_TOOLTIP, type OrganMetric } from "../helpers/organStatsExport";
import { caseIdToApiId } from "../helpers/search";
import "./ComparePage.css";

type Demographics = { sex: string | null; age: number | null; tumor: number | null };
type CaseData = {
	loading: boolean;
	error: boolean;
	demographics: Demographics | null;
	metrics: OrganMetric[] | null;
};
const EMPTY: CaseData = { loading: false, error: false, demographics: null, metrics: null };

// Load one case's demographics (from the existing /api/search) + organ metrics (from
// /api/mask-data). Both degrade independently. The dev seed short-circuits to synthetic
// data so the page is demoable without the dataset.
function useCaseData(id: string): CaseData {
	const [state, setState] = useState<CaseData>(EMPTY);
	useEffect(() => {
		const trimmed = id.trim();
		if (!trimmed) {
			setState(EMPTY);
			return;
		}
		let cancelled = false;
		setState({ ...EMPTY, loading: true });
		(async () => {
			let demographics: Demographics | null = null;
			let metrics: OrganMetric[] | null = null;
			let error = false;
			try {
				const res = await fetch(
					`${API_BASE}/api/search?caseid=${encodeURIComponent(trimmed)}&per_page=1`
				);
				const data = await res.json();
				const item = Array.isArray(data.items) ? data.items[0] : null;
				if (item) {
					const ageNum = item.age === null || item.age === undefined || item.age === "" ? NaN : Number(item.age);
					demographics = {
						sex: item.sex ?? null,
						age: Number.isFinite(ageNum) ? ageNum : null,
						tumor: typeof item.tumor === "number" ? item.tumor : null,
					};
				}
			} catch {
				/* demographics are optional */
			}
			try {
				const fd = new FormData();
				fd.append("sessionKey", trimmed);
				const res = await fetch(`${API_BASE}/api/mask-data`, { method: "POST", body: fd });
				const data = await res.json();
				if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
				metrics = (data.organ_metrics ?? []) as OrganMetric[];
			} catch {
				error = true;
			}
			if (!cancelled) setState({ loading: false, error, demographics, metrics });
		})();
		return () => {
			cancelled = true;
		};
	}, [id]);
	return state;
}

// Preview thumbnail: local endpoint first, HuggingFace proxy fallback, then a placeholder
// (mirrors the dashboard Preview's chain). In dev/demo both endpoints 404 → placeholder.
// `size` picks the CSS modifier — "sm" for the compact chip in the top bar, "lg" (default)
// for the hero card that's now the page's main content.
function Thumbnail({ id, size = "lg" }: { id: string; size?: "sm" | "lg" }) {
	const local = `${API_BASE}/api/get_image_preview/${id}`;
	// Shared helper keeps CancerVerse ids ("CV_00000001") as-is and pads PanTS
	// ids, so the HF URL matches the dashboard Preview's instead of 404ing on CV.
	const caseIdStr = caseIdToApiId(id);
	const hf = `${API_BASE}/api/proxy-image?url=${encodeURIComponent(
		`https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/profile_only/${caseIdStr}/profile.jpg`
	)}`;
	const [stage, setStage] = useState<0 | 1 | 2>(0);
	useEffect(() => setStage(0), [id]);
	if (stage === 2) return <div className={`cmp-thumb cmp-thumb--${size} cmp-thumb--empty`}>No preview</div>;
	return (
		<img
			className={`cmp-thumb cmp-thumb--${size}`}
			src={stage === 0 ? local : hf}
			alt={`Case ${id} preview`}
			onError={() => setStage((s) => (s === 0 ? 1 : 2))}
		/>
	);
}

const fmtSex = (s: string | null) => (s === "M" ? "Male" : s === "F" ? "Female" : "Unknown");
const fmtAge = (a: number | null) => (a === null ? "Age n/a" : `${Math.round(a)} y`);
const fmtTumor = (t: number | null) => (t === 1 ? "Tumor" : t === 0 ? "No tumor" : "Tumor n/a");

// Compact case identity shown in the top bar, next to that case's id input — lets the bar
// itself carry the "which case is A/B" context instead of relying on a separate case row.
function BarChip({ id, data }: { id: string; data: CaseData }) {
	if (!id.trim()) return null;
	return (
		<span className="cmp__chip">
			<Thumbnail id={id} size="sm" />
			<span className="cmp__chip-meta">
				#{id}
				{data.demographics && ` · ${fmtSex(data.demographics.sex)} · ${fmtAge(data.demographics.age)}`}
			</span>
		</span>
	);
}

function CaseHeader({ id, data }: { id: string; data: CaseData }) {
	if (!id.trim()) return <div className="cmp-case cmp-case--empty">No case selected</div>;
	return (
		<div className="cmp-case">
			<Thumbnail id={id} />
			<div className="cmp-case__meta">
				<div className="cmp-case__id">Case {id}</div>
				{data.demographics && (
					<div className="cmp-case__demo">
						{fmtSex(data.demographics.sex)} · {fmtAge(data.demographics.age)} ·{" "}
						{fmtTumor(data.demographics.tumor)}
					</div>
				)}
				<Link className="cmp-case__open" to={`/case/${id}`}>
					Open in viewer →
				</Link>
			</div>
		</div>
	);
}

const fmtVol = (v: number | null) => (v === null ? "—" : `${Math.round(v)} cm³`);
const fmtPct = (p: number | null) => (p === null ? "" : `p${Math.round(p)}`);
const fmtDeltaVol = (d: number | null) => (d === null ? "—" : `${d > 0 ? "+" : ""}${Math.round(d)} cm³`);
const fmtStat = (v: number | null | undefined, digits = 0): string => (v == null ? "—" : v.toFixed(digits));
// Delta helpers shared by every "extended stat" row (median, std dev, skew, kurtosis, ...) —
// null when either side is missing, otherwise a signed, unit-suffixed string.
const delta = (a: number | null | undefined, b: number | null | undefined): number | null =>
	a != null && b != null ? b - a : null;
const fmtDelta = (d: number | null, digits = 0, suffix = ""): string =>
	d === null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(digits)}${suffix}`;
const deltaDir = (d: number | null): string => (d === null || d === 0 ? "" : d > 0 ? " cmp-delta--up" : " cmp-delta--down");

export default function ComparePage() {
	const [params, setParams] = useSearchParams();
	const idA = params.get("a") ?? "";
	const idB = params.get("b") ?? "";

	const [norms, setNorms] = useState<OrganNorms | null>(null);
	useEffect(() => {
		loadOrganNorms().then((n) => n && setNorms(n));
	}, []);

	// Warm only the live viewer JavaScript. Downloading either medical volume in the
	// background competes with the case a reader chooses to open and is unsafe on a
	// shared deployment, so the selected viewer always owns the network connection.
	const warmViewer = () => {
		if (idA && idB) {
			prefetchCompareViewerChunk();
		}
	};
	useEffect(() => {
		if (!idA || !idB) return;
		const timer = window.setTimeout(warmViewer, 1500);
		return () => window.clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [idA, idB]);

	const a = useCaseData(idA);
	const b = useCaseData(idB);

	const rowsA = useMemo(
		() => (a.metrics ? computeStatRows(a.metrics, norms, a.demographics?.sex ?? null, a.demographics?.age ?? null) : []),
		[a.metrics, norms, a.demographics]
	);
	const rowsB = useMemo(
		() => (b.metrics ? computeStatRows(b.metrics, norms, b.demographics?.sex ?? null, b.demographics?.age ?? null) : []),
		[b.metrics, norms, b.demographics]
	);
	const compareRows = useMemo(() => alignStatRows(rowsA, rowsB), [rowsA, rowsB]);

	// One row's extended stats (median/std dev/skew/kurtosis/...) can be expanded at a time,
	// same as the single-case viewer's Organ Statistics panel — keeps the table compact by default.
	const [expandedRow, setExpandedRow] = useState<number | null>(null);

	// The organ-stats table is heavy (many rows, each expandable) — it opens in a popup on
	// demand instead of always occupying the page, so the page itself stays focused on the
	// two scans. Closed automatically if the case ids change out from under it.
	const [showStatsModal, setShowStatsModal] = useState(false);
	useEffect(() => setShowStatsModal(false), [idA, idB]);
	useEffect(() => {
		if (!showStatsModal) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setShowStatsModal(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [showStatsModal]);

	// Draft input state, committed to the URL (and thus to the fetch effects) only on
	// blur/Enter — typing "1234" must not fire /api/search + /api/mask-data for
	// "1", "12", "123" and flicker the whole page per keystroke.
	const [draftA, setDraftA] = useState(idA);
	const [draftB, setDraftB] = useState(idB);
	useEffect(() => {
		setDraftA(idA);
		setDraftB(idB);
	}, [idA, idB]);

	const setId = (key: "a" | "b", value: string) => {
		const next = new URLSearchParams(params);
		if (value.trim()) next.set(key, value.trim());
		else next.delete(key);
		setParams(next, { replace: true });
	};
	const swap = () => {
		const next = new URLSearchParams(params);
		if (idB) next.set("a", idB);
		else next.delete("a");
		if (idA) next.set("b", idA);
		else next.delete("b");
		setParams(next, { replace: true });
	};

	const bothLoaded = compareRows.length > 0;
	const anyError = (idA && a.error) || (idB && b.error);

	return (
		<div className="cmp">
			<div className="cmp__bar">
				<Link className="cmp__home" to="/dashboard" aria-label="Back to dashboard">
					←
				</Link>
				<h1 className="cmp__title">Compare Cases</h1>
				<div className="cmp__inputs">
					<BarChip id={idA} data={a} />
					<input
						className="cmp__input"
						value={draftA}
						onChange={(e) => setDraftA(e.target.value)}
						onBlur={() => setId("a", draftA)}
						onKeyDown={(e) => {
							if (e.key === "Enter") setId("a", draftA);
						}}
						placeholder="Case A id"
						aria-label="Case A id"
					/>
					<button className="cmp__swap" onClick={swap} title="Swap A and B" aria-label="Swap cases">
						⇄
					</button>
					<input
						className="cmp__input"
						value={draftB}
						onChange={(e) => setDraftB(e.target.value)}
						onBlur={() => setId("b", draftB)}
						onKeyDown={(e) => {
							if (e.key === "Enter") setId("b", draftB);
						}}
						placeholder="Case B id"
						aria-label="Case B id"
					/>
					<BarChip id={idB} data={b} />
					{idA && idB && (
						<Link
							className="cmp__viewerlink"
							to={`/compare-viewer?a=${idA}&b=${idB}`}
							onMouseEnter={warmViewer}
							onFocus={warmViewer}
						>
							View images side by side →
						</Link>
					)}
				</div>
			</div>

			<div className="cmp__cases">
				<CaseHeader id={idA} data={a} />
				<CaseHeader id={idB} data={b} />
			</div>

			{!idA || !idB ? (
				<div className="cmp__msg">Enter two case ids above to compare their organ statistics.</div>
			) : bothLoaded ? (
				<div className="cmp__statsPrompt">
					<button className="cmp__statsPromptBtn" onClick={() => setShowStatsModal(true)}>
						View organ statistics ({compareRows.length} organs) →
					</button>
				</div>
			) : anyError ? (
				<div className="cmp__msg">
					Organ statistics aren't available for {a.error ? `case ${idA}` : ""}
					{a.error && b.error ? " and " : ""}
					{b.error ? `case ${idB}` : ""} here.
					<br />
					<span style={{ opacity: 0.7 }}>(They're computed from the dataset volumes on the server.)</span>
				</div>
			) : (
				<div className="cmp__msg">Loading…</div>
			)}

			{showStatsModal && bothLoaded && (
				<div className="cmp__modalOverlay" onClick={() => setShowStatsModal(false)}>
					<div
						className="cmp__modal"
						role="dialog"
						aria-modal="true"
						aria-label="Organ statistics"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="cmp__modalHead">
							<h2 className="cmp__modalTitle">Organ Statistics</h2>
							<button className="cmp__modalClose" onClick={() => setShowStatsModal(false)} aria-label="Close">
								×
							</button>
						</div>
						<div className="cmp__modalBody">
							<div className="cmp__table">
								<div className="cmp__row cmp__row--head">
									<span>Organ</span>
									<span>Case {idA}</span>
									<span>Case {idB}</span>
									<span>Δ (B − A)</span>
								</div>
								{compareRows.map((r, i) => {
									const expanded = expandedRow === i;
									const truncated = Boolean(r.a?.truncated || r.b?.truncated);
									const toggle = () => setExpandedRow(expanded ? null : i);
									const deltaMeanHu = delta(r.a?.mean_hu, r.b?.mean_hu);
									const deltaMedian = delta(r.a?.median, r.b?.median);
									const deltaStdDev = delta(r.a?.standard_deviation, r.b?.standard_deviation);
									const deltaMin = delta(r.a?.min_value, r.b?.min_value);
									const deltaMax = delta(r.a?.max_value, r.b?.max_value);
									const deltaSkew = delta(r.a?.skewness, r.b?.skewness);
									const deltaKurt = delta(r.a?.kurtosis, r.b?.kurtosis);
									return (
										<div className="cmp__rowgroup" key={`${r.organ_name}-${i}`}>
											<div
												className="cmp__row cmp__row--expandable"
												role="button"
												tabIndex={0}
												aria-expanded={expanded}
												onClick={toggle}
												onKeyDown={(e) => {
													if (e.key === "Enter" || e.key === " ") {
														e.preventDefault();
														toggle();
													}
												}}
											>
												<span className="cmp__organ">
													<span className={`cmp__chevron${expanded ? " cmp__chevron--open" : ""}`}>›</span>
													{r.label}
													{truncated && (
														<span className="cmp__truncated-flag" title="Mask reaches the volume edge in at least one case — metrics may be clipped">
															⚠
														</span>
													)}
												</span>
												<span className="cmp__cell">
													<span className="cmp__cell-line">
														<span className="cmp__vol">{fmtVol(r.a?.volume_cm3 ?? null)}</span>
														{r.a?.percentile != null && <span className="cmp__pct">{fmtPct(r.a.percentile)}</span>}
													</span>
													{r.a?.mean_hu != null && <span className="cmp__meanhu">{Math.round(r.a.mean_hu)} HU mean</span>}
												</span>
												<span className="cmp__cell">
													<span className="cmp__cell-line">
														<span className="cmp__vol">{fmtVol(r.b?.volume_cm3 ?? null)}</span>
														{r.b?.percentile != null && <span className="cmp__pct">{fmtPct(r.b.percentile)}</span>}
													</span>
													{r.b?.mean_hu != null && <span className="cmp__meanhu">{Math.round(r.b.mean_hu)} HU mean</span>}
												</span>
												<span className="cmp__cell">
													<span className={`cmp__cell-line${deltaDir(r.deltaVolume)}`}>
														<span className="cmp__vol">{fmtDeltaVol(r.deltaVolume)}</span>
														{r.deltaPercentile != null && (
															<span className="cmp__pct">
																{r.deltaPercentile > 0 ? "+" : ""}
																{Math.round(r.deltaPercentile)} pts
															</span>
														)}
													</span>
													{deltaMeanHu != null && (
														<span className={`cmp__meanhu${deltaDir(deltaMeanHu)}`}>{fmtDelta(deltaMeanHu, 0, " HU mean")}</span>
													)}
												</span>
											</div>
											{expanded && (
												<div className="cmp__detail">
													<div className="cmp__detail-row cmp__detail-row--head">
														<span>Distribution</span>
														<span>Case {idA}</span>
														<span>Case {idB}</span>
														<span>Δ</span>
													</div>
													<div className="cmp__detail-row">
														<span>Median HU</span>
														<span>{fmtStat(r.a?.median)}</span>
														<span>{fmtStat(r.b?.median)}</span>
														<span className={`cmp__detail-delta${deltaDir(deltaMedian)}`}>{fmtDelta(deltaMedian)}</span>
													</div>
													<div className="cmp__detail-row">
														<span>Std Dev HU</span>
														<span>{fmtStat(r.a?.standard_deviation)}</span>
														<span>{fmtStat(r.b?.standard_deviation)}</span>
														<span className={`cmp__detail-delta${deltaDir(deltaStdDev)}`}>{fmtDelta(deltaStdDev)}</span>
													</div>
													<div className="cmp__detail-row">
														<span>Min HU</span>
														<span>{fmtStat(r.a?.min_value)}</span>
														<span>{fmtStat(r.b?.min_value)}</span>
														<span className={`cmp__detail-delta${deltaDir(deltaMin)}`}>{fmtDelta(deltaMin)}</span>
													</div>
													<div className="cmp__detail-row">
														<span>Max HU</span>
														<span>{fmtStat(r.a?.max_value)}</span>
														<span>{fmtStat(r.b?.max_value)}</span>
														<span className={`cmp__detail-delta${deltaDir(deltaMax)}`}>{fmtDelta(deltaMax)}</span>
													</div>
													<div className="cmp__detail-row">
														<span>Skewness</span>
														<span>{fmtStat(r.a?.skewness, 2)}</span>
														<span>{fmtStat(r.b?.skewness, 2)}</span>
														<span className={`cmp__detail-delta${deltaDir(deltaSkew)}`}>{fmtDelta(deltaSkew, 2)}</span>
													</div>
													<div className="cmp__detail-row">
														<span className="cmp__tooltip-label" title={KURTOSIS_TOOLTIP}>
															Kurtosis
														</span>
														<span>{fmtStat(r.a?.kurtosis, 2)}</span>
														<span>{fmtStat(r.b?.kurtosis, 2)}</span>
														<span className={`cmp__detail-delta${deltaDir(deltaKurt)}`}>{fmtDelta(deltaKurt, 2)}</span>
													</div>
												</div>
											)}
										</div>
									);
								})}
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
