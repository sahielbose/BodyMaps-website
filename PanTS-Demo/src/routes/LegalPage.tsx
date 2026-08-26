import React from "react";
import { Link } from "react-router-dom";
import Header from "../components/Header";
import SiteFooter from "../components/SiteFooter";
import "./LegalPage.css";

// Terms of Service and Privacy Policy.
//
// PLACEHOLDER — this is not legal copy and must be replaced before launch.
// BodyMaps accepts uploaded medical imaging, which means the real versions have
// to be written or reviewed by a lawyer: PHI handling, HIPAA/BAA obligations
// when a clinician uploads a patient's scan, research-use limitations, and
// data-retention commitments are all jurisdiction-specific and none of them can
// be guessed at. The headings below are the sections that will need real text.

type Section = { heading: string; body: string };

const TERMS: Section[] = [
	{
		heading: "Research use only",
		body: "BodyMaps is research software. Segmentations, measurements, and reports it produces are not a diagnosis and are not a substitute for the judgment of a qualified clinician. It has not been cleared or approved by any medical device regulator.",
	},
	{
		heading: "Accounts",
		body: "What you are responsible for as an account holder, what we may do with an account that is misused, and how an account can be closed by either side.",
	},
	{
		heading: "What you upload",
		body: "Who may upload imaging, what rights and permissions you are confirming you have when you upload it, and what we are permitted to do with it in order to run the service.",
	},
	{
		heading: "Plans and donations",
		body: "How plans, quotas, and any future donations work. Nothing is charged today and no donation amounts have been set.",
	},
	{
		heading: "Acceptable use",
		body: "What the service may not be used for, including any use as the basis of a clinical decision.",
	},
	{
		heading: "Availability and liability",
		body: "What we do and do not commit to regarding uptime, data durability, and the limits of our liability.",
	},
];

const PRIVACY: Section[] = [
	{
		heading: "What we collect",
		body: "Account details, uploaded imaging and the results derived from it, and the technical logs needed to operate and debug the service.",
	},
	{
		heading: "Protected health information",
		body: "How imaging that may constitute PHI is handled, who can access it, and the circumstances under which a Business Associate Agreement is required. This section in particular needs legal review.",
	},
	{
		heading: "How we use it",
		body: "Running inference you request, operating and improving the service, and whether data is ever used for model training — and how you would opt out if so.",
	},
	{
		// Unlike its neighbours this one is not a placeholder: it describes what
		// the site actually does today. Recording visitors' IP addresses without
		// saying so anywhere is worse than a heading awaiting real legal copy.
		heading: "Site analytics, IP addresses and location",
		body: "We record which features are used and which pages are visited, along with the IP address each request came from, the approximate country and city that address resolves to, and whether the device is a desktop, tablet or phone. Location is worked out on our own servers from a local database — your IP address is not sent to any third party for this. These records are visible only to site administrators, are never used to identify you personally, and are deleted automatically after the retention period. No third-party analytics or advertising scripts run on this site.",
	},
	{
		heading: "Retention and deletion",
		body: "How long scans and results are kept, what deleting your history removes, and what happens to your data when you delete your account.",
	},
	{
		heading: "Sharing",
		body: "Third parties involved in operating the service, and the commitment that data is not sold.",
	},
	{
		heading: "Your rights",
		body: "How to export your data, correct it, or have it deleted, and how to contact us to do so.",
	},
];

const LegalPage: React.FC<{ kind: "terms" | "privacy" }> = ({ kind }) => {
	const isTerms = kind === "terms";
	const sections = isTerms ? TERMS : PRIVACY;

	return (
		<div className="legal-wrapper">
			<Header />

			<main className="legal-main">
				<h1 className="legal-title">{isTerms ? "Terms of Service" : "Privacy Policy"}</h1>

				<div className="legal-banner" role="note">
					<strong>Draft placeholder — not yet in force.</strong> This page outlines the
					sections the final {isTerms ? "terms" : "policy"} will cover. It has not been
					written or reviewed by a lawyer and creates no agreement between you and
					BodyMaps. Because the service handles medical imaging, the real text needs
					proper legal review before launch.
				</div>

				{sections.map((s) => (
					<section key={s.heading} className="legal-section">
						<h2 className="legal-heading">{s.heading}</h2>
						<p className="legal-body">{s.body}</p>
					</section>
				))}

				<p className="legal-footer">
					Questions in the meantime? Get in touch through the{" "}
					<Link to="/team">team page</Link>.
				</p>
			</main>

			<SiteFooter />
		</div>
	);
};

export default LegalPage;
