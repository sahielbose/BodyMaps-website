// helpers/viewer/interactiveAttribution.ts
//
// The licence line shown wherever the interactive model is offered (tool
// tooltips, the first-use hint modal). The weights licence is asserted by
// the RUNNING model server — its /capabilities response carries "license",
// proxied by the backend at /api/interactive-capabilities — because a future
// checkpoint could ship different terms, and a string hardcoded in the
// viewer would silently misattribute it. The fallback matches today's
// released weights and is what renders until (or unless) the fetch answers.
import { API_BASE } from "../constants";

const FALLBACK_LICENSE = "CC BY-NC-SA 4.0";

let serverLicense: string | null = null;
let inflight: Promise<void> | null = null;

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
			const license =
				body && typeof body.license === "string" ? body.license.trim() : "";
			if (license) serverLicense = license;
		})
		.catch(() => {})
		.finally(() => {
			inflight = null;
		});
}

export function _resetInteractiveLicenseForTests(): void {
	serverLicense = null;
	inflight = null;
}
