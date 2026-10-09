import { IconCheck } from "@tabler/icons-react";
import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/authContext";
import {
	canChangePlan,
	PLANS,
	planLabel,
	type PlanGroup,
	type PlanId,
} from "../../helpers/accountProfile";
import { track } from "../../helpers/analytics";
import { scrollBehavior } from "../../helpers/motion";
import { msUntil } from "../../helpers/resetTime";
import { useSettings } from "./context";

/** "in 6 hrs" / "in 24 min" from an ISO timestamp, or null once it's passed. */
const untilLabel = (iso: string | null): string | null => {
	if (!iso) return null;
	const mins = Math.round(msUntil(iso) / 60000);
	if (mins <= 0) return null;
	if (mins < 60) return `Resets in ${mins} min`;
	const hours = Math.round(mins / 60);
	return `Resets in ${hours} hr${hours === 1 ? "" : "s"}`;
};

const UsageBar: React.FC<{
	label: string;
	used: number;
	limit: number | null;
	resetsAt: string | null;
	/** What to say before the window has started (nothing used yet). */
	idleNote: string;
}> = ({ label, used, limit, resetsAt, idleNote }) => {
	const pct = limit === null ? 0 : Math.min(100, Math.round((used / limit) * 100));
	const spent = limit !== null && used >= limit;
	// resets_at is null until the first event lands, so an untouched allowance
	// would otherwise show a bare label with no hint of how the window works.
	// A window that has passed but not been re-read yet has just reset; the idle
	// note would claim the clock hasn't started while the bar still reads full.
	const reset =
		untilLabel(resetsAt) ??
		(limit === null ? null : resetsAt ? "Just reset" : idleNote);
	return (
		<div className="set-usage">
			<span className="set-usage-label">
				{label}
				{reset && <span className="set-usage-reset">{reset}</span>}
			</span>
			<div className="set-usage-track">
				<div
					className={`set-usage-fill${spent ? " set-usage-fill--full" : ""}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
			<span className="set-usage-count">
				{limit === null ? "Unlimited" : `${used} of ${limit}`}
			</span>
		</div>
	);
};

// Plan: what you're on, what you've used of it, and the picker.
//
// The picker is Claude's upgrade page — an Individual / Team and Enterprise
// segmented toggle over two cards each. Four plans side by side was the old
// version's mistake: nobody compares four columns of paragraphs.
//
// No payment: /me/plan is a column write. The limits are real either way.
//
// The paid plans aren't open yet, so their cards are greyed and their buttons
// say so. Admins are the exception at both ends: they can still move an account
// between plans, and their own limits are lifted whichever plan they sit on.
const PlanSettings: React.FC = () => {
	const { user, usage, usageFailed, setPlan, refreshUsage } = useAuth();
	const { busy, run, notify } = useSettings();
	const [group, setGroup] = useState<PlanGroup>("individual");
	// Set by the retry button, which is replaced by the bars when the read works.
	const usageHeading = useRef<HTMLHeadingElement>(null);
	const retryFocus = useRef(false);
	// A retry that fails sets usageFailed over true, so without these the row
	// looks the same before, during and after the press.
	const [retrying, setRetrying] = useState(false);
	const [retried, setRetried] = useState(false);
	useEffect(() => {
		if (usage) setRetried(false);
		if (retryFocus.current && usage) {
			retryFocus.current = false;
			// Only when focus fell with the retry row; a retry that failed earlier
			// must not pull focus from wherever the person is working now.
			const active = document.activeElement;
			if (!active || active === document.body) usageHeading.current?.focus();
		}
	}, [usage]);

	// The figures from sign-in go stale as soon as the assistant is used or a
	// window resets, so every visit to this page reads them again.
	useEffect(() => {
		refreshUsage();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// The "Resets in N min" labels are computed from the clock at render time, so
	// nothing would move them while the page sits open. Re-render every 30 s
	// while a window is running, and read the figures again once one has passed
	// (once per timestamp, so a server that keeps reporting it can't loop).
	const [, setTick] = useState(0);
	const refreshedFor = useRef<string | null>(null);
	const resetTimes = [usage?.scans.resets_at, usage?.ai_messages.resets_at];
	const running = resetTimes.filter((t): t is string => !!t);
	const runningKey = running.join("|");
	useEffect(() => {
		if (!runningKey) return;
		const id = window.setInterval(() => {
			setTick((n) => n + 1);
			const passed = runningKey.split("|").filter((t) => msUntil(t) <= 0).join("|");
			if (passed && refreshedFor.current !== passed) {
				refreshedFor.current = passed;
				refreshUsage();
			}
		}, 30000);
		return () => window.clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [runningKey]);

	if (!user) return null;

	// The effective plan: /me/usage reports the verified-researcher promotion,
	// which the stored column deliberately never records.
	const current = ((usage?.plan as PlanId | undefined) ?? user.plan);
	const currentPlan = PLANS.find((p) => p.id === current);
	const canChange = canChangePlan(user);

	const choose = (id: PlanId) =>
		run(async () => {
			track("account_change_plan");
			await setPlan(id);
			await refreshUsage();
			notify(`You're on ${planLabel(id)}.`);
		});

	return (
		<>
			<div className="set-group">
				<div className="set-plan-hero">
					<div>
						<h2 className="set-plan-name">{planLabel(current)} plan</h2>
						<p className="set-plan-blurb">
							{canChange
								? "Admin access: no limits apply, whatever plan you're on."
								: currentPlan?.blurb}
						</p>
					</div>
					<button
						type="button"
						className="set-btn"
						onClick={() =>
							document.getElementById("change-plan")?.scrollIntoView({ behavior: scrollBehavior() })
						}
					>
						Change plan
					</button>
				</div>
			</div>

			<div className="set-group">
				<h2 className="set-heading" ref={usageHeading} tabIndex={-1}>Usage</h2>
				<p className="set-sub">Rolling 24 hours.</p>
				{usage ? (
					<>
						<UsageBar
							label="Scans"
							used={usage.scans.used}
							limit={usage.scans.limit}
							resetsAt={usage.scans.resets_at}
							idleNote="Resets 24h after your first scan"
						/>
						<UsageBar
							label="Assistant messages"
							used={usage.ai_messages.used}
							limit={usage.ai_messages.limit}
							resetsAt={usage.ai_messages.resets_at}
							idleNote="Resets 24h after your first message"
						/>
					</>
				) : usageFailed ? (
					<div className="set-row">
						<span className="set-row-label" role="status">
							{retried && !retrying ? "Still can't load your usage." : "Couldn't load your usage."}
						</span>
						<button
							type="button"
							className="set-btn"
							aria-disabled={retrying}
							onClick={async () => {
								// aria-disabled keeps focus on the button, so a repeat press
								// has to be ignored here.
								if (retrying) return;
								// The row goes when the bars arrive, so focus follows to the heading.
								retryFocus.current = true;
								setRetrying(true);
								setRetried(true);
								try {
									await refreshUsage();
								} finally {
									setRetrying(false);
								}
							}}
						>
							{retrying ? "Trying again…" : "Try again"}
						</button>
					</div>
				) : (
					<p className="set-sub">Loading…</p>
				)}
			</div>

			<div className="set-group set-plan-picker" id="change-plan">
				<h2 className="set-heading">Change plan</h2>

				<div className="set-segmented" role="group" aria-label="Plan type">
					{([
						["individual", "Individual"],
						["team", "Team and Enterprise"],
					] as const).map(([id, label]) => (
						<button
							key={id}
							type="button"
							aria-pressed={group === id}
							className={`set-segmented-btn${group === id ? " set-segmented-btn--on" : ""}`}
							onClick={() => setGroup(id)}
						>
							{label}
						</button>
					))}
				</div>

				<div className="set-plan-cards">
					{PLANS.filter((p) => p.group === group).map((p) => {
						const isCurrent = p.id === current;
						// Free stays pickable for everyone — it's the one plan that is
						// open, and nobody should be stranded above it.
						const soon = !canChange && p.id !== "free" && p.id !== "pro";
						// Pro is earned (verified email + complete profile), never
						// clicked into - except by admins moving accounts for testing.
						const lockedPro = p.id === "pro" && !canChange && !isCurrent;
						// A verified researcher's stored plan is still Free, which is
						// what this card would write: nothing would change, yet the
						// banner would say "You're on Free." over a Pro page.
						const isBase = !canChange && !isCurrent && p.id === user.plan;
						return (
							<div
								key={p.id}
								className={`set-plan-card${isCurrent ? " set-plan-card--current" : ""}${
									soon ? " set-plan-card--soon" : ""
								}`}
							>
								{p.badge && <span className="set-plan-badge">{p.badge}</span>}
								<h3 className="set-plan-card-name">{p.label}</h3>
								<p className="set-plan-card-blurb">{p.blurb}</p>
								<div className="set-plan-price">
									{p.price}
									{p.priceNote && <span className="set-plan-price-note">{p.priceNote}</span>}
								</div>
								{lockedPro ? (
									// Verification happens on the Profile tab, so the card
									// links there instead of sitting disabled.
									<Link to="/account" className="set-plan-cta">
										Verify to unlock
									</Link>
								) : (
									<button
										type="button"
										className={`set-plan-cta${isCurrent ? " set-plan-cta--current" : ""}`}
										// Not disabled: that would drop keyboard focus from a
										// person who just pressed Enter on it, and the saved
										// card then stays "Current plan". Presses while it is
										// unavailable or a save is in flight are ignored.
										aria-disabled={isCurrent || soon || busy || isBase || undefined}
										onClick={() => {
											if (isCurrent || soon || busy || isBase) return;
											choose(p.id);
										}}
									>
										{isCurrent
											? "Current plan"
											: soon
												? "Coming soon"
												: isBase
													? "Your base plan"
													: p.cta}
									</button>
								)}
								<ul className="set-plan-points">
									{/* Every card gets a lead line, including the one that
									    inherits nothing, so the bullet lists start at the
									    same height across the row. */}
									<li className="set-plan-inherits">
										{p.inherits
											? `Everything in ${planLabel(p.inherits)}, plus:`
											: p.pointsLead}
									</li>

									{p.points.map((pt) => (
										<li key={pt}>
											<IconCheck size={13} stroke={2.5} /> {pt}
										</li>
									))}
								</ul>
							</div>
						);
					})}
				</div>
			</div>
		</>
	);
};

export default PlanSettings;
