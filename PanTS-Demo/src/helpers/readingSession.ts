// Voice-assisted reading session recorder. While a radiologist reviews a case the
// session captures, entirely client-side:
//   - microphone narration (MediaRecorder → webm/mp4 audio), if the mic is granted
//   - a live dictation transcript via the browser's Web Speech API, if available
//   - a timestamped event timeline (the viewer logs navigation, window/level,
//     presets, measurements, screenshots into it)
//   - screenshots ("key images") captured by the viewer at the right moments
// Everything fails soft: no mic / no speech API just means an events-only session.
// Nothing is uploaded by the app — the result stays in the browser until the user
// downloads the bundle or the draft report. The dictation transcript is the one
// exception to "stays on the device": the browser's own speech service may send the
// narration to its provider (the REC pill's microphone tooltip says so).

import type {
	ReportMeasurement,
	SessionEvent,
	SessionShot,
	SessionShotImage,
	TranscriptSegment,
} from "./sessionReport";
import { buildReportHtml, buildReportMarkdown, formatClock } from "./sessionReport";

export type SessionResult = {
	caseId: string;
	startedAt: number;
	durationMs: number;
	events: SessionEvent[];
	shots: SessionShot[];
	transcript: TranscriptSegment[];
	audio: Blob | null;
	audioExt: string; // "webm" | "mp4" — matches the recorder's mime
	micGranted: boolean;
	/** Elapsed ms when the microphone dropped out mid-session (unplugged, asleep, revoked); the audio ends there. */
	micLostAtMs?: number | null;
};

// Minimal surface of the (non-standard) SpeechRecognition API we use.
type SpeechRecognitionLike = {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
	onend: (() => void) | null;
	onerror: ((e: { error?: string }) => void) | null;
	start: () => void;
	stop: () => void;
};

// The speech engine delivers a sentence still being recognised after stop(); Stop
// waits this long for it before the transcript is handed over.
export const DICTATION_FLUSH_TIMEOUT_MS = 1000;

// Firefox and Safari never settle getUserMedia when the prompt is dismissed
// without an answer, so the wait is capped and the session starts events-only.
export const MIC_PROMPT_TIMEOUT_MS = 15000;

const FATAL_SPEECH_ERRORS = ["not-allowed", "service-not-allowed", "network", "language-not-supported", "audio-capture"];

// Two mask edits are the same operation when they read the same once the trailing
// voxel count and the measured amounts are set aside: "Grew the class by 2 mm (900
// voxels)" and "Grew the class by 3 mm (1,400 voxels)" are one drag, "Deleted class" is
// not. Other details stay in the comparison, so "Hollowed (inner surface, 3mm)" and
// "Hollowed (outer surface, 2mm)", or "Refined Class 1" and "Refined Class 2", are two lines.
const editOperation = (detail: string) =>
	detail
		.replace(/\s*\([^()]*\bvox(?:el)?s?\)\s*$/i, "")
		.replace(/:\s*[\d.,]+\s*vox(?:el)?s?\s*$/i, "")
		.replace(/[\d.,]+(?=\s*(?:mm|slices?)\b)/g, "#")
		.trim();

export class ReadingSession {
	readonly caseId: string;
	// Re-zeroed in start() once the recorder runs, so the clock matches the audio.
	startedAt = Date.now();
	events: SessionEvent[] = [];
	shots: SessionShot[] = [];
	transcript: TranscriptSegment[] = [];
	micGranted = false;
	/** Set when the recorder's input ends by itself while the session runs; the clock time of the dropout. */
	micLostAtMs: number | null = null;

	private stream: MediaStream | null = null;
	private recorder: MediaRecorder | null = null;
	private chunks: BlobPart[] = [];
	private audioMime = "";
	private recognition: SpeechRecognitionLike | null = null;
	private stopped = false;
	/** Clock time of the Stop click; narration the engine delivers afterwards is stamped no later than this. */
	private stoppedAtMs: number | null = null;
	/** Resolves stop()'s wait for the speech engine to hand over its last result. */
	private dictationEnded: (() => void) | null = null;
	private dictationClosed = false;
	private restartTimer: number | null = null;

	private constructor(caseId: string) {
		this.caseId = caseId;
	}

	static async start(caseId: string): Promise<ReadingSession> {
		const session = new ReadingSession(caseId);
		await session.initAudio();
		// The browser's microphone prompt can sit open for a while; count from the
		// moment the recorder started, so every timestamp lines up with the audio.
		session.startedAt = Date.now();
		session.initDictation();
		return session;
	}

	/** True while the browser's speech service is transcribing the narration (false once it has failed or given up). */
	get dictating(): boolean {
		return this.recognition != null;
	}

	/** True once the microphone stopped by itself, so narration after that point is not recorded. */
	get micLost(): boolean {
		return this.micLostAtMs != null;
	}

	get elapsedMs(): number {
		return Date.now() - this.startedAt;
	}

	/**
	 * Append a timeline event. With coalesceMs > 0, a burst of same-type events
	 * (slice scrubbing, slider drags) collapses into one line that keeps the
	 * latest detail, instead of flooding the timeline. Edits only merge with the
	 * same operation, so a delete followed by a smooth keeps both lines.
	 */
	log(type: string, detail: string, coalesceMs = 0) {
		if (this.stopped) return;
		const t = this.elapsedMs;
		const last = this.events[this.events.length - 1];
		if (
			coalesceMs > 0 &&
			last &&
			last.type === type &&
			t - last.t < coalesceMs &&
			(type !== "edit" || editOperation(last.detail) === editOperation(detail))
		) {
			last.detail = detail;
			last.t = t;
			return;
		}
		this.events.push({ t, type, detail });
	}

	addShot(label: string, images: SessionShotImage[]) {
		if (this.stopped || !images.length) return;
		this.shots.push({ t: this.elapsedMs, label, images });
	}

	async stop(): Promise<SessionResult> {
		this.stopped = true;
		const stoppedAtMs = (this.stoppedAtMs = this.elapsedMs);
		if (this.restartTimer != null) window.clearTimeout(this.restartTimer);
		this.restartTimer = null;
		const recognition = this.recognition;
		this.recognition = null;
		if (recognition) {
			// stop() ends the run, and the last final result arrives just before onend.
			await new Promise<void>((resolve) => {
				const timer = window.setTimeout(resolve, DICTATION_FLUSH_TIMEOUT_MS);
				this.dictationEnded = () => {
					window.clearTimeout(timer);
					resolve();
				};
				try {
					recognition.stop();
				} catch {
					/* recognition may already be stopped */
					this.dictationEnded();
				}
			});
		}
		this.dictationEnded = null;
		this.dictationClosed = true;

		let audio: Blob | null = null;
		if (this.recorder && this.recorder.state !== "inactive") {
			const recorder = this.recorder;
			await new Promise<void>((resolve) => {
				recorder.onstop = () => resolve();
				try {
					recorder.stop();
				} catch {
					resolve();
				}
			});
		}
		if (this.chunks.length) {
			audio = new Blob(this.chunks, { type: this.audioMime || "audio/webm" });
		}
		this.stream?.getTracks().forEach((track) => track.stop());
		this.stream = null;
		this.recorder = null;

		return {
			caseId: this.caseId,
			startedAt: this.startedAt,
			durationMs: stoppedAtMs,
			events: this.events,
			shots: this.shots,
			transcript: [...this.transcript],
			audio,
			audioExt: this.audioMime.includes("mp4") ? "mp4" : "webm",
			micGranted: this.micGranted,
			micLostAtMs: this.micLostAtMs,
		};
	}

	private async initAudio() {
		try {
			if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;
			const request = navigator.mediaDevices.getUserMedia({ audio: true });
			let timer: number | undefined;
			const stream = await Promise.race([
				request,
				new Promise<null>((resolve) => {
					timer = window.setTimeout(() => resolve(null), MIC_PROMPT_TIMEOUT_MS);
				}),
			]).finally(() => window.clearTimeout(timer));
			if (!stream) {
				// No answer in time: a stream that arrives later is released at once.
				request.then(
					(late) => late.getTracks().forEach((track) => track.stop()),
					() => {}
				);
				return;
			}
			this.stream = stream;
			const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
				MediaRecorder.isTypeSupported?.(m)
			);
			this.recorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
			this.audioMime = this.recorder.mimeType || mime || "audio/webm";
			this.recorder.ondataavailable = (e) => {
				if (e.data && e.data.size > 0) this.chunks.push(e.data);
			};
			// A headset that sleeps, a mic that is unplugged or a permission switched off
			// ends the track and the recorder with it, with no call from stop().
			this.recorder.onerror = this.recorder.onstop = () => this.noteMicLost();
			this.stream.getTracks().forEach((track) => {
				track.onended = () => this.noteMicLost();
			});
			this.recorder.start(1000);
			this.micGranted = true;
		} catch {
			// Mic denied/unavailable — record an events-only session.
			this.stream?.getTracks().forEach((track) => track.stop());
			this.stream = null;
			this.micGranted = false;
		}
	}

	private noteMicLost() {
		if (this.stopped || this.micLostAtMs != null) return;
		this.micLostAtMs = this.elapsedMs;
		this.log("session", "The microphone stopped, so narration is no longer recorded");
	}

	private initDictation() {
		if (!this.micGranted) return;
		const w = window as unknown as {
			SpeechRecognition?: new () => SpeechRecognitionLike;
			webkitSpeechRecognition?: new () => SpeechRecognitionLike;
		};
		const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
		if (!SR) return;
		try {
			const rec = new SR();
			rec.continuous = true;
			rec.interimResults = false;
			rec.lang = navigator.language || "en-US";
			rec.onresult = (e) => {
				if (this.dictationClosed) return;
				// A sentence that lands after Stop belongs to the reading, not to the time after it.
				const t = Math.min(this.elapsedMs, this.stoppedAtMs ?? Infinity);
				for (let i = e.resultIndex; i < e.results.length; i++) {
					const r = e.results[i];
					const text = r?.[0]?.transcript?.trim();
					if (r?.isFinal && text) this.transcript.push({ t, text });
				}
			};
			// The engine stops itself after silence; keep it running for the session.
			// An engine that is blocked or offline ends again at once, so a fatal
			// error stops the restarts, and so do three instant endings in a row.
			let fatal = false;
			let instantEnds = 0;
			let startedAt = 0;
			const start = () => {
				startedAt = Date.now();
				rec.start();
			};
			rec.onend = () => {
				if (this.stopped) this.dictationEnded?.();
				if (this.stopped || fatal) return;
				instantEnds = Date.now() - startedAt < 1000 ? instantEnds + 1 : 0;
				if (instantEnds >= 3) {
					this.recognition = null;
					return;
				}
				this.restartTimer = window.setTimeout(() => {
					this.restartTimer = null;
					if (this.stopped) return;
					try {
						start();
					} catch {
						/* restart raced with a manual stop */
					}
				}, 300);
			};
			rec.onerror = (e) => {
				// Fail soft: audio recording still runs without a transcript.
				if (e?.error && FATAL_SPEECH_ERRORS.includes(e.error)) {
					fatal = true;
					this.recognition = null;
				}
			};
			start();
			this.recognition = rec;
		} catch {
			this.recognition = null;
		}
	}
}

export function downloadBlob(blob: Blob, filename: string) {
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	document.body.removeChild(link);
	URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string, mime = "text/plain") {
	downloadBlob(new Blob([text], { type: `${mime};charset=utf-8` }), filename);
}

// Stitch per-pane screenshots into one image (for the toolbar snapshot button
// outside of a session, where one file beats three separate downloads).
export async function composeImagesSideBySide(images: SessionShotImage[]): Promise<string | null> {
	const loaded = await Promise.all(
		images.map(
			(im) =>
				new Promise<HTMLImageElement | null>((resolve) => {
					const img = new Image();
					img.onload = () => resolve(img);
					img.onerror = () => resolve(null);
					img.src = im.dataUrl;
				})
		)
	);
	const valid = loaded.filter((img): img is HTMLImageElement => !!img && img.width > 0);
	if (!valid.length) return null;
	const height = Math.max(...valid.map((img) => img.height));
	const gap = 4;
	const width = valid.reduce((w, img) => w + img.width, 0) + gap * (valid.length - 1);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) return null;
	ctx.fillStyle = "#000";
	ctx.fillRect(0, 0, width, height);
	let x = 0;
	for (const img of valid) {
		ctx.drawImage(img, x, 0);
		x += img.width + gap;
	}
	return canvas.toDataURL("image/png");
}

const dataUrlBase64 = (dataUrl: string) => dataUrl.slice(dataUrl.indexOf(",") + 1);

/**
 * Bundle everything from the session into one zip: the narration audio, the
 * machine-readable event timeline, every screenshot, and the draft report
 * (markdown + self-contained HTML). jszip is imported lazily so the viewer
 * bundle doesn't pay for it unless a bundle is actually downloaded.
 */
export async function buildSessionBundle(
	result: SessionResult,
	measurements: ReportMeasurement[]
): Promise<Blob> {
	const { default: JSZip } = await import("jszip");
	const zip = new JSZip();

	const reportInput = {
		caseId: result.caseId,
		startedAt: result.startedAt,
		durationMs: result.durationMs,
		events: result.events,
		shots: result.shots,
		transcript: result.transcript,
		measurements,
		hasAudio: result.audio != null,
	};
	zip.file("report.md", buildReportMarkdown(reportInput));
	zip.file("report.html", buildReportHtml(reportInput));
	zip.file(
		"events.json",
		JSON.stringify(
			{
				caseId: result.caseId,
				startedAt: new Date(result.startedAt).toISOString(),
				durationMs: result.durationMs,
				micGranted: result.micGranted,
				events: result.events,
				transcript: result.transcript,
				measurements,
				screenshots: result.shots.map((s, si) => ({
					t: s.t,
					label: s.label,
					files: s.images.map((im) => shotFileName(si, s, im)),
				})),
			},
			null,
			2
		)
	);
	if (result.audio) zip.file(`narration.${result.audioExt}`, result.audio);
	for (const [si, shot] of result.shots.entries()) {
		for (const im of shot.images) {
			zip.file(`screenshots/${shotFileName(si, shot, im)}`, dataUrlBase64(im.dataUrl), { base64: true });
		}
	}
	return zip.generateAsync({ type: "blob" });
}

// The shot number keeps two captures from the same second apart in the zip.
function shotFileName(index: number, shot: SessionShot, im: SessionShotImage): string {
	const clock = formatClock(shot.t).replace(/:/g, "m") + "s";
	const slug = shot.label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${String(index + 1).padStart(2, "0")}_${clock}_${slug || "shot"}_${im.name}.png`;
}
