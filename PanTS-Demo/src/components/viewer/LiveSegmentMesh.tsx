import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Color } from "@cornerstonejs/core/types";
import { extractSegmentSurface, subscribeToSegmentationEdits } from "../../helpers/CornerstoneNifti2";

type LiveSegmentMeshProps = {
  segmentIndex: number;
  color: Color;
  visible: boolean;
  opacity: number;
  manifestCenter: [number, number, number];
  // Told whether the class has anything to draw, each time that changes, so the
  // pane can frame a class once its first voxels arrive (it is empty when created).
  onPresenceChange?: (segmentIndex: number, present: boolean) => void;
};

// How long edits to a class must pause before its mesh is rebuilt, so a brush drag or a
// burst of prompt clicks costs one marching-cubes run rather than one per stroke.
const REBUILD_AFTER_EDITS_MS = 400;

// Client-side isosurface for a custom class, built from the live labelmap and
// positioned in the same Three.js scene space as the pre-baked organ GLBs (see
// extractSegmentSurface's transform comments). Catalog organs always draw their
// baked GLB (see MeshViewer); a custom class renders through here from the start.
//
// The mesh follows the 2D edits: once edits to this class settle for
// REBUILD_AFTER_EDITS_MS it is rebuilt from the labelmap, so marching cubes never
// runs per stroke, and extraction only covers the class's own bounding box. A
// hidden class is only marked stale and is rebuilt when it is shown again. A class
// with no voxels (created but not painted, or emptied by an undo) draws nothing.
export function LiveSegmentMesh({
  segmentIndex,
  color,
  visible,
  opacity,
  manifestCenter,
  onPresenceChange,
}: LiveSegmentMeshProps) {
  // Extraction results per segmentIndex, so switching targets back and forth or
  // toggling the class's checkbox reuses a mesh that is still current. An edit to
  // the class drops its entry, and the next render after that rebuilds it.
  const cacheRef = useRef<Map<number, ReturnType<typeof extractSegmentSurface>>>(new Map());

  // Bumped when edits to this class settle while it is shown.
  const [version, setVersion] = useState(0);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  const surface = useMemo(() => {
    const cache = cacheRef.current;
    if (cache.has(segmentIndex)) return cache.get(segmentIndex) ?? null;
    // Always the live labelmap, never a copy taken before the first edit: that copy
    // drew a stale mesh, so none is kept now (see consumePreEditSegmentSnapshot).
    const result = extractSegmentSurface(segmentIndex, manifestCenter);
    // An empty mask (a class created but not painted yet, emptied by an undo, or a
    // volume that is not in the cache yet) gives null and is not kept, so the next
    // edit or showing the class again reads the labelmap afresh.
    if (result) cache.set(segmentIndex, result);
    return result;
    // Never keyed on a per-stroke counter: `version` only moves once edits to this
    // class settle, and `visible` lets a class that went stale while hidden rebuild
    // when it is shown again. Anything still cached is served as is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentIndex, manifestCenter, visible, version]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeToSegmentationEdits((detail) => {
      // The eraser reports class 0, and a brush undo or an edit that changed several
      // classes reports none, so those may have changed this class too.
      const index = detail?.segmentIndex;
      if (index !== undefined && index !== 0 && index !== segmentIndex) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        cacheRef.current.delete(segmentIndex);
        if (visibleRef.current) setVersion((n) => n + 1);
      }, REBUILD_AFTER_EDITS_MS);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [segmentIndex]);

  // Built as sRGB, the way OrganMesh does, so a custom class matches its swatch and the 2D overlay
  // instead of drawing as a lighter pastel. Memoised on the channels so a render does not make a new one.
  const [r, g, b] = color;
  const tint = useMemo(() => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), [r, g, b]);

  const geometry = useMemo(() => {
    if (!surface) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(surface.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(surface.indices, 1));
    geo.computeVertexNormals();
    return geo;
  }, [surface]);

  const present = geometry !== null;
  useEffect(() => {
    onPresenceChange?.(segmentIndex, present);
  }, [onPresenceChange, segmentIndex, present]);

  // R3F only disposes what it built from JSX children, not a geometry handed in as a prop, so
  // every remount (3D pane toggled, report opened) or rebuild would leave the old GPU buffers behind.
  useEffect(() => () => geometry?.dispose(), [geometry]);

  // Nothing painted yet for this class (extractSegmentSurface returns null
  // when the mask is empty) — nothing to show, but don't throw.
  if (!geometry) return null;

  const a = color[3] ?? 255;

  return (
    <mesh geometry={geometry} visible={visible}>
      <meshStandardMaterial
        color={tint}
        transparent
        opacity={opacity * (a / 255)}
        depthWrite={opacity * (a / 255) >= 1}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}
