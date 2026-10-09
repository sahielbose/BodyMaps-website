import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link } from "react-router-dom";
import { segmentation_categories, API_BASE } from "../../helpers/constants";
import { LANDING_SUBTITLE } from "../../helpers/copy";
import { prefersReducedMotion } from "../../helpers/motion";
import Header from "../../components/Header";
import SiteFooter from "../../components/SiteFooter";
import styles from "./LandingPage.module.css";

/* The overview is one screen: the wordmark, one line, two ways in, and the
   dataset in four numbers. */

/* Fallback shown until (or in case) the live count arrives. The volume count
   is fetched from /api/search so the hero reflects the real library size; the
   other figures describe the dataset release and only change with a release. */
const FALLBACK_VOLUMES = 32_768;

type Stat = { label: string; target: number; format: (n: number) => string };

const plain = (n: number) => Math.round(n).toLocaleString("en-US");
const thousands = (n: number) => (n < 1_000 ? String(Math.round(n)) : `${Math.floor(n / 1_000)}K+`);

const RELEASE_STATS: Stat[] = [
  { label: "Medical centers", target: 145, format: plain },
  { label: "Annotated structures", target: 993_000, format: thousands },
  { label: "Organ classes", target: segmentation_categories.length, format: plain },
];

/* The numbers count up once as the stats row fades in. They start with the
   row (its entrance delay, below in the CSS) and run a little longer than it,
   easing out so the last digits settle rather than stop. */
const COUNT_DELAY_MS = 350;
const COUNT_MS = 1_600;
/* How long the count waits for the live volume figure before it starts with
   the fallback. The row is still fading in meanwhile, so a normal answer
   costs nothing, and the count runs once, straight to the real figure,
   instead of changing course (and width) halfway. */
const LIVE_WAIT_MS = 1_200;
/* A figure that arrives late and higher than the one on screen eases up over
   at least this long. */
const RETARGET_MS = 500;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

type Leg = { from: number; to: number; start: number; end: number };
const still = (value: number, now: number): Leg => ({ from: value, to: value, start: now, end: now });

/**
 * Counts each stat up by writing text straight into its node, so the hero
 * never re-renders mid-count. The count holds at zero until `ready` (the live
 * volume figure is in, or has been given up on), so it normally runs once,
 * straight to its final figure, whose width the markup reserves. A figure
 * that changes after the count has begun only moves forward: a higher one is
 * eased up to from the value on screen, a lower one is simply shown. It never
 * counts backwards. It is a layout effect so the first figures are in place
 * before the first paint.
 */
function useCountUp(stats: Stat[], nodes: RefObject<(HTMLSpanElement | null)[]>, ready: boolean) {
  const shown = useRef<number[]>([]);
  const legs = useRef<Leg[]>([]);
  const frame = useRef(0);
  const mountedAt = useRef<number | null>(null);
  const begun = useRef(false);

  useLayoutEffect(() => {
    const reduced = prefersReducedMotion();
    const now = performance.now();
    if (mountedAt.current === null) mountedAt.current = now;
    const earliest = mountedAt.current + COUNT_DELAY_MS;

    stats.forEach((stat, i) => {
      const leg = legs.current[i];
      if (reduced) {
        legs.current[i] = still(stat.target, now);
      } else if (!ready) {
        if (!leg) legs.current[i] = still(0, now);
      } else if (!begun.current) {
        const start = Math.max(now, earliest);
        legs.current[i] = { from: 0, to: stat.target, start, end: start + COUNT_MS };
      } else if (leg.to !== stat.target) {
        const from = shown.current[i] ?? 0;
        legs.current[i] =
          stat.target > from
            ? {
                from,
                to: stat.target,
                start: Math.max(now, leg.start),
                end: Math.max(leg.end, now + RETARGET_MS),
              }
            : still(stat.target, now);
      }
    });
    if (ready && !reduced) begun.current = true;

    const paint = (t: number) => {
      let running = false;
      stats.forEach((stat, i) => {
        const leg = legs.current[i];
        const span = leg.end - leg.start;
        const k = span <= 0 ? 1 : Math.min(1, Math.max(0, (t - leg.start) / span));
        const value = leg.from + (leg.to - leg.from) * easeOutCubic(k);
        shown.current[i] = value;
        const node = nodes.current[i];
        const text = stat.format(value);
        if (node && node.textContent !== text) node.textContent = text;
        if (k < 1) running = true;
      });
      frame.current = running ? requestAnimationFrame(paint) : 0;
    };
    cancelAnimationFrame(frame.current);
    paint(performance.now());
    return () => cancelAnimationFrame(frame.current);
  }, [stats, nodes, ready]);
}

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 8 14" aria-hidden="true">
      <path d="M1.5 1.5 6.5 7l-5 5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function LandingPage() {
  const [ctVolumes, setCtVolumes] = useState<number | null>(null);
  // The live figure is in, failed, or took too long: the count can start.
  const [liveSettled, setLiveSettled] = useState(false);
  const valueNodes = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    const giveUp = window.setTimeout(() => setLiveSettled(true), LIVE_WAIT_MS);
    fetch(`${API_BASE}/api/search?per_page=1&dataset=all`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.total === "number" && d.total > 0) {
          setCtVolumes(d.total);
        }
      })
      .catch(() => {
        /* keep the fallback on any failure */
      })
      .finally(() => {
        if (!cancelled) setLiveSettled(true);
      });
    return () => {
      cancelled = true;
      window.clearTimeout(giveUp);
    };
  }, []);

  const volumes = ctVolumes ?? FALLBACK_VOLUMES;
  const stats = useMemo<Stat[]>(
    () => [{ label: "CT volumes", target: volumes, format: plain }, ...RELEASE_STATS],
    [volumes],
  );
  useCountUp(stats, valueNodes, liveSettled);

  return (
    // data-scroll-root: this fixed div (not the window) is the page's scroll
    // container; ScrollToTop and the Header drawer's scroll lock target it.
    <div className={styles.root} data-scroll-root="">
      <Header />
      <div className={styles.headerFade} aria-hidden="true" />
      <main className={styles.main}>
        <section className={styles.hero}>
          <h1 className={styles.wordmark} style={{ ["--i" as string]: 0 }} aria-label="BodyMaps">
            <span className={styles.wordmarkBody}>Body</span>Maps
          </h1>
          <p className={styles.subtitle} style={{ ["--i" as string]: 1 }}>
            {LANDING_SUBTITLE}
          </p>
          <div className={styles.actions} style={{ ["--i" as string]: 2 }}>
            <Link to="/dashboard" className={styles.primary}>
              Browse the dataset
            </Link>
            <Link to="/case/1" className={styles.textLink}>
              Open a case <Chevron />
            </Link>
          </div>
          <dl className={styles.stats} style={{ ["--i" as string]: 3 }}>
            {stats.map((stat, i) => {
              const final = stat.format(stat.target);
              return (
                <div key={stat.label} className={styles.stat}>
                  <dt className={styles.statLabel}>{stat.label}</dt>
                  <dd className={styles.statValue}>
                    {/* The final figure holds the width so nothing shifts
                        while the digits count; screen readers read it too. */}
                    <span className={styles.statFinal}>{final}</span>
                    <span
                      className={styles.statCount}
                      aria-hidden="true"
                      ref={(el) => {
                        valueNodes.current[i] = el;
                      }}
                    />
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
