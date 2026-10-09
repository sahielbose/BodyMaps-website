// helpers/routeTitles.ts
//
// The document title for each route (see components/RouteTitle), so browser
// tabs, history, bookmarks and screen readers can tell pages apart.
import { SITE_TITLE } from "./copy";

const SUFFIX = " | BodyMaps";

// A stray "%" (a truncated copy-paste) makes decodeURIComponent throw, and the
// router still matches the route, so keep the raw text rather than losing the page.
function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

export function titleForPath(pathname: string): string {
	const path = pathname.replace(/\/+$/, "") || "/";
	const parts = path.split("/").filter(Boolean);
	// The router matches paths case-insensitively ("/Dashboard" renders the
	// Dataset page), so the route lookup must too. Only the case id keeps its case.
	const [rawFirst, rawSecond, rawThird] = parts;
	const first = rawFirst?.toLowerCase();
	const second = rawSecond?.toLowerCase();
	const third = rawThird?.toLowerCase();
	const named = (name: string) => `${name}${SUFFIX}`;
	const notFound = named("Page not found");
	// A title only when the path has the shape its route needs (see App.tsx):
	// "/case" or "/learn/anything" render the not-found page, so they must
	// not be titled as a case or a quiz.
	const shaped = (segments: number, name: string) => (parts.length === segments ? named(name) : notFound);
	switch (first) {
		case undefined:
			return SITE_TITLE;
		case "dashboard":
			return shaped(1, "Dataset");
		case "case":
			return shaped(2, `Case ${safeDecode(rawSecond ?? "")}`);
		case "session":
			return shaped(2, "Reading session");
		case "dicom":
		case "local-nifti":
			return shaped(1, "Local scan");
		case "reconstruction":
			return shaped(2, "Reconstruction");
		case "upload":
			return shaped(1, "Upload");
		case "reset-password":
			return shaped(1, "Reset password");
		case "login":
		case "signup":
			return shaped(1, "Sign in");
		case "verify-email":
			return shaped(1, "Verify email");
		case "account": {
			const section: Record<string, string> = {
				plan: "Plan",
				history: "History",
				privacy: "Privacy settings",
				analytics: "Usage",
				people: "People",
			};
			// "/account/foo" has no route and renders the not-found page.
			if (parts.length > 2) return notFound;
			if (!second) return named("Account");
			return Object.prototype.hasOwnProperty.call(section, second) ? named(section[second]) : notFound;
		}
		case "terms":
			return shaped(1, "Terms of Service");
		case "privacy":
			return shaped(1, "Privacy Notice");
		case "team":
			return shaped(1, "Team");
		case "compare":
			return shaped(1, "Compare cases");
		case "compare-viewer":
			return shaped(1, "Compare images");
		case "live":
			if (second === "challenge" && third) return shaped(3, "Challenge");
			return shaped(2, "Live room");
		case "learn":
			return second === "quiz" ? shaped(3, "Quiz practice") : notFound;
		case "share":
			return shaped(2, "Shared report");
		default:
			return notFound;
	}
}
