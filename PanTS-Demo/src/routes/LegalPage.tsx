import React from "react";
import { Link } from "react-router-dom";
import Header from "../components/Header";
import SiteFooter from "../components/SiteFooter";
import { CONTACT_PATH } from "../helpers/copy";
import "./LegalPage.css";

// Terms of Service and Privacy Notice.
//
// Provisional text: written in plain English to describe what the service
// actually does today, pending institutional review. When the wording changes
// materially, bump the date shown under the title. Do not describe behaviour
// (scheduled deletion, export, verification) that is not running in production.

// Section text is plain except for links written [label](target): "contact"
// is the site's contact page, a path such as /terms is any other page.
type Section = { heading: string; body: string };

const LINK_TOKEN = /\[([^\]]+)\]\(([^)]+)\)/g;

// Hyphenated words up to a line-friendly length ("de-identified", "need-to-know",
// "scan-contribution") are kept whole: the browser would otherwise break them
// at the hyphen and strand a half-word at the end of a line. Longer runs
// ("email-and-password", "intellectual-property") may break after a hyphen,
// since an unbreakable long run leaves a hole at the end of the previous line
// on a phone.
const COMPOUND = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g;
const MAX_COMPOUND_LENGTH = 17;

/** Plain text with each hyphenated compound kept on one line. */
const keepCompounds = (text: string, key: number): React.ReactNode[] => {
	const nodes: React.ReactNode[] = [];
	let from = 0;
	for (const m of text.matchAll(COMPOUND)) {
		if (m[0].length > MAX_COMPOUND_LENGTH) continue;
		nodes.push(text.slice(from, m.index));
		nodes.push(
			<span key={`${key}-${m.index}`} className="legal-compound">
				{m[0]}
			</span>,
		);
		from = m.index + m[0].length;
	}
	nodes.push(text.slice(from));
	return nodes;
};

/** Plain text with each [label](target) token drawn as a link. */
const withLinks = (text: string): React.ReactNode[] => {
	const nodes: React.ReactNode[] = [];
	let from = 0;
	for (const m of text.matchAll(LINK_TOKEN)) {
		nodes.push(...keepCompounds(text.slice(from, m.index), from));
		nodes.push(
			m[2] === "contact" ? (
				<Link key={m.index} to={CONTACT_PATH}>
					{m[1]}
				</Link>
			) : (
				<Link key={m.index} to={m[2]}>
					{m[1]}
				</Link>
			),
		);
		from = m.index + m[0].length;
	}
	nodes.push(...keepCompounds(text.slice(from), from));
	return nodes;
};

const TERMS_INTRO =
	'These Terms of Service ("Terms") are an agreement between you and the BodyMaps program that operates this site ("BodyMaps", "we", "us"). "BodyMaps" names this site and service. BodyMaps, Inc. is a separate company that contributed to the website and receives and routes inquiries for us; it does not operate this site and cannot make commitments on our behalf. By creating an account, uploading, or otherwise using BodyMaps, you agree to these Terms and acknowledge the [Privacy Notice](/privacy). If you do not agree, do not use the service.';

const TERMS: Section[] = [
	{
		heading: "Nonclinical use only",
		body: "BodyMaps may be used for commercial or noncommercial research, education, software and dataset development, evaluation, and other nonclinical purposes. It is not medical advice and must not be used to diagnose, screen for, detect, stage, treat, prevent, or monitor disease; to give patient-specific guidance; to prepare a clinical report; or to make any decision about patient care. Segmentations, measurements, labels, summaries, and assistant responses are experimental model outputs: they may be wrong or incomplete, have not been reviewed by a radiologist, and have not been cleared or approved by any medical device regulator. Do not rely on BodyMaps in an emergency.",
	},
	{
		heading: "Accounts",
		body: "You must be at least 18 years old to create, own, or use an account. A person aged 13 to 17 may use BodyMaps only through an adult's account, under that adult's direct supervision and with a guardian's permission; do not share credentials with a minor. Keep your account information accurate and your credentials secure. You are responsible for activity under your account and must tell us promptly about suspected unauthorized access. Do not share, sell, or automate access, evade quotas, or impersonate anyone. We may limit, suspend, or close an account that breaks these Terms or creates security or legal risk. If you delete your account, it is deactivated and can be restored by signing in within 30 days.",
	},
	{
		heading: "What you upload",
		body: "Files opened in View only mode stay in your browser. If you run a model or other server-side processing, your scan and its results are transferred to and stored on our servers, where authorized staff can access them when reasonably necessary to operate, secure, support, or debug the service or to enforce these Terms. Do not upload protected health information or identifiable patient data: remove identifiers from headers, filenames, and image pixels before uploading, and upload only scans you have the right and authority to submit. We do not offer a Business Associate Agreement. A share link is not access control; anyone with the link can open it. Keep your own copies. We do not guarantee that uploads or outputs are preserved.",
	},
	{
		heading: "Rights in uploads and annotations",
		body: "You keep your rights in the scans you upload. As a condition of free server-side processing, you grant BodyMaps a nonexclusive, perpetual, irrevocable, worldwide, royalty-free, transferable, and sublicensable license to use a qualifying scan contribution, meaning an upload that has been de-identified and separated from your account and source files, for research, model training, evaluation, publication, redistribution, commercialization, and other lawful purposes. A prohibited or identifiable upload is not a qualifying contribution and may be quarantined or deleted. Annotations and masks you create are yours to use, including commercially; we receive only the rights needed to process, store, and deliver them to you. If you do not accept this license, do not use server-side processing; you may ask about alternative terms through the [contact form](contact).",
	},
	{
		heading: "Plans and donations",
		body: 'Access is subject to the plan quotas and feature limits shown in your account. We do not collect payments today. Tiers marked "Coming soon" are informational descriptions of possible future offerings, not current offers or promises of access, and they may change or never launch. We may grant, change, or withdraw plan access and revise limits or features. A donation, if we ever accept one, does not buy ownership of or rights to any dataset, model, software, or output.',
	},
	{
		heading: "Acceptable use",
		body: "Use BodyMaps only for lawful nonclinical purposes and in line with the licenses that apply to the datasets, models, software, and outputs you use. You must not use the service or its outputs for patient care or clinical decisions; upload material without the rights or consent you need; upload protected health information or identifiable patient data; attempt to identify or re-identify any person; infringe privacy or intellectual-property rights; probe or bypass security or access controls; introduce malicious code; scrape in bulk outside an authorized feature; evade limits; or resell access. We may investigate suspected misuse and restrict access to protect users, systems, or legal rights. To the fullest extent permitted by law, you will defend, indemnify, and hold harmless BodyMaps, its staff and contributors, and BodyMaps, Inc. from third-party claims arising from your uploads, prohibited data, missing rights or consent, attempted re-identification, prohibited use, or breach of these Terms.",
	},
	{
		heading: "Availability and liability",
		body: 'BodyMaps is provided "as is" and "as available", without any promise that it will be accurate, secure, uninterrupted, or error-free, or that uploads or outputs will be preserved. We may change or discontinue features, models, datasets, and limits without notice. To the fullest extent permitted by law, BodyMaps, its staff and contributors, and BodyMaps, Inc. disclaim all warranties and are not liable for indirect, incidental, special, consequential, exemplary, or punitive damages, including lost data, research, revenue, or goodwill, or for harm from reliance on an output or from unauthorized access. Where liability cannot be excluded, our total liability is capped at the greater of USD 100 or the amount you paid us in the preceding 12 months. Nothing in these Terms limits rights or obligations that cannot lawfully be limited.',
	},
	{
		heading: "Where the service is operated",
		body: "BodyMaps is operated from the United States and primarily serves the U.S. research community, but permitted users elsewhere may use it. If you use BodyMaps from outside the United States, you do so on your own initiative and are responsible for making sure that your access, uploads, and use comply with the laws that apply to you and your data. We do not represent that BodyMaps is appropriate or lawful in every jurisdiction and may restrict access where necessary. Personal and technical data are handled as described in the [Privacy Notice](/privacy).",
	},
	{
		heading: "Changes to these Terms",
		body: "We may update these Terms as the service changes; the revised version will show a new date at the top of this page. Changes apply from that date, and continued use after it means you accept them to the extent permitted by law. If you do not accept a change, stop using the service. If any provision is unenforceable, the rest remains in effect. These Terms are governed by the laws of the State of Maryland, USA, without regard to its conflict-of-law rules.",
	},
];

const PRIVACY_INTRO =
	'This notice explains what BodyMaps collects when you use this site, how it is used, and the choices you have. "We" means the BodyMaps program that operates the site. BodyMaps, Inc. is a separate company that contributed to the website and receives and routes inquiries for us; it does not operate the site.';

const PRIVACY: Section[] = [
	{
		heading: "What we collect",
		body: "Account information: your email address, the name you choose, an optional self-reported role, your plan, whether your email is verified, and account and session identifiers. For email-and-password accounts we store a password hash, not the password. If you sign in with Google or GitHub, we receive your email address, the provider's name and account identifier, and its verification status. Uploads and outputs: CT scans you send for server-side processing and the masks, measurements, and summaries derived from them; files opened in View only mode stay in your browser. Signed-in sessions use one HTTP-only cookie (bm_session). Site analytics are described below.",
	},
	{
		heading: "Protected health information",
		body: "BodyMaps is not designed to receive protected health information or identifiable patient data, and we do not offer a Business Associate Agreement. Do not upload identifiable scans. Before uploading, remove identifiers from image headers, filenames, and burned-in pixels, and make sure you have permission to use and upload the scan. The service does not de-identify files for you and does not check them for identifiers. An identifiable upload may be quarantined or deleted and is not eligible for reuse under the scan-contribution license in the [Terms](/terms).",
	},
	{
		heading: "How we use it",
		body: "We use account and session data to sign you in, apply plan limits, secure accounts, and operate the service. We use uploads and outputs to display images and perform the processing, annotation, and summaries you request. Authorized staff may access uploads and account data on a need-to-know basis to operate, secure, support, or debug the service or to enforce the [Terms](/terms). Uploads that qualify as de-identified scan contributions may be used, after they are separated from your account, under the license in the [Terms](/terms) for research, model training, evaluation, publication, redistribution, and commercialization. We use technical logs and analytics to run, diagnose, and understand use of the service.",
	},
	{
		heading: "Site analytics, IP addresses and location",
		body: "We record pages visited, named feature actions, time on page, plan and optional account type, the IP address of each request, the approximate country, region, and city derived from it, and device type. Location is computed on our own server from a local database; your IP address is not sent to a third party for this. When you are signed in these records are linked to your account; otherwise they are linked to a persistent browser identifier and a session identifier, so they are not anonymous. We will not use IP addresses, analytics events, browser identifiers, or derived location to discover, verify, or re-identify anyone's real-world identity. Only site administrators can view these records. They are not yet deleted on a fixed schedule; we are implementing one (IP-bearing security logs kept up to 30 days; account- or browser-linked events up to 90 days, then de-identified aggregates only) and will update this notice when it is running. No third-party analytics or advertising scripts run on this site.",
	},
	{
		heading: "Retention and deletion",
		body: "Uploads and outputs are currently kept without a fixed retention period. Clearing your scan history removes the jobs shown to you and the working files and masks we can associate with them; it does not remove a qualifying de-identified scan contribution, and copies may persist for a time in backups or logs. Deleting your account signs you out, deactivates it, and schedules the account and its data for removal after a 30-day grace period during which signing in restores everything; we do not guarantee removal on a specific day. Live room files are designed to expire after 24 hours. We do not currently promise automated deletion on any schedule and will update this notice when scheduled deletion is running.",
	},
	{
		heading: "Sharing",
		body: "We do not sell account data, uploads, or outputs. Anyone who has a share link or live room link can open its content. Google Fonts may load on some pages, and some viewer paths fetch public dataset assets from Hugging Face. Google or GitHub processes your sign-in when you choose them. Password-reset email is sent through an email provider. BodyMaps, Inc. receives and routes inquiries and requests sent through the [contact form](contact), which delivers them through Formspree. No third-party analytics or advertising trackers run on this site.",
	},
	{
		heading: "Your rights",
		body: "In Settings you can download a copy of your account details, change your display name and optional role, and use the scan-history and account-deletion controls described above. To request access to, correction of, or deletion of your personal data, to withdraw consent where it applies, to request a portable copy, or to appeal a decision, use the [contact form](contact); do not include protected health information or scans. We will verify you by sending a link or code to the email registered to your account and will respond within 45 days, with one extension where the law allows and with notice to you. BodyMaps, Inc. receives and routes these requests; BodyMaps decides and responds.",
	},
];

/** Shown under the title until the reviewed version is published. */
const LAST_UPDATED = "Last updated 2026-08-29";

const LegalPage: React.FC<{ kind: "terms" | "privacy" }> = ({ kind }) => {
	const isTerms = kind === "terms";
	const sections = isTerms ? TERMS : PRIVACY;

	return (
		<div className="legal-wrapper">
			<Header />

			<main className="legal-main">
				<h1 className="legal-title">{isTerms ? "Terms of Service" : "Privacy Notice"}</h1>

				<p className="legal-status" role="note">
					{isTerms ? "Provisional terms, under review." : "Provisional privacy notice, under review."}{" "}
					<span className="legal-updated">{LAST_UPDATED}</span>
				</p>

				<p className="legal-intro">{withLinks(isTerms ? TERMS_INTRO : PRIVACY_INTRO)}</p>

				{sections.map((s) => (
					<section key={s.heading} className="legal-section">
						<h2 className="legal-heading">{s.heading}</h2>
						<p className="legal-body">{withLinks(s.body)}</p>
					</section>
				))}

				<p className="legal-footer">
					Questions or feedback? Use the <Link to={CONTACT_PATH}>contact form</Link>. Do not include
					protected health information.
				</p>
			</main>

			<SiteFooter />
		</div>
	);
};

export default LegalPage;
