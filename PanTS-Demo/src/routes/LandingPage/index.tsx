import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { segmentation_categories, API_BASE } from "../../helpers/constants";
import Header from "../../components/Header";
import SiteFooter from "../../components/SiteFooter";
import styles from "./LandingPage.module.css";

/* Fallbacks shown until (or in case) the live count arrives. The volume count
   is fetched from /api/search so the hero reflects the real library size; the
   other figures describe the dataset release and only change with a release. */
const FALLBACK_VOLUMES = 32_768;
const MEDICAL_CENTERS = 145;
const ANNOTATED_STRUCTURES = 993_000;
const ORGAN_CLASSES = segmentation_categories.length;

const COUNT_UP_DURATION = 2_200;

const easeOutCubic = (progress: number): number => 1 - Math.pow(1 - progress, 3);

/* 0..1 progress for the hero count-up. Runs once on mount; skipped (pinned at
   1) when the visitor prefers reduced motion. */
function useCountUp(): number {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setProgress(1);
      return;
    }
    const start = performance.now();
    let frame: number;
    const tick = (now: number) => {
      const p = Math.min((now - start) / COUNT_UP_DURATION, 1);
      setProgress(easeOutCubic(p));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return progress;
}

/* The four views the pinned section walks through. Images are stills captured
   from the viewer on PanTS case 1. */
const VIEW_STEPS = [
  {
    id: "axial",
    image: "/landing/view-axial.jpg",
    title: "Axial",
    body: "Every case opens as slices through the body. The axial view looks along the patient's length, the way CT scanners acquire. Each organ's label is drawn over the scan in its own color.",
  },
  {
    id: "sagittal",
    image: "/landing/view-sagittal.jpg",
    title: "Sagittal",
    body: "The same volume cut side-on. All three planes stay linked: scrolling one moves the crosshair in the others, so a finding can be followed through the whole scan.",
  },
  {
    id: "coronal",
    image: "/landing/view-coronal.jpg",
    title: "Coronal",
    body: "The front-facing cut. Windowing presets for soft tissue, lung, and bone apply across all planes at once.",
  },
  {
    id: "3d",
    image: "/landing/view-3d.jpg",
    title: "3D",
    body: "The labeled organs render as meshes or as a shaded volume, in the same browser tab, with nothing to install.",
  },
] as const;

/* Sample cases for the dataset section; the thumbnails ship with the site. */
const SAMPLE_CASES = [
  { id: 1, image: "/case_1_slice.png" },
  { id: 17, image: "/case_17_slice.png" },
  { id: 30, image: "/case_30_slice.png" },
  { id: 35, image: "/case_35_slice.png" },
  { id: 121, image: "/case_121_slice.png" },
] as const;

const ANNOTATION_TOOLS = [
  "Brush",
  "Erase",
  "Scissors",
  "Level tracing",
  "Grow from seeds",
  "Fill between slices",
  "Margin",
  "Smoothing",
  "Islands",
  "Hollow",
] as const;

/* Adds a reveal class once the element scrolls into view. Respects
   prefers-reduced-motion by revealing everything immediately. */
function useReveal() {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const targets = root.querySelectorAll<HTMLElement>("[data-reveal]");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || !("IntersectionObserver" in window)) {
      targets.forEach((el) => el.classList.add(styles.revealed));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).classList.add(styles.revealed);
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return rootRef;
}

export default function LandingPage() {
  const [ctVolumes, setCtVolumes] = useState<number | null>(null);
  const [activeView, setActiveView] = useState(0);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);
  const rootRef = useReveal();
  const heroFigureRef = useRef<HTMLDivElement | null>(null);

  /* The hero capture scrolls into place: while it enters the viewport it
     rises, scales from 94% to full size, and fades in, driven directly by
     scroll position (the page's scroll container is the root div, not the
     window). Skipped for reduced motion. */
  useEffect(() => {
    const rootEl = rootRef.current;
    const figure = heroFigureRef.current;
    if (!rootEl || !figure) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    const apply = () => {
      frame = 0;
      const vh = rootEl.clientHeight;
      const top = figure.getBoundingClientRect().top;
      /* 0 when the figure's top is at the bottom edge, 1 once it has risen
         to 30% of the viewport. */
      const progress = Math.min(1, Math.max(0, (vh - top) / (vh * 0.7)));
      const scale = 0.94 + 0.06 * progress;
      const rise = 48 * (1 - progress);
      figure.style.transform = `translateY(${rise}px) scale(${scale})`;
      figure.style.opacity = String(0.4 + 0.6 * progress);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    rootEl.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      rootEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rootRef]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/search?per_page=1&dataset=all`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d && typeof d.total === "number" && d.total > 0) {
          setCtVolumes(d.total);
        }
      })
      .catch(() => {
        /* keep the fallback on any failure */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /* Track which step block is closest to the middle of the viewport and show
     that step's image in the pinned pane. */
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const idx = stepRefs.current.indexOf(entry.target as HTMLDivElement);
          if (idx >= 0) setActiveView(idx);
        }
      },
      { rootMargin: "-40% 0px -40% 0px", threshold: 0 },
    );
    stepRefs.current.forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, []);

  const countUp = useCountUp();
  const animated = (target: number) => Math.round(countUp * target);

  const stats = [
    {
      value: animated(ctVolumes ?? FALLBACK_VOLUMES).toLocaleString("en-US"),
      label: "CT volumes",
    },
    { value: String(animated(MEDICAL_CENTERS)), label: "Medical centers" },
    {
      value: `${Math.floor(animated(ANNOTATED_STRUCTURES) / 1_000)}K${
        countUp >= 1 ? "+" : ""
      }`,
      label: "Annotated structures",
    },
    { value: String(animated(ORGAN_CLASSES)), label: "Organ classes" },
  ];

  return (
    <div className={styles.root} ref={rootRef}>
      <Header />
      <main>
        {/* ── Hero ── */}
        <section className={styles.hero}>
          <h1 className={styles.heroTitle}>
            The open library of labeled body CT scans
          </h1>
          <p className={styles.heroSubtitle}>
            Browse real, fully annotated CT volumes, open any case in a viewer
            that runs entirely in the browser, and run segmentation models on
            your own scans.
          </p>
          <div className={styles.heroActions}>
            <Link to="/dashboard" className={styles.btnPrimary}>
              Browse the dataset
            </Link>
            <Link to="/case/1" className={styles.btnSecondary}>
              Try the viewer
            </Link>
          </div>
          <div className={styles.heroStats}>
            {stats.map((stat) => (
              <div key={stat.label} className={styles.heroStatItem}>
                <div className={styles.heroStatValue}>{stat.value}</div>
                <div className={styles.heroStatLabel}>{stat.label}</div>
              </div>
            ))}
          </div>
          <div className={styles.heroFigure} ref={heroFigureRef}>
            <img
              src="/landing/viewer-fourup.jpg"
              alt="The BodyMaps viewer showing axial, sagittal, and coronal slices of a CT scan with colored organ labels, and a 3D rendering of the segmented organs"
              className={styles.heroImage}
              width={1600}
              height={1000}
            />
            <p className={styles.heroCaption}>
              PanTS case 1 in the viewer: three linked planes and a 3D rendering
              of its organ labels.
            </p>
          </div>
        </section>

        {/* ── The viewer, scroll-driven ── */}
        <section className={styles.viewsSection}>
          <div className={styles.sectionIntro} data-reveal>
            <h2 className={styles.sectionTitle}>One scan, four views</h2>
            <p className={styles.sectionLead}>
              Each case is a full 3D volume. The viewer shows it the way
              radiologists read it.
            </p>
          </div>
          <div className={styles.viewsLayout}>
            <div className={styles.viewsSteps}>
              {VIEW_STEPS.map((step, i) => (
                <div
                  key={step.id}
                  ref={(el) => {
                    stepRefs.current[i] = el;
                  }}
                  className={`${styles.viewStep} ${
                    i === activeView ? styles.viewStepActive : ""
                  }`}
                >
                  <h3 className={styles.viewStepTitle}>{step.title}</h3>
                  <p className={styles.viewStepBody}>{step.body}</p>
                </div>
              ))}
            </div>
            <div className={styles.viewsSticky}>
              <div className={styles.viewsFrame}>
                {VIEW_STEPS.map((step, i) => (
                  <img
                    key={step.id}
                    src={step.image}
                    alt={`${step.title} view of a labeled CT scan`}
                    className={`${styles.viewImage} ${
                      i === activeView ? styles.viewImageActive : ""
                    }`}
                    width={800}
                    height={500}
                    loading="lazy"
                  />
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── Dataset ── */}
        <section className={styles.section} data-reveal>
          <h2 className={styles.sectionTitle}>The dataset</h2>
          <p className={styles.sectionLead}>
            PanTS holds abdominal CT volumes with per-voxel labels for every
            major organ, reviewed at the source institutions. CancerVerse adds
            oncology cases. Both are searchable by case ID, demographics, CT
            phase, and scanner.
          </p>
          <div className={styles.caseRow}>
            {SAMPLE_CASES.map((c) => (
              <Link key={c.id} to={`/case/${c.id}`} className={styles.caseCard}>
                <img
                  src={c.image}
                  alt={`CT slice from PanTS case ${c.id}`}
                  className={styles.caseThumb}
                  loading="lazy"
                />
                <span className={styles.caseLabel}>Case {c.id}</span>
              </Link>
            ))}
          </div>
          <Link to="/dashboard" className={styles.sectionLink}>
            Browse all cases
          </Link>
        </section>

        {/* ── Annotation ── */}
        <section className={styles.sectionAlt} data-reveal>
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Edit the labels, not just view them</h2>
            <p className={styles.sectionLead}>
              The viewer carries a full segmentation toolset. Corrections made
              on one slice can be grown through the volume from seeds or filled
              between slices, so fixing a label takes minutes, not an
              afternoon in desktop software.
            </p>
            <div className={styles.toolRow} aria-hidden="true">
              {ANNOTATION_TOOLS.map((tool) => (
                <span key={tool} className={styles.toolChip}>
                  {tool}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ── AI assistant ── */}
        <section className={styles.section} data-reveal>
          <h2 className={styles.sectionTitle}>Ask the scan a question</h2>
          <p className={styles.sectionLead}>
            Every case ships with an assistant that can read the volume it is
            looking at.
          </p>
          <div className={styles.chatCard}>
            <div className={styles.chatQuestion}>
              Segment the liver and tell me its volume.
            </div>
            <div className={styles.chatAnswer}>
              Done. The liver is highlighted in all three planes, and its
              volume is computed from the case's own label map.
            </div>
          </div>
        </section>

        {/* ── Upload ── */}
        <section className={styles.sectionAlt} data-reveal>
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Run it on your own scans</h2>
            <div className={styles.stepsRow}>
              <div className={styles.uploadStep}>
                <span className={styles.uploadStepNum}>1</span>
                <h3 className={styles.uploadStepTitle}>Upload a scan</h3>
                <p className={styles.uploadStepBody}>
                  NIfTI files or a DICOM folder, straight from disk.
                </p>
              </div>
              <div className={styles.uploadStep}>
                <span className={styles.uploadStepNum}>2</span>
                <h3 className={styles.uploadStepTitle}>Pick a model</h3>
                <p className={styles.uploadStepBody}>
                  Organ and lesion segmentation models run on our servers.
                </p>
              </div>
              <div className={styles.uploadStep}>
                <span className={styles.uploadStepNum}>3</span>
                <h3 className={styles.uploadStepTitle}>Review the result</h3>
                <p className={styles.uploadStepBody}>
                  The output opens in the same viewer, ready to correct and
                  download.
                </p>
              </div>
            </div>
            <p className={styles.uploadNote}>
              Viewing your own scan is free and never leaves your browser.
              Running models needs an account.
            </p>
            <Link to="/upload" className={styles.sectionLink}>
              Go to upload
            </Link>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
