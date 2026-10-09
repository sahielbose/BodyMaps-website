import { useEffect, useRef, useState } from "react";
import { ActionButton, ActionList, MenuDivider } from "../viewer/FlyoutPrimitives";
import type { InteractivePromptResult } from "../../helpers/CornerstoneNifti2";
import { PROMPT_TIMEOUT_MS } from "../../helpers/viewer/useInteractivePromptTool";
import { voxelsLog } from "../../helpers/viewer/editLog";

interface Props {
	/** Name of the class being refined, for the button label. */
	classLabel: string;
	/** Runs the refinement and applies it (refineClassWithModel). Aborting the
	 *  signal (Cancel, the deadline, or the flyout closing) stops the request. */
	refine: (signal: AbortSignal) => Promise<InteractivePromptResult>;
	onLog?: (detail: string) => void;
	/** Called after a successful refine: closes this flyout and deselects the tool. */
	onApplied?: () => void;
}

// Messages the client itself throws (or VisualizationPage rejects with) that
// already read as plain advice, plus the server's own plain refusals, which
// say why a second try would not help. Anything else (the browser's fetch
// failure text, whatever else the server put in an error body) stays in the
// console.
const FRIENDLY_ERRORS = new Set([
	"Pick a class to refine first.",
	"This class has no voxels to refine yet. Draw or segment it first.",
	"No segmentation loaded for this case.",
	"CT not found for this case on the server.",
	"Segmenting with the model works on cases from the dataset. It can't read an uploaded scan yet.",
	"The model found nothing to keep in this class, so it was left as it was.",
	"This model checkpoint can't refine a label on its own.",
	"The segmentation model is busy with other annotations right now. Try again in a moment.",
]);

function refineErrorMessage(e: unknown): string {
	if (e instanceof TypeError) return "Could not reach the model server. Check your connection and try again.";
	if (e instanceof Error && FRIENDLY_ERRORS.has(e.message)) return e.message;
	return "Refining failed. Try again.";
}

// One-shot action like Smoothing or Hollow: an explanation, then one button.
// The difference is that this one waits on the model server (a few seconds
// on a GPU, up to about a minute on a laptop), so the button stays busy for
// the real round trip, and a failure stays on screen instead of closing.
export default function RefineFlyout({ classLabel, refine, onLog, onApplied }: Props) {
	const [running, setRunning] = useState(false);
	const [success, setSuccess] = useState(false);
	// Whether the last run changed any voxels, so the button doesn't claim
	// "Refined" when the model kept the outline as it was.
	const [changed, setChanged] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const mounted = useRef(true);
	// The refine in flight, and why it was stopped (if it was), so the catch
	// below can tell Cancel and the deadline from a real failure.
	const flightRef = useRef<{ controller: AbortController; stopped: "cancel" | "timeout" | null } | null>(null);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			// Closing the flyout ends the request too, so nothing keeps running
			// unseen and a reopened flyout can't start a second refine beside it.
			const flight = flightRef.current;
			if (flight && !flight.stopped) {
				flight.stopped = "cancel";
				flight.controller.abort();
			}
		};
	}, []);

	const cancel = () => {
		const flight = flightRef.current;
		if (!flight || flight.stopped) return;
		flight.stopped = "cancel";
		flight.controller.abort();
	};

	const run = async () => {
		if (running || success) return;
		setRunning(true);
		setError(null);
		const flight: { controller: AbortController; stopped: "cancel" | "timeout" | null } = { controller: new AbortController(), stopped: null };
		flightRef.current = flight;
		// A stalled model server otherwise holds the button on "Refining…" until
		// the backend's own timeout; past this the server is stuck, not slow.
		const deadline = window.setTimeout(() => {
			flight.stopped = "timeout";
			flight.controller.abort();
		}, PROMPT_TIMEOUT_MS);
		try {
			const r = await refine(flight.controller.signal);
			const touched = r.added + r.removed;
			// Only a real edit goes in the session log; a refine that left the
			// outline alone changed nothing to report.
			if (touched > 0) onLog?.(`Refined ${classLabel} (${voxelsLog(touched)})`);
			if (!mounted.current) return;
			setRunning(false);
			setChanged(touched > 0);
			setSuccess(true);
			window.setTimeout(() => {
				if (!mounted.current) return;
				setSuccess(false);
				onApplied?.();
			}, 650);
		} catch (e) {
			if (flight.stopped) {
				// Nothing was applied. A cancel just goes back to the idle button.
				if (!mounted.current) return;
				setRunning(false);
				if (flight.stopped === "timeout") {
					setError(`The model took longer than ${PROMPT_TIMEOUT_MS / 60000} minutes, so refining was stopped and nothing was changed. Try again in a moment.`);
				}
				return;
			}
			console.error("Refine failed", e);
			if (!mounted.current) return;
			setRunning(false);
			setError(refineErrorMessage(e));
		} finally {
			window.clearTimeout(deadline);
			if (flightRef.current === flight) flightRef.current = null;
		}
	};

	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
			<p className="atb-flyout-note">
				The model redraws this class's outline from its current voxels, with no clicks needed. It helps most on rough or blocky masks. It only grows into unlabeled voxels, and Undo reverses it.
			</p>
			{error && (
				<p className="atb-flyout-note atb-flyout-note--error" role="alert">
					{error}
				</p>
			)}
			<MenuDivider />
			<ActionList>
				<ActionButton
					label={`Refine ${classLabel}`}
					runningLabel="Refining…"
					busy={running}
					success={success}
					successLabel={changed ? "Refined" : "Already a good fit"}
					disabled={running || success}
					onClick={() => void run()}
				/>
				{running && <ActionButton label="Cancel" onClick={cancel} />}
			</ActionList>
		</div>
	);
}
