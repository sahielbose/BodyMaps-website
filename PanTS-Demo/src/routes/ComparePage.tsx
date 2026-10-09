// Side-by-side comparison of two dataset cases: previews + demographics + an aligned
// organ-stats table with per-organ volume/percentile deltas. Reuses the same
// computeStatRows + population-norms pipeline as the viewer's Organ Statistics panel, so
// the numbers match. Data-only (no WebGL), so it loads fast and works without the viewer.
// The two case ids live in the URL (?a=&b=) → the whole comparison is shareable.
//
// Part of the viewer family (like /case and /compare-viewer): a dark surface with its own
// bar and no site header or footer. The back arrow in the bar is the way out.
import { IconArrowLeft, IconArrowsLeftRight, IconChevronRight, IconPhotoOff } from "@tabler/icons-react";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { prefetchCompareViewerChunk } from "../helpers/compareSources";
import { alignStatRows, roundedDelta, roundTo } from "../helpers/compareStats";
import { API_BASE } from "../helpers/constants";
import { formatSex, formatTumor } from "../helpers/demographics";
import { loadOrganNorms, type OrganNorms } from "../helpers/organNorms";
import { computeStatRows, fmtVolumeCm3, KURTOSIS_TOOLTIP, roundVolumeCm3, type OrganMetric } from "../helpers/organStatsExport";
import { caseIdToApiId } from "../helpers/search";
import { useBackdropDismiss, useDialogFocus } from "../hooks/useDialogFocus";
import "./ComparePage.css";

type Demographics = { sex: string | null; age: number | null; tumor: number | null };
type CaseData = {
	loading: boolean;
	error: boolean;
	demographics: Demographics | null;
	metrics: OrganMetric[] | null;
	// The case loaded fine but has no organ masks (CancerVerse is CT only), so there are
	// no statistics to wait for and nothing failed.
	noMasks: boolean;
};
const EMPTY: CaseData = { loading: false, error: false, demographics: null, metrics: null, noMasks: false };

// CancerVerse ids ("CV_00000001") keep their prefix; the backend has no masks for them.
const isCancerVerseId = (id: string) => /^CV/i.test(id.trim());

// Zero-pads the digits of a CancerVerse id so "cv_1" and "CV_00000001" compare equal.
const normalizeCancerVerseId = (id: string) =>
	id.trim().toUpperCase().replace(/^CV[_-]?(\d+)$/, (_m, digits: string) => `CV_${digits.padStart(8, "0")}`);

// A card label pastes as it reads: "PanTS_00000017" (or "PanTS-17") is case 17, as in the
// dashboard compare tray. Other ids, CancerVerse ones included, are left as typed.
const normalizeCaseId = (id: string) => {
	const trimmed = id.trim();
	const m = /^(?:PANTS[_-]?)?(\d+)$/i.exec(trimmed);
	return m ? String(parseInt(m[1], 10)) : trimmed;
};

// Load one case's demographics (from the existing /api/search) + organ metrics (from
// /api/mask-data). Both degrade independently. The dev seed short-circuits to synthetic
// data so the page is demoable without the dataset. `attempt` is bumped to load the same id
// again after a failure.
function useCaseData(id: string, attempt: number): CaseData {
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
			let noMasks = false;
			try {
				// The search covers PanTS only by default, so a CancerVerse id needs its own dataset. A PanTS
				// id keeps the default: across both datasets a digit id would also match CV_0000000N.
				// A CancerVerse id is searched in its padded form, since "cv_1" is no substring of CV_00000001.
				const isCv = isCancerVerseId(trimmed);
				const dataset = isCv ? "&dataset=cancerverse" : "";
				const query = isCv ? normalizeCancerVerseId(trimmed) : trimmed;
				const res = await fetch(
					`${API_BASE}/api/search?caseid=${encodeURIComponent(query)}&per_page=1${dataset}`
				);
				const data = await res.json();
				let item = Array.isArray(data.items) ? data.items[0] : null;
				if (isCancerVerseId(trimmed)) {
					// A CancerVerse search is a substring match, so the first hit can be another case
					// (CV_0000001 finds CV_00000010). Only the case that was typed counts, and a CancerVerse
					// id that matches nothing is reported rather than shown as a healthy case.
					const found = item?.case_id ?? item?.["PanTS ID"];
					if (!item || (typeof found === "string" && normalizeCancerVerseId(found) !== normalizeCancerVerseId(trimmed))) {
						item = null;
						error = true;
					}
				}
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
			if (isCancerVerseId(trimmed)) {
				noMasks = !error;
			} else {
				try {
					const fd = new FormData();
					fd.append("sessionKey", normalizeCaseId(trimmed));
					const res = await fetch(`${API_BASE}/api/mask-data`, { method: "POST", body: fd });
					const data = await res.json();
					if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
					if (data.masks_available === false) noMasks = true;
					else metrics = (data.organ_metrics ?? []) as OrganMetric[];
				} catch (e) {
					console.error(`Organ statistics request failed for case ${trimmed}`, e);
					error = true;
				}
			}
			if (!cancelled) setState({ loading: false, error, demographics, metrics, noMasks });
		})();
		return () => {
			cancelled = true;
		};
	}, [id, attempt]);
	return state;
}

// Still waiting on this case: either its fetch is in flight, or the effect that starts
// it hasn't run yet (first render after the id changed).
const isPending = (id: string, data: CaseData) =>
	Boolean(id.trim()) && (data.loading || (!data.error && !data.noMasks && data.metrics === null));

// The phone statistics columns fit about 14 characters of their 10px label on one line.
const PHONE_LABEL_CHARS = 14;
function phoneLabel(full: string, short: string): string {
	return full.length <= PHONE_LABEL_CHARS ? full : short;
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
	if (stage === 2) {
		// The 26px chip has no room for words: an icon, named for screen readers.
		return (
			<div className={`cmp-thumb cmp-thumb--${size} cmp-thumb--empty`} role="img" aria-label="No preview">
				<IconPhotoOff size={size === "sm" ? 14 : 28} stroke={1.5} aria-hidden="true" />
				{size === "lg" && <span aria-hidden="true">No preview</span>}
			</div>
		);
	}
	return (
		<img
			className={`cmp-thumb cmp-thumb--${size}`}
			src={stage === 0 ? local : hf}
			alt={`Case ${id} preview`}
			onError={() => setStage((s) => (s === 0 ? 1 : 2))}
		/>
	);
}

const fmtSex = (s: string | null) => formatSex(s) ?? "Sex unknown";
const fmtAge = (a: number | null) => (a === null ? "Age unknown" : `${Math.round(a)} y`);
const fmtTumor = formatTumor;

// The case's thumbnail, shown as a prefix inside its id input. It takes no room beside the
// input, so the inputs stay exactly as wide as their cards; the id and demographics are on
// the case card below. It ignores the pointer so a click on it reaches the input underneath,
// which carries the id tooltip instead.
function BarChip({ id }: { id: string }) {
	if (!id.trim()) return null;
	return (
		<span className="cmp__chip">
			<Thumbnail id={id} size="sm" />
		</span>
	);
}

// A failed id's input is described by its own card's error line, which is shown
// whatever the other id holds (the shared status line still asks for both ids).
const caseErrorId = (label: "A" | "B") => `cmp-case-${label.toLowerCase()}-error`;

function CaseHeader({ label, id, data }: { label: "A" | "B"; id: string; data: CaseData }) {
	if (!id.trim()) {
		return (
			<div className="cmp-case cmp-case--empty">
				<p className="cmp-case__none">
					No case selected for <span className="cmp__nowrap">case {label}</span>
				</p>
			</div>
		);
	}
	return (
		<div className={`cmp-case${data.error ? " cmp-case--failed" : ""}`}>
			<Thumbnail id={id} />
			<div className="cmp-case__meta">
				<h2 className="cmp-case__id">Case {id}</h2>
				{data.demographics && (
					<div className="cmp-case__demo">
						{fmtSex(data.demographics.sex)} · {fmtAge(data.demographics.age)} ·{" "}
						{fmtTumor(data.demographics.tumor)}
					</div>
				)}
				{data.error && (
					<p className="cmp-case__error" id={caseErrorId(label)}>
						Organ statistics couldn't be loaded for this case.
					</p>
				)}
				<Link className="cmp-case__open" to={`/case/${id}`} aria-label={`Open in viewer, case ${id}`}>
					Open in viewer <span aria-hidden="true">→</span>
				</Link>
			</div>
		</div>
	);
}

// A missing figure is null, not a string: the cell renders it as a muted "No data"
// (.cmp__cell--empty) so it does not read as a value.
const NO_DATA = "No data";
// A true minus sign for a negative figure, so every number in the table matches the "−" in the
// difference header and sits level with "+".
const minus = (s: string) => s.replace(/^-/, "−");
const fmtVol = (v: number | null): string | null => (v === null ? null : fmtVolumeCm3(v));
const fmtPct = (p: number | null) => (p === null ? "" : `p${roundTo(p)}`);
const fmtStat = (v: number | null | undefined, digits = 0): string | null => (v == null ? null : minus(roundTo(v, digits).toFixed(digits)));
// Delta helpers shared by every "extended stat" row (median, std dev, skew, kurtosis, ...) —
// null when either side is missing, otherwise the difference of the two values as printed.
const delta = roundedDelta;
const fmtDelta = (d: number | null, digits = 0, suffix = ""): string | null => {
	if (d === null) return null;
	const r = roundTo(d, digits);
	return `${r > 0 ? "+" : ""}${minus(r.toFixed(digits))}${suffix}`;
};
// A volume delta carries one decimal when either volume beside it does (under 10 cm³).
const volDigits = (a: number | null | undefined, b: number | null | undefined): number =>
	(a != null && roundVolumeCm3(a) < 10) || (b != null && roundVolumeCm3(b) < 10) ? 1 : 0;
const fmtDeltaVol = (d: number | null, digits = 0) => fmtDelta(d, digits, " cm³");
const deltaDir = (d: number | null, digits = 0): string => {
	if (d === null) return "";
	const r = roundTo(d, digits);
	return r === 0 ? "" : r > 0 ? " cmp-delta--up" : " cmp-delta--down";
};

// One figure in the table: the text, or a muted "No data" when there is none. `className`
// is the cell's own class; the empty modifier is added after it.
function Figure({ text, className, role }: { text: string | null; className: string; role?: "cell" }) {
	return text === null ? (
		<span role={role} className={`${className} cmp__cell--empty`}>{NO_DATA}</span>
	) : (
		<span role={role} className={className}>{text}</span>
	);
}

// The distribution lines of an expanded row, in display order.
const DETAIL_STATS: {
	key: "median" | "standard_deviation" | "min_value" | "max_value" | "skewness" | "kurtosis";
	label: string;
	digits: number;
	tooltip?: string;
}[] = [
	{ key: "median", label: "Median HU", digits: 0 },
	{ key: "standard_deviation", label: "Std dev HU", digits: 0 },
	{ key: "min_value", label: "Min HU", digits: 0 },
	{ key: "max_value", label: "Max HU", digits: 0 },
	{ key: "skewness", label: "Skewness", digits: 2 },
	{ key: "kurtosis", label: "Kurtosis", digits: 2, tooltip: KURTOSIS_TOOLTIP },
];

const TRUNCATED_NOTE = "Mask reaches the volume edge in at least one case, so these metrics may be clipped.";

export default function ComparePage() {
	const [params, setParams] = useSearchParams();
	const idA = params.get("a") ?? "";
	const idB = params.get("b") ?? "";
	// Carried into the side-by-side viewer, which then reads full-resolution CTs.
	const hd = params.get("hd") === "1";

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

	// Bumped to load a failed case again, since the id itself has not changed.
	const [attemptA, setAttemptA] = useState(0);
	const [attemptB, setAttemptB] = useState(0);
	const a = useCaseData(idA, attemptA);
	const b = useCaseData(idB, attemptB);

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

	// The table is only offered when BOTH cases loaded. With one side missing it would be a
	// column of empty cells dressed up as data, so the failure is said in words instead.
	const bothIds = Boolean(idA && idB);
	// The A and B labels are gone once ids are typed, so the direction names the two cases.
	const deltaLabel = `Δ (Case ${idB} − Case ${idA})`;
	// The phone columns are about 95px wide, room for 14 characters of their one-line labels. The delta
	// label drops the word "Case" (the columns beside it carry it) and the full label is the cell's title.
	// Longer ids (CancerVerse "CV_00000001") keep what tells the columns apart: the bare id, and "Δ".
	const caseLabelA = phoneLabel(`Case ${idA}`, idA);
	const caseLabelB = phoneLabel(`Case ${idB}`, idB);
	const deltaLabelShort = phoneLabel(`Δ ${idB} − ${idA}`, "Δ");
	const loading = isPending(idA, a) || isPending(idB, b);
	const failedIds = [idA && a.error ? idA : "", idB && b.error ? idB : ""].filter(Boolean);
	const noMaskIds = [idA && a.noMasks ? idA.trim() : "", idB && b.noMasks ? idB.trim() : ""].filter(Boolean);
	// The Try again button is replaced by the loading line, so focus moves to the status region (it
	// stays mounted) instead of dropping to the page, and a failed retry brings the button back just after it.
	const statusRef = useRef<HTMLDivElement>(null);
	const retryFailed = () => {
		statusRef.current?.focus();
		if (idA && a.error) setAttemptA((n) => n + 1);
		if (idB && b.error) setAttemptB((n) => n + 1);
	};
	const statsReady = bothIds && !loading && failedIds.length === 0 && compareRows.length > 0;

	// The organ-stats table is heavy (many rows, each expandable) — it opens in a popup on
	// demand instead of always occupying the page, so the page itself stays focused on the
	// two scans. Closed automatically if the case ids change out from under it.
	const [showStatsModal, setShowStatsModal] = useState(false);
	useEffect(() => {
		setShowStatsModal(false);
		setExpandedRow(null);
	}, [idA, idB]);
	const closeStats = () => {
		setShowStatsModal(false);
		setExpandedRow(null);
	};
	const statsOpen = showStatsModal && statsReady;
	// Focus moves into the dialog, Tab stays inside, Escape closes it and focus goes back
	// to the "View organ statistics" button.
	const modalRef = useRef<HTMLDivElement>(null);
	useDialogFocus(statsOpen, modalRef, { onEscape: closeStats });
	const backdrop = useBackdropDismiss(closeStats);

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
		const id = value.trim() ? normalizeCaseId(value) : "";
		// The field shows the id it committed, even when that is the case already
		// open (a pasted PanTS_00000017 for case 17 changes no URL to resync from).
		if (key === "a") setDraftA(id);
		else setDraftB(id);
		const next = new URLSearchParams(params);
		if (id) next.set(key, id);
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

	// One status line, always mounted so screen readers announce each change to it.
	let status: ReactNode = null;
	if (!bothIds) {
		status = "Enter two case IDs above to compare their organ statistics.";
	} else if (loading) {
		status = "Loading organ statistics…";
	} else if (failedIds.length > 0) {
		const which = failedIds.map((id, i) => (
			<Fragment key={`${id}-${i}`}>
				{i > 0 && " and "}
				<span className="cmp__nowrap">case {id}</span>
			</Fragment>
		));
		status = (
			<>
				<span className="cmp__status-strong">
					Organ statistics couldn't be loaded for {which}, so there is nothing to compare yet.
				</span>
				<br />
				They're computed from the dataset volumes on the server. Check the case ID, or try another case.
				<br />
				<button type="button" className="cmp__statsPromptBtn" style={{ marginTop: 16 }} onClick={retryFailed}>
					Try again
				</button>
			</>
		);
	} else if (noMaskIds.length > 0) {
		// Not a failure: the case just has no organ masks. The images can still be compared.
		const which = noMaskIds.map((id, i) => (
			<Fragment key={`${id}-${i}`}>
				{i > 0 && " and "}
				<span className="cmp__nowrap">case {id}</span>
			</Fragment>
		));
		status = (
			<>
				{noMaskIds.every(isCancerVerseId)
					? "CancerVerse cases are CT only, so there are no organ statistics for "
					: "There are no organ masks, so there are no organ statistics for "}
				{which}.
				{" "}You can still compare the scans using View images side by side.
			</>
		);
	} else if (compareRows.length === 0) {
		status = "Neither case has organ statistics to compare.";
	}

	return (
		<div className="cmp">
			<main className="cmp__main">
				<div className="cmp__bar">
					<div className="cmp__heading">
						<Link className="cmp__home" to="/dashboard" aria-label="Back to the dataset" title="Back to the dataset">
							<IconArrowLeft size={18} aria-hidden="true" />
						</Link>
						<h1 className="cmp__title">Compare cases</h1>
					</div>
					<div className="cmp__inputs">
						<div className={`cmp__slot${idA.trim() ? " cmp__slot--chip" : ""}`}>
							<BarChip id={idA} />
							<input
								className="cmp__input"
								value={draftA}
								onChange={(e) => setDraftA(e.target.value)}
								onBlur={() => setId("a", draftA)}
								onKeyDown={(e) => {
									if (e.key === "Enter") setId("a", draftA);
								}}
								placeholder="Case A ID"
								title={idA.trim() ? `#${idA}` : undefined}
								aria-label="Case A ID"
								aria-invalid={idA && a.error ? true : undefined}
								aria-describedby={idA && a.error ? caseErrorId("A") : undefined}
							/>
						</div>
						<button type="button" className="cmp__swap" onClick={swap} title="Swap A and B" aria-label="Swap cases">
							<IconArrowsLeftRight size={16} aria-hidden="true" />
						</button>
						<div className={`cmp__slot cmp__slot--b${idB.trim() ? " cmp__slot--chip" : ""}`}>
							<BarChip id={idB} />
							<input
								className="cmp__input"
								value={draftB}
								onChange={(e) => setDraftB(e.target.value)}
								onBlur={() => setId("b", draftB)}
								onKeyDown={(e) => {
									if (e.key === "Enter") setId("b", draftB);
								}}
								placeholder="Case B ID"
								title={idB.trim() ? `#${idB}` : undefined}
								aria-label="Case B ID"
								aria-invalid={idB && b.error ? true : undefined}
								aria-describedby={idB && b.error ? caseErrorId("B") : undefined}
							/>
						</div>
					</div>
					{/* Always mounted, so the bar keeps its height before and after both IDs are set (on phones it is hidden while empty). */}
					<div className="cmp__cta">
						{bothIds && (
							<Link
								className="cmp__viewerlink"
								to={`/compare-viewer?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}${hd ? "&hd=1" : ""}`}
								onMouseEnter={warmViewer}
								onFocus={warmViewer}
							>
								View images side by side →
							</Link>
						)}
					</div>
				</div>

				<div className="cmp__cases">
					<CaseHeader label="A" id={idA} data={a} />
					<CaseHeader label="B" id={idB} data={b} />
				</div>

				<div className="cmp__msg" id="cmp-status" role="status" ref={statusRef} tabIndex={-1}>
					{status}
				</div>

				{statsReady && (
					<div className="cmp__statsPrompt">
						<button type="button" className="cmp__statsPromptBtn" onClick={() => setShowStatsModal(true)}>
							View organ statistics ({compareRows.length} {compareRows.length === 1 ? "organ" : "organs"}) →
						</button>
					</div>
				)}
			</main>

			{statsOpen && (
				<div className="cmp__modalOverlay" {...backdrop}>
					<div
						ref={modalRef}
						className="cmp__modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="cmp-stats-title"
					>
						<div className="cmp__modalHead">
							<h2 className="cmp__modalTitle" id="cmp-stats-title">
								Organ statistics
							</h2>
							<button type="button" className="cmp__modalClose" onClick={closeStats} aria-label="Close">
								×
							</button>
						</div>
						<div className="cmp__modalBody">
							{/* Scrolls sideways on its own on narrow screens, so the difference
							    column is never cut off. Focusable so the keyboard can scroll it. */}
							{/* On a phone the head row is hidden, and with long ids the rows only say "Δ",
							    so this line keeps the subtraction order in sight. */}
							{deltaLabelShort === "Δ" && <p className="cmp__delta-note">Δ = Case {idB} − Case {idA}</p>}
							{/* The flag's title only shows on hover, so touch screens get the note as a line. */}
							{compareRows.some((r) => r.a?.truncated || r.b?.truncated) && (
								<p className="cmp__truncated-note">
									<span className="cmp__truncated-flag" aria-hidden="true">
										⚠
									</span>{" "}
									{TRUNCATED_NOTE}
								</p>
							)}
							<div className="cmp__tableScroll" tabIndex={0} role="region" aria-label="Organ statistics table">
							<div className="cmp__table" role="table" aria-label="Organ statistics by case">
								<div className="cmp__row cmp__row--head" role="row">
									<span role="columnheader">Organ</span>
									<span role="columnheader">Case {idA}</span>
									<span role="columnheader">Case {idB}</span>
									<span role="columnheader">{deltaLabel}</span>
								</div>
								{compareRows.map((r, i) => {
									const expanded = expandedRow === i;
									const truncated = Boolean(r.a?.truncated || r.b?.truncated);
									const toggle = () => setExpandedRow(expanded ? null : i);
									const deltaMeanHu = delta(r.a?.mean_hu, r.b?.mean_hu);
									// One line per distribution stat; an organ with none of them in either case
									// collapses to a single note instead of a wall of "No data".
									const detail = DETAIL_STATS.map((d) => ({
										...d,
										a: r.a?.[d.key],
										b: r.b?.[d.key],
										delta: delta(r.a?.[d.key], r.b?.[d.key], d.digits),
									}));
									const noDetail = detail.every((d) => d.a == null && d.b == null);
									return (
										<div className="cmp__rowgroup" role="rowgroup" key={`${r.organ_name}-${i}`}>
											{/* The whole row still toggles on a click; the organ name is the real
											    disclosure button, so the figures stay addressable cells. */}
											<div className="cmp__row cmp__row--expandable" role="row" onClick={toggle}>
												<span className="cmp__organ" role="cell">
													<button type="button" className="cmp__toggle" aria-expanded={expanded}>
														<span className={`cmp__chevron${expanded ? " cmp__chevron--open" : ""}`} aria-hidden="true">
															<IconChevronRight size={16} stroke={2} />
														</span>
														<span className="cmp__organ-name">
															{r.label}
															{truncated && (
																<span className="cmp__truncated-flag" role="img" aria-label={TRUNCATED_NOTE} title={TRUNCATED_NOTE}>
																	⚠
																</span>
															)}
														</span>
													</button>
												</span>
												{/* data-label names each figure on a phone, where the header row is hidden. */}
												<span className="cmp__cell" role="cell" data-label={caseLabelA}>
													<span className="cmp__cell-line">
														<Figure className="cmp__vol" text={fmtVol(r.a?.volume_cm3 ?? null)} />
														{r.a?.percentile != null && <span className="cmp__pct">{fmtPct(r.a.percentile)}</span>}
													</span>
													{r.a?.mean_hu != null && <span className="cmp__meanhu">{minus(String(roundTo(r.a.mean_hu)))} HU mean</span>}
												</span>
												<span className="cmp__cell" role="cell" data-label={caseLabelB}>
													<span className="cmp__cell-line">
														<Figure className="cmp__vol" text={fmtVol(r.b?.volume_cm3 ?? null)} />
														{r.b?.percentile != null && <span className="cmp__pct">{fmtPct(r.b.percentile)}</span>}
													</span>
													{r.b?.mean_hu != null && <span className="cmp__meanhu">{minus(String(roundTo(r.b.mean_hu)))} HU mean</span>}
												</span>
												<span className="cmp__cell" role="cell" data-label={deltaLabelShort} title={deltaLabel}>
													<span className={`cmp__cell-line${deltaDir(r.deltaVolume, volDigits(r.a?.volume_cm3, r.b?.volume_cm3))}`}>
														<Figure className="cmp__vol" text={fmtDeltaVol(r.deltaVolume, volDigits(r.a?.volume_cm3, r.b?.volume_cm3))} />
														{r.deltaPercentile != null && (
															<span className="cmp__pct">{fmtDelta(r.deltaPercentile, 0, Math.abs(roundTo(r.deltaPercentile)) === 1 ? " pt" : " pts")}</span>
														)}
													</span>
													{deltaMeanHu != null && (
														<span className={`cmp__meanhu${deltaDir(deltaMeanHu)}`}>{fmtDelta(deltaMeanHu, 0, " HU mean")}</span>
													)}
												</span>
											</div>
											{expanded && (
												<div className="cmp__detail" role="presentation">
													{noDetail ? (
														<div role="row">
															<p className="cmp__detail-none" role="cell">No distribution statistics for this organ.</p>
														</div>
													) : (
														<>
															<div className="cmp__detail-row cmp__detail-row--head" role="row">
																<span role="columnheader">Distribution</span>
																<span role="columnheader">Case {idA}</span>
																<span role="columnheader">Case {idB}</span>
																{/* A phone's 60px column shows "Δ": the organ row right above names both cases. */}
																<span className="cmp__head-delta" role="columnheader" data-short="Δ" title={deltaLabel}>{deltaLabel}</span>
															</div>
															{detail.map((d) => (
																<div className="cmp__detail-row" role="row" key={d.key}>
																	{d.tooltip ? (
																		<span className="cmp__tooltip-label" role="rowheader" title={d.tooltip}>
																			{d.label}
																		</span>
																	) : (
																		<span role="rowheader">{d.label}</span>
																	)}
																	<Figure role="cell" className="cmp__stat" text={fmtStat(d.a, d.digits)} />
																	<Figure role="cell" className="cmp__stat" text={fmtStat(d.b, d.digits)} />
																	<Figure
																		role="cell"
																		className={`cmp__detail-delta${deltaDir(d.delta, d.digits)}`}
																		text={fmtDelta(d.delta, d.digits)}
																	/>
																</div>
															))}
														</>
													)}
												</div>
											)}
										</div>
									);
								})}
							</div>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
