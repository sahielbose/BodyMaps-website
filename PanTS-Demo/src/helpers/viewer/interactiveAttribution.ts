// helpers/viewer/interactiveAttribution.ts
//
// The licence line shown wherever the interactive model is offered (tool
// tooltips, the first-use hint modal). The weights licence is asserted by
// the RUNNING model server — its /capabilities response carries "license",
// proxied by the backend at /api/interactive-capabilities — because a future
// checkpoint could ship different terms, and a string hardcoded in the
// viewer would silently misattribute it. The fallback matches today's
// released weights and is what renders until (or unless) the fetch answers.
//
// The same response says what the loaded checkpoint can do (which prompt
// types, whether it refines a label with no prompt), so the toolbar offers
// exactly that. Every field is optional: until the server answers, or for a
// field it doesn't report, the viewer keeps offering the tool.
import { useSyncExternalStore } from "react";
import { API_BASE } from "../constants";

const FALLBACK_LICENSE = "CC BY-NC-SA 4.0";

export interface InteractiveCapabilities {
	/** false only when the server says the checkpoint lacks that prompt type. */
	interactions: { point: boolean | null; box: boolean | null; scribble: boolean | null; lasso: boolean | null } | null;
	/** Zero-shot label refinement (the Refine tool). */
	refine: boolean | null;
	undo: boolean | null;
}

let serverLicense: string | null = null;
let serverCaps: InteractiveCapabilities | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function flag(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function parseCapabilities(body: Record<string, unknown>): InteractiveCapabilities | null {
	if (body.available !== true) return null;
	const raw = body.interactions;
	const interactions =
		raw && typeof raw === "object"
			? {
					point: flag((raw as Record<string, unknown>).point),
					box: flag((raw as Record<string, unknown>).box),
					scribble: flag((raw as Record<string, unknown>).scribble),
					lasso: flag((raw as Record<string, unknown>).lasso),
				}
			: null;
	return { interactions, refine: flag(body.refine), undo: flag(body.undo) };
}

/** What the running model server reported, or null before it answers. */
export function interactiveCapabilities(): InteractiveCapabilities | null {
	return serverCaps;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Whether the toolbar should offer the model tool `toolId`. A tool is hidden
 *  only when the server says the checkpoint can't serve it, so the toolbar is
 *  unchanged until it answers, and for anything it doesn't report. */
export function modelToolOffered(toolId: string, caps: InteractiveCapabilities | null): boolean {
	if (!caps) return true;
	switch (toolId) {
		case "pointSegment": return caps.interactions?.point !== false;
		case "boxSegment": return caps.interactions?.box !== false;
		case "scribbleSegment": return caps.interactions?.scribble !== false;
		case "lassoSegment": return caps.interactions?.lasso !== false;
		case "refineSegment": return caps.refine !== false;
		default: return true;
	}
}

/** interactiveCapabilities() as React state: re-renders once the fetch
 *  started by primeInteractiveLicense answers. */
export function useInteractiveCapabilities(): InteractiveCapabilities | null {
	return useSyncExternalStore(subscribe, interactiveCapabilities, interactiveCapabilities);
}

export function interactiveAttribution(): string {
	const license = serverLicense ?? FALLBACK_LICENSE;
	// The non-commercial clause is a property of the licence, not of the
	// model: spell it out only while the licence actually carries NC.
	const scope = /\bNC\b/.test(license) ? ", for non-commercial research use" : "";
	return `Powered by nnInteractive (DKFZ, Isensee et al. 2025). Model weights are ${license}${scope}.`;
}

/** Fire-and-forget fetch of the live licence string. Cheap to call from any
 *  mount point that renders the attribution; only the first call fetches. */
export function primeInteractiveLicense(apiBase: string = API_BASE): void {
	if (serverLicense !== null || inflight) return;
	if (typeof fetch !== "function") return;
	inflight = fetch(`${apiBase}/api/interactive-capabilities`)
		.then(async (resp) => {
			if (!resp.ok) return;
			const body = await resp.json().catch(() => null);
			if (!body || typeof body !== "object") return;
			const license = typeof body.license === "string" ? body.license.trim() : "";
			if (license) serverLicense = license;
			const caps = parseCapabilities(body as Record<string, unknown>);
			if (caps) {
				serverCaps = caps;
				listeners.forEach((listener) => listener());
			}
		})
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
}

export function _resetInteractiveLicenseForTests(): void {
	serverLicense = null;
	serverCaps = null;
	inflight = null;
}
