import { Bounds, Html, OrbitControls, useBounds, useGLTF } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { registerMeshRoot } from "../../helpers/viewer/meshCapture";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import { APP_CONSTANTS } from "../../helpers/constants";
import { cornerstoneLpsMmToThree, type Vec3 } from "../../helpers/utils";
import type { MeshManifest } from "../../types";
import { OrganMesh } from "./OrganMesh";
import { SceneCrosshair3D } from "./SceneCrosshair3D";
import type { Color } from "@cornerstonejs/core/types";
import { LiveSegmentMesh } from "./LiveSegmentMesh";
import type { CheckBoxData } from "../../types";
import ErrorBoundary from "../ErrorBoundary";
import { prefersReducedMotion } from "../../helpers/motion";

type SegmentationMeshViewerProps = {
  caseId: string;
  loading: boolean
  checkState: boolean[];
  opacity: number;
  crosshairMm: Vec3 | null
  customOrgans?: CheckBoxData[];
  // Catalog classes edited on this page. One the scan has no baked mesh for gets a
  // live mesh, the way a custom class does; one with a baked mesh keeps it.
  editedOrgans?: CheckBoxData[];
  labelColorMap?: { [key: number]: Color };
  // Uploaded scans have no pre-baked meshes; fetch from the session route, which
  // builds them on demand from the session's combined_labels.
  isSession?: boolean;
  // Refit the camera to the organs that are shown whenever that set changes. The
  // default fit is to the whole scene, hidden organs included, which leaves a
  // single isolated organ small and off centre. The report walkthrough turns
  // this on while it highlights one organ at a time.
  fitVisible?: boolean;
};

// Refits the camera to the shown organs (see fitVisible). Lives inside <Bounds>
// for its api. `signature` names the shown set, so the fit reruns when it changes.
// It also reruns when the canvas resizes, so the shown organs are refitted rather
// than the whole scene (<Bounds> itself only fits once, on mount).
export function RefitToVisibleOrgans({ groupRef, signature }: { groupRef: RefObject<THREE.Group | null>; signature: string }) {
  const bounds = useBounds();
  const size = useThree((state) => state.size);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const box = new THREE.Box3();
    for (const child of group.children) {
      if (child.visible) box.expandByObject(child);
    }
    if (box.isEmpty()) return;
    bounds.refresh(box).clip().fit();
  }, [bounds, groupRef, signature, size]);
  return null;
}

// Refits the whole scene when fitVisible turns off. RefitToVisibleOrgans unmounts with
// it, and nothing else refits on a change of the shown set, so a camera left on the last
// isolated organ would stay on that close-up after the report closes. The canvas box does
// not change when the 3D-only layout stays put, so the resize refit does not cover this.
// The camera cannot be orbited while the report is open, so the refit is unconditional.
export function RefitWhenFitVisibleEnds({ fitVisible }: { fitVisible: boolean }) {
  const bounds = useBounds() as ReturnType<typeof useBounds> | undefined;
  const wasFitVisible = useRef(fitVisible);
  useEffect(() => {
    const ended = wasFitVisible.current && !fitVisible;
    wasFitVisible.current = fitVisible;
    if (ended) bounds?.refresh().clip().fit();
  }, [bounds, fitVisible]);
  return null;
}

// Whether the user has moved the camera (orbit, zoom or pan) and whether a gesture is in
// progress, for refits that must leave a camera the user placed where it is.
function useUserCameraMoves() {
  const controls = useThree((state) => state.controls) as THREE.EventDispatcher | null | undefined;
  const orbited = useRef(false);
  const gesture = useRef(false);
  useEffect(() => {
    if (!controls?.addEventListener) return;
    // A press or a wheel tick fires "start" even when the camera never moves, so the camera counts
    // as moved by the user only if it differs from where it was when the gesture began. While a
    // gesture is in progress no refit runs either.
    const view = controls as unknown as { object?: THREE.Object3D; target?: THREE.Vector3 };
    let before: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
    const onStart = () => {
      gesture.current = true;
      before = view.object && view.target ? { position: view.object.position.clone(), target: view.target.clone() } : null;
    };
    const onEnd = () => {
      gesture.current = false;
      const moved = !before || !view.object || !view.target
        || before.position.distanceTo(view.object.position) > 1e-3
        || before.target.distanceTo(view.target) > 1e-3;
      if (moved) orbited.current = true;
    };
    controls.addEventListener("start" as never, onStart);
    controls.addEventListener("end" as never, onEnd);
    return () => {
      gesture.current = false;
      controls.removeEventListener?.("start" as never, onStart);
      controls.removeEventListener?.("end" as never, onEnd);
    };
  }, [controls]);
  return { orbited, gesture };
}

// Refits the camera whenever the canvas box changes size, in every view mode. The
// pane changes size with layout changes (grid spans, the docks, the AI sidebar), and
// the fit from the old size then leaves the organs tiny in a corner or cropped. The
// box is observed directly, so this does not depend on anything outside the pane
// dispatching a window resize. A short settle delay lets the layout finish first,
// and a camera the user has orbited, zoomed or panned is left where they put it
// (<Bounds> is not set to observe, and RefitWhenShownSetChanges keeps the same guard).
// `fitVisible` frames only the shown organs, for the report and for a scan with no
// baked meshes, whose hidden live classes would otherwise widen the fit.
export function RefitOnCanvasResize({ groupRef, fitVisible }: { groupRef: RefObject<THREE.Group | null>; fitVisible: boolean }) {
  const bounds = useBounds() as ReturnType<typeof useBounds> | undefined;
  const gl = useThree((state) => state.gl) as { domElement?: HTMLCanvasElement } | undefined;
  const { orbited, gesture } = useUserCameraMoves();
  useEffect(() => {
    const host = gl?.domElement?.parentElement;
    if (!bounds || !host || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastW = host.clientWidth;
    let lastH = host.clientHeight;
    const refit = () => {
      if (orbited.current || gesture.current) return;
      const group = groupRef.current;
      let box: THREE.Box3 | null = null;
      if (fitVisible && group) {
        box = new THREE.Box3();
        for (const child of group.children) {
          if (child.visible) box.expandByObject(child);
        }
        if (box.isEmpty()) box = null;
      }
      (box ? bounds.refresh(box) : bounds.refresh()).clip().fit();
    };
    const observer = new ResizeObserver(() => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (w === 0 || h === 0) return;
      clearTimeout(timer);
      timer = setTimeout(refit, 120);
    });
    observer.observe(host);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [bounds, gl, groupRef, fitVisible, orbited, gesture]);
  return null;
}

// On a scan with no baked meshes the scene starts empty and fills up class by class, so the
// one fit <Bounds> makes on mount frames only the first class. This refits to the shown
// classes whenever that set changes (a class gets its first voxels, or is shown or hidden),
// unless the user has moved the camera. Canvas resizes are left to RefitOnCanvasResize, which
// keeps the same guard, so a camera the user placed is never moved behind their back.
export function RefitWhenShownSetChanges({ groupRef, signature }: { groupRef: RefObject<THREE.Group | null>; signature: string }) {
  const bounds = useBounds() as ReturnType<typeof useBounds> | undefined;
  const { orbited, gesture } = useUserCameraMoves();
  useEffect(() => {
    const group = groupRef.current;
    if (!bounds || !group || orbited.current || gesture.current) return;
    const box = new THREE.Box3();
    for (const child of group.children) {
      if (child.visible) box.expandByObject(child);
    }
    if (box.isEmpty()) return;
    bounds.refresh(box).clip().fit();
  }, [bounds, groupRef, signature, orbited, gesture]);
  return null;
}

// Shown over the black canvas while the organ GLBs download, so the pane never
// looks broken. Every OrganMesh suspends under one <Suspense>, which keeps the
// organs appearing together and the camera fitted to all of them.
function MeshesLoading() {
  return (
    <Html center>
      <div role="status" style={{ whiteSpace: "nowrap", fontFamily: "var(--vp-font)", fontSize: 13, color: "var(--vp-text-dim)", pointerEvents: "none" }}>
        Loading 3D segmentation...
      </div>
    </Html>
  );
}

type CrosshairBounds = { min: Vec3; max: Vec3 };

const sameBounds = (a: CrosshairBounds, b: CrosshairBounds) =>
  a.min.every((v, i) => Math.abs(v - b.min[i]) < 0.5) && a.max.every((v, i) => Math.abs(v - b.max[i]) < 0.5);

// The crosshair spans the shown organs, so its lines end at the anatomy. The
// manifest bounds are the whole CT volume around a different centre than the
// meshes, so they run well past the organs and are only the fallback until a
// mesh has loaded. The box is read from the group a few times a second (meshes
// stream in, and visibility and edits change it), and state is set only when it
// moves.
function OrganCrosshair3D({ groupRef, position, fallback }: { groupRef: RefObject<THREE.Group | null>; position: Vec3; fallback: CrosshairBounds }) {
  const [bounds, setBounds] = useState<CrosshairBounds>(fallback);
  const frame = useRef(0);
  useFrame(() => {
    frame.current += 1;
    if (frame.current % 15 !== 1) return;
    const group = groupRef.current;
    if (!group) return;
    const box = new THREE.Box3();
    for (const child of group.children) {
      if (child.visible) box.expandByObject(child);
    }
    const next: CrosshairBounds = box.isEmpty()
      ? fallback
      : { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
    setBounds((prev) => (sameBounds(prev, next) ? prev : next));
  });
  return <SceneCrosshair3D position={position} bounds={bounds} />;
}

export async function fetchMeshManifest(caseId: string, isSession = false): Promise<MeshManifest> {
  const base = isSession
    ? `${APP_CONSTANTS.API_ORIGIN}/api/sessions/${caseId}/mesh-manifest`
    : `${APP_CONSTANTS.API_ORIGIN}/api/cases/${caseId}/mesh-manifest`;
  const res = await fetch(base);
  if (!res.ok) throw new Error(`Failed to fetch mesh manifest: ${res.status}`);
  const data = await res.json() as Partial<MeshManifest>;
  if (!Array.isArray(data.organs) || !Array.isArray(data.center)) {
    throw new Error("Mesh manifest response is invalid");
  }
  return data as MeshManifest;
}

export function SegmentationMeshViewer({ caseId, checkState, loading, opacity, crosshairMm, customOrgans = [], editedOrgans = [], labelColorMap = {}, isSession = false, fitVisible = false}: SegmentationMeshViewerProps) {
  const [manifest, setManifest] = useState<MeshManifest | null>(null);
  const [manifestError, setManifestError] = useState(false);
  const [loaded, setLoaded] = useState<Record<number, boolean>>({});
  // Organs whose GLB failed to download, so the pane can say so instead of
  // showing a black canvas.
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  // Bumped by "Try again": the first refetches the manifest, the second lets the
  // organ boundaries that caught a failed download render their organ again.
  const [manifestAttempt, setManifestAttempt] = useState(0);
  const [organAttempt, setOrganAttempt] = useState(0);
  // Set when something outside an organ boundary throws inside the Canvas (no WebGL context, a marching-cubes failure),
  // so the pane can show the same alert and "Try again" as the other failures instead of a dead end.
  const [canvasFailed, setCanvasFailed] = useState(false);

  // Drop the renderer handle when this pane goes away, so a capture can never
  // reach into a disposed WebGL context.
  useEffect(() => () => registerMeshRoot(null), []);

  // False while the pane is not on screen (a single 2D view hides it with display: none, and
  // the page keeps this component mounted). The render loop is stopped then, so the organs are
  // not redrawn every frame into a canvas nobody can see. A snapshot still renders on demand.
  const [onScreen, setOnScreen] = useState(true);

  const crosshairPosition = useMemo(() => {
    if (!manifest || !crosshairMm) return null;
    return cornerstoneLpsMmToThree(crosshairMm, manifest.center);
  }, [manifest, crosshairMm]);

  useEffect(() => {
    let alive = true;
    setManifest(null);
    setManifestError(false);
    setCanvasFailed(false);
    setFailed({});
    fetchMeshManifest(caseId, isSession)
      .then((data) => {
        if (!alive) return;
        setManifest(data);
        const initialLoaded: Record<number, boolean> = {};
        for (const organ of data.organs) initialLoaded[organ.id] = true;
        setLoaded(initialLoaded);
      })
      .catch(() => { if (alive) setManifestError(true); });
    return () => { alive = false; };
  }, [caseId, isSession, manifestAttempt]);

  const organs = useMemo(() => manifest?.organs ?? [], [manifest]);
  // Everything drawn from the live labelmap: custom classes, plus edited catalog
  // classes that have no baked mesh here (an organ the dataset never labelled on
  // this scan, filled in with the model or the brush). Without this a catalog
  // class drawn from scratch never showed in 3D.
  const liveOrgans = useMemo(() => {
    if (editedOrgans.length === 0) return customOrgans;
    const baked = new Set(organs.map((o) => o.id));
    return [...editedOrgans.filter((o) => !baked.has(o.id)), ...customOrgans];
  }, [organs, editedOrgans, customOrgans]);
  const organGroupRef = useRef<THREE.Group>(null);
  // Live classes that have something to draw. A class joins the scene empty (a new
  // custom class) and gets its first voxels later, so the shown set below only counts
  // it from then, and a refit to the shown set frames it.
  const [livePresent, setLivePresent] = useState<Record<number, boolean>>({});
  const onLivePresence = useCallback((id: number, present: boolean) => {
    setLivePresent((prev) => (!!prev[id] === present ? prev : { ...prev, [id]: present }));
  }, []);
  const shownSignature = useMemo(
    () => [...organs.map((o) => o.id), ...liveOrgans.filter((o) => livePresent[o.id]).map((o) => o.id)].filter((id) => loaded[id] !== false && checkState?.[id]).join(","),
    [organs, liveOrgans, livePresent, loaded, checkState]
  );

  const failedCount = organs.filter((o) => failed[o.id]).length;
  const allFailed = organs.length > 0 && liveOrgans.length === 0 && failedCount === organs.length;
  // The server only lists labels the segmentation contains, so a scan with none of them (or an empty result) has nothing to draw.
  const noMeshes = manifest !== null && organs.length === 0 && liveOrgans.length === 0;

  // "Try again" is pressed with the keyboard, and the button it was on goes away
  // (the pane swaps to the loading message, or the canvas takes the alert's place).
  // Whichever block is showing takes focus, once each time the pane changes what it
  // shows or a retry starts, until the user moves on or the retry lands on the alert
  // again. It is not capped by time, since a slow retry can still fail well after it.
  const paneRef = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  const paneKind = manifestError || allFailed || canvasFailed ? "alert" : !manifest || loading || !checkState || checkState.length === 0 ? "loading" : noMeshes ? "empty" : "host";
  useEffect(() => {
    if (!refocus.current) return;
    const el = paneRef.current;
    if (!el) return;
    const active = document.activeElement;
    // Focus was moved somewhere else on purpose, so leave it there.
    if (active && active !== document.body && active.isConnected && !el.contains(active)) {
      refocus.current = false;
      return;
    }
    // Already on the pane or on a button inside it, such as the one in the partial failure status.
    if (active && el.contains(active)) return;
    el.focus({ preventScroll: true });
    if (paneKind === "alert") refocus.current = false;
  }, [paneKind, manifestAttempt, organAttempt]);
  useEffect(() => {
    // A click or tab to anything else, or a press on the canvas, hands focus back to the user.
    const release = (e: Event) => {
      if (e.type === "focusin" && paneRef.current?.contains(e.target as Node)) return;
      refocus.current = false;
    };
    document.addEventListener("focusin", release);
    document.addEventListener("pointerdown", release, true);
    return () => {
      document.removeEventListener("focusin", release);
      document.removeEventListener("pointerdown", release, true);
    };
  }, []);

  useEffect(() => {
    const el = paneRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setOnScreen(last.isIntersecting);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [paneKind]);

  const tryAgain = () => {
    refocus.current = true;
    if (canvasFailed) {
      // The pane swaps back to the host, which mounts a fresh Canvas.
      setCanvasFailed(false);
      return;
    }
    if (manifestError) {
      setManifestError(false);
      setManifestAttempt((n) => n + 1);
      return;
    }
    // useGLTF keeps a failed download, so drop each one before its organ renders again.
    for (const organ of organs) if (failed[organ.id]) useGLTF.clear(organ.url);
    setFailed({});
    setOrganAttempt((n) => n + 1);
  };

  // Read on each render, so a change of the system setting applies without a reload.
  const reduceMotion = prefersReducedMotion();

  if (manifestError || allFailed || canvasFailed) {
    return (
      <div className="vp-3d-empty" role="alert" ref={paneRef} tabIndex={-1} style={{ outline: "none" }}>
        3D segmentation unavailable.
        <button type="button" className="vp-btn" onClick={tryAgain}>Try again</button>
      </div>
    );
  }
  if (!manifest || loading || !checkState || checkState.length === 0) {
    return <div className="vp-3d-empty" role="status" ref={paneRef} tabIndex={-1} style={{ outline: "none" }}>Loading 3D segmentation...</div>;
  }
  if (noMeshes) {
    return (
      <div className="vp-3d-empty" role="status" ref={paneRef} tabIndex={-1} style={{ outline: "none" }}>
        No organ meshes for this scan
        <span>(switch to Volume rendering below)</span>
      </div>
    );
  }
  return (
    <div data-vp-mesh-host ref={paneRef} tabIndex={-1} style={{ outline: "none", position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* Absolutely filling the host gives the canvas a definite box that follows the pane, so it is measured again whenever the pane is resized. */}
      <div data-vp-mesh-canvas style={{ position: "absolute", inset: 0 }}>
        {/*
          preserveDrawingBuffer is REQUIRED for the AI assistant's snapshots.
          WebGL clears the drawing buffer as soon as the frame is composited, so
          without it canvas.toDataURL() reads an already-cleared buffer and the
          captured "3D view" is a black rectangle. data-bodymaps-3d marks the
          canvas so the capture helper picks this one and never an unrelated
          canvas that happens to sit in the same pane.
        */}
        <ErrorBoundary fallback={null} onError={() => setCanvasFailed(true)}>
        <Canvas
          camera={{ position: [0, 250, 650], fov: 45, near: 0.1, far: 5000 }}
          gl={{ preserveDrawingBuffer: true, antialias: true }}
          frameloop={onScreen ? "always" : "never"}
          resize={{ scroll: false, debounce: { scroll: 0, resize: 0 } }}
          onCreated={(state) => {
            registerMeshRoot(state);
            state.gl.domElement.setAttribute("data-bodymaps-3d", "1");
            state.gl.domElement.setAttribute("role", "img");
            state.gl.domElement.setAttribute("aria-label", "3D view of the segmented organs. Drag to rotate, scroll to zoom.");
          }}
        >
          <color attach="background" args={["#000"]} />
          <ambientLight intensity={0.7} />
          <directionalLight position={[300, 500, 300]} intensity={1.2} />
          <Suspense fallback={<MeshesLoading />}>
            <Bounds fit clip margin={1.2} maxDuration={reduceMotion ? 0.01 : 1}>
              <group ref={organGroupRef}>
                {organs.map((organ) => {
                  if (!loaded[organ.id]) return null;
                  // Always render the pre-baked GLB, even after this organ
                  // has been edited. Switching to a live marching-cubes
                  // mesh (LiveSegmentMesh) the instant an edit lands was
                  // both expensive (isosurface extraction on the stroke
                  // that triggers the switch — visible as a lag spike
                  // right on the first brush stroke) and unnecessary: the
                  // 3D pane is meant to show the original mesh of a catalog
                  // organ, not a live reconstruction of in-progress edits to
                  // it, so recomputing a catalog organ here gains nothing.
                  // Custom classes are different: they have no baked GLB, so
                  // they go through LiveSegmentMesh below, which is the only
                  // way they show in 3D, and their mesh is rebuilt shortly
                  // after edits to them settle.
                  // A GLB that fails to download drops only its own organ
                  // (the boundary logs it and reports it, see the status line
                  // below), not the whole pane.
                  return (
                    <ErrorBoundary key={organ.id} fallback={null} resetKey={String(organAttempt)} onError={() => {
                      // useGLTF keeps a failed download and rethrows it on every later render of the
                      // same url, so drop it here or the next visit to the pane never asks again.
                      useGLTF.clear(organ.url);
                      setFailed((prev) => ({ ...prev, [organ.id]: true }));
                    }}>
                      <OrganMesh
                        organ={organ}
                        visible={!!checkState[organ.id]}
                        opacity={opacity/100}
                        color={labelColorMap[organ.id]}
                      />
                    </ErrorBoundary>
                  );
                })}
                {liveOrgans.map((organ) => (
                  <LiveSegmentMesh
                    key={organ.id}
                    segmentIndex={organ.id}
                    color={labelColorMap[organ.id] ?? [255, 255, 255, 255]}
                    visible={!!checkState[organ.id]}
                    opacity={opacity / 100}
                    manifestCenter={manifest.center as [number, number, number]}
                    onPresenceChange={onLivePresence}
                  />
                ))}
              </group>
              {fitVisible && <RefitToVisibleOrgans groupRef={organGroupRef} signature={shownSignature} />}
              {/* A scan with no baked meshes fills up class by class, so its camera follows the
                  shown classes until the user moves it, and a resize frames them too. */}
              {!fitVisible && organs.length === 0 && <RefitWhenShownSetChanges groupRef={organGroupRef} signature={shownSignature} />}
              <RefitWhenFitVisibleEnds fitVisible={fitVisible} />
              <RefitOnCanvasResize groupRef={organGroupRef} fitVisible={fitVisible || organs.length === 0} />
            </Bounds>
            {crosshairPosition && manifest.bounds && (
              <OrganCrosshair3D groupRef={organGroupRef} position={crosshairPosition} fallback={manifest.bounds} />
            )}
          </Suspense>
          <OrbitControls makeDefault enableDamping={!reduceMotion} />
        </Canvas>
        </ErrorBoundary>
        {failedCount > 0 && (
          // Top left, under the pane's corner label (which ends about 30px down): the 3D toolbar is centred along the bottom edge and covers a bottom corner in any narrow pane.
          // The status ignores the pointer so it never blocks the canvas; its button turns it back on.
          <div role="status" style={{ position: "absolute", left: 10, right: 8, top: 36, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontFamily: "var(--vp-font)", fontSize: 12, color: "var(--vp-text-dim)", pointerEvents: "none" }}>
            {failedCount} of {organs.length} {organs.length === 1 ? "organ" : "organs"} did not load.
            <button type="button" className="vp-btn" style={{ pointerEvents: "auto" }} onClick={tryAgain}>Try again</button>
          </div>
        )}
      </div>
    </div>
  );
}