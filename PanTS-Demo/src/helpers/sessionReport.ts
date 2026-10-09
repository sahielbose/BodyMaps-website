// Reading-session report generation — pure functions only (no DOM, no Cornerstone),
// so this module is unit-testable and reusable. A "reading session" is the recorded
// trace of a radiologist reviewing a case: timestamped viewer events, dictated
// transcript segments, screenshots, and the measurements left on the images. The
// draft report is assembled from that trace by templates — deliberately NOT by an
// AI model — so its content is exactly what happened in the viewer.

import { measurementToolName } from "./measurementTools";

export type SessionEvent = {
	/** ms since session start */
	t: number;
	/** short machine tag: navigate | window | preset | view | measure | screenshot | organ | opacity-fill | opacity-border | session */
	type: string;
	/** human-readable line for the timeline */
	detail: string;
};

export type SessionShotImage = { name: string; dataUrl: string };

export type SessionShot = {
	t: number;
	label: string;
	images: SessionShotImage[];
};

export type TranscriptSegment = { t: number; text: string };

export type ReportMeasurement = { tool: string; label: string; value: string };

export type ReportInput = {
	caseId: string;
	startedAt: number; // epoch ms
	durationMs: number;
	events: SessionEvent[];
	shots: SessionShot[];
	transcript: TranscriptSegment[];
	measurements: ReportMeasurement[];
	/** True when the session recorded narration audio; the report only points to it then. */
	hasAudio?: boolean;
};

/** True for a dataset case id such as "42" or "CV0001". */
export function isCaseId(name: string): boolean {
	return /^(CV)?\d+$/i.test(name);
}

/**
 * What a report calls the scan: a dataset case id ("42", "CV0001") reads "case 42", and
 * anything else is already a name ("the local NIfTI scan", an upload's own label).
 */
export function caseDisplayName(caseId: string): string {
	return isCaseId(caseId) ? `case ${caseId}` : caseId;
}

/** A file-name-safe form of the same name: "case-42", "local-nifti-scan", never a space. */
export function caseFileSlug(caseId: string): string {
	const slug = caseDisplayName(caseId)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^(the-)?/, "")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug || "scan";
}

/** 1 → "1 event", 2 → "2 events". Every noun used here takes a plain "s". */
export function countLabel(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** 83000 → "01:23" (grows to H:MM:SS past an hour). */
export function formatClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const s = total % 60;
	const m = Math.floor(total / 60) % 60;
	const h = Math.floor(total / 3600);
	const mm = String(m).padStart(2, "0");
	const ss = String(s).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type CondensedEvent = SessionEvent & { count: number };

// Scrubbing slices or dragging a slider emits bursts of same-type events; the
// timeline reads better as one line per burst ("navigated ×12") than as spam.
// The two opacity sliders are separate types, so a fill change and a border change never fold together.
// Only the burst types merge; a preset, measurement, organ jump, view change or
// mask edit is a discrete action, so it keeps its own line unless it repeats word
// for word (a drag of one edit tool is already merged when it is logged).
const BURST_TYPES = new Set(["navigate", "window", "opacity-fill", "opacity-border"]);

export function condenseEvents(events: SessionEvent[]): CondensedEvent[] {
	const out: CondensedEvent[] = [];
	for (const e of events) {
		const last = out[out.length - 1];
		if (last && last.type === e.type && (BURST_TYPES.has(e.type) || last.detail === e.detail)) {
			last.count += 1;
			last.detail = e.detail; // keep the final state of the burst
		} else {
			out.push({ ...e, count: 1 });
		}
	}
	return out;
}

// The name comes from the same table the Measure menus read, so a tool is called the
// same thing in the menu, the Measurements panel and the report.
export function toolDisplayName(tool: string): string {
	return measurementToolName(tool);
}

// "Sep 29, 2026, 9:00 PM": a month name reads the same in every locale, where
// the numeric form ("9/29/2026") is day-first or month-first depending on the reader.
const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

function fmtDate(epochMs: number): string {
	try {
		return DATE_FORMAT.format(new Date(epochMs));
	} catch {
		return String(epochMs);
	}
}

// Derive a one-line "technique" summary from the trace: which window presets and
// view layouts the reader actually used.
export function summarizeTechnique(events: SessionEvent[]): string[] {
	const presets = new Set<string>();
	const views = new Set<string>();
	for (const e of events) {
		if (e.type === "preset") presets.add(e.detail.replace(/^Applied\s+/, "").replace(/\s+window$/, ""));
		// Flips, rotations and cine playback are also "view" events, but not views.
		const switched = e.type === "view" ? /^Switched to (.+) view$/.exec(e.detail) : null;
		if (switched) views.add(switched[1]);
	}
	const lines: string[] = [];
	if (views.size) lines.push(`Views reviewed: ${[...views].join(", ")}`);
	if (presets.size) lines.push(`Window presets: ${[...presets].join(", ")}`);
	return lines;
}

// The empty dictation sentence points to the session audio only when there is one.
function noDictationText(hasAudio: boolean | undefined): string {
	return `No dictation captured${hasAudio ? " (see the session audio for the spoken narration)" : ""}.`;
}

// A free-text label can hold a vertical bar or a line break, either of which
// would split a Markdown table row into extra cells.
function mdCell(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function buildReportMarkdown(input: ReportInput): string {
	const { caseId, startedAt, durationMs, events, shots, transcript, measurements, hasAudio } = input;
	const lines: string[] = [];
	lines.push(`# Draft reading report for ${caseDisplayName(caseId)}`);
	lines.push("");
	lines.push(`- **Read on:** ${fmtDate(startedAt)}`);
	lines.push(`- **Reading time:** ${formatClock(durationMs)}`);
	lines.push(`- **Events captured:** ${events.length} · **Key images:** ${shots.length}`);
	const technique = summarizeTechnique(events);
	if (technique.length) {
		lines.push("");
		lines.push("## Technique");
		for (const t of technique) lines.push(`- ${t}`);
	}
	lines.push("");
	lines.push("## Dictated findings");
	if (transcript.length) {
		for (const seg of transcript) lines.push(`- \`[${formatClock(seg.t)}]\` ${seg.text}`);
	} else {
		lines.push(`_${noDictationText(hasAudio)}_`);
	}
	lines.push("");
	lines.push("## Measurements");
	if (measurements.length) {
		lines.push("| # | Tool | Label | Value |");
		lines.push("|---|------|-------|-------|");
		measurements.forEach((m, i) => {
			lines.push(`| ${i + 1} | ${mdCell(toolDisplayName(m.tool))} | ${mdCell(m.label || "No label")} | ${mdCell(m.value)} |`);
		});
	} else {
		lines.push("_No measurements taken._");
	}
	lines.push("");
	lines.push("## Key images");
	if (shots.length) {
		shots.forEach((s, i) => {
			lines.push(`${i + 1}. \`[${formatClock(s.t)}]\` ${s.label} (${s.images.map((im) => im.name).join(", ")})`);
		});
	} else {
		lines.push("_No key images captured._");
	}
	lines.push("");
	lines.push("## Reading timeline");
	for (const e of condenseEvents(events)) {
		lines.push(`- \`[${formatClock(e.t)}]\` ${e.detail}${e.count > 1 ? ` _(×${e.count})_` : ""}`);
	}
	lines.push("");
	lines.push("---");
	lines.push(
		"_Draft assembled from a recorded reading session in the BodyMaps viewer. " +
			"Review and edit before any clinical use. This is not medical advice or a diagnostic report._"
	);
	return lines.join("\n");
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// Self-contained (screenshots embedded as data URLs), print-friendly HTML version.
export function buildReportHtml(input: ReportInput): string {
	const { caseId, startedAt, durationMs, events, shots, transcript, measurements, hasAudio } = input;
	const technique = summarizeTechnique(events);
	const section = (title: string, body: string) =>
		`<section><h2>${escapeHtml(title)}</h2>${body}</section>`;

	const dictation = transcript.length
		? `<ul class="dictation">${transcript
				.map((s) => `<li><span class="t">[${formatClock(s.t)}]</span> ${escapeHtml(s.text)}</li>`)
				.join("")}</ul>`
		: `<p class="muted">${noDictationText(hasAudio)}</p>`;

	const measureRows = measurements
		.map(
			(m, i) =>
				`<tr><td>${i + 1}</td><td>${escapeHtml(toolDisplayName(m.tool))}</td><td>${
					m.label ? escapeHtml(m.label) : "No label"
				}</td><td>${escapeHtml(m.value)}</td></tr>`
		)
		.join("");
	const measureTable = measurements.length
		? `<table><thead><tr><th>#</th><th>Tool</th><th>Label</th><th>Value</th></tr></thead><tbody>${measureRows}</tbody></table>`
		: `<p class="muted">No measurements taken.</p>`;

	const shotBlocks = shots.length
		? shots
				.map(
					(s) =>
						`<figure><figcaption><span class="t">[${formatClock(s.t)}]</span> ${escapeHtml(
							s.label
						)}</figcaption><div class="imgs">${s.images
							.map(
								(im) =>
									`<div class="img"><img src="${im.dataUrl}" alt="${escapeHtml(im.name)}"/><span>${escapeHtml(
										im.name
									)}</span></div>`
							)
							.join("")}</div></figure>`
				)
				.join("")
		: `<p class="muted">No key images captured.</p>`;

	const timeline = condenseEvents(events)
		.map(
			(e) =>
				`<li><span class="t">[${formatClock(e.t)}]</span> ${escapeHtml(e.detail)}${
					e.count > 1 ? ` <span class="muted">(×${e.count})</span>` : ""
				}</li>`
		)
		.join("");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Draft reading report for ${escapeHtml(caseDisplayName(caseId))}</title>
<style>
	body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #16181d; max-width: 880px; margin: 0 auto; padding: 32px 24px 56px; line-height: 1.5; }
	h1 { font-size: 24px; margin-bottom: 4px; }
	h2 { font-size: 16px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 2px solid #16181d; padding-bottom: 4px; margin-top: 32px; }
	.meta { color: #555; font-size: 13px; display: flex; flex-wrap: wrap; column-gap: 0.4em; }
	.nowrap { white-space: nowrap; }
	.meta .nowrap + .nowrap::before { content: "\\00b7"; margin-right: 0.4em; }
	.t { font-family: ui-monospace, monospace; font-size: 12px; color: #5f6368; margin-right: 6px; }
	.muted { color: #5f6368; }
	table { border-collapse: collapse; width: 100%; font-size: 14px; }
	th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; }
	th { background: #f4f5f7; }
	figure { margin: 18px 0; page-break-inside: avoid; }
	figcaption { font-size: 13px; font-weight: 600; margin-bottom: 6px; }
	.imgs { display: flex; gap: 8px; flex-wrap: wrap; }
	.img { flex: 1 1 220px; min-width: 0; max-width: 360px; }
	.img img { width: 100%; border: 1px solid #ddd; border-radius: 4px; background: #000; }
	.img span { display: block; font-size: 11px; color: #5f6368; text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }
	ul { padding-left: 18px; }
	.timeline li { font-size: 13px; }
	.disclaimer { margin-top: 40px; padding: 12px 14px; background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; font-size: 13px; color: #7c2d12; }
	@media (max-width: 640px) { .meta { flex-direction: column; } .meta .nowrap + .nowrap::before { content: none; } }
	@media print { body { padding: 0; } .disclaimer { break-inside: avoid; } }
</style>
</head>
<body>
<h1>Draft reading report for ${escapeHtml(caseDisplayName(caseId))}</h1>
<p class="meta">${[
		`Read on ${escapeHtml(fmtDate(startedAt))}`,
		`Reading time ${formatClock(durationMs)}`,
		countLabel(events.length, "event"),
		countLabel(shots.length, "key image"),
	]
		.map((piece) => `<span class="nowrap">${piece}</span>`)
		.join("")}</p>
${technique.length ? section("Technique", `<ul>${technique.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`) : ""}
${section("Dictated findings", dictation)}
${section("Measurements", measureTable)}
${section("Key images", shotBlocks)}
${section("Reading timeline", `<ul class="timeline">${timeline}</ul>`)}
<div class="disclaimer">Draft assembled from a recorded reading session in the BodyMaps viewer. Review and edit before any clinical use. This is not medical advice or a diagnostic report.</div>
</body>
</html>`;
}
