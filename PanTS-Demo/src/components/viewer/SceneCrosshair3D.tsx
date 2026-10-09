import { useEffect, useMemo } from "react";
import * as THREE from "three";

type Vec3 = [number, number, number];

type SceneBounds = {
    min: Vec3;
    max: Vec3;
};

type SceneCrosshair3DProps = {
    position: Vec3;
    bounds: SceneBounds;
    padding?: number;
};

function makeLineGeometry(a: Vec3, b: Vec3) {
    const geometry = new THREE.BufferGeometry();

    geometry.setFromPoints([
        new THREE.Vector3(a[0], a[1], a[2]),
        new THREE.Vector3(b[0], b[1], b[2]),
    ]);

    return geometry;
}

function makeLine(
  a: Vec3,
  b: Vec3,
  material: THREE.LineBasicMaterial
) {
  const geometry = makeLineGeometry(a, b);
  const line = new THREE.Line(geometry, material);

  line.renderOrder = 999;
  line.frustumCulled = false;

  return line;
}

// Each line takes the colour of the 2D pane whose slice plane it is normal to
// (viewportColors in CornerstoneNifti2: axial red, sagittal yellow, coronal
// green), so the 3D cross reads with the MPR panes. A half-strength line stays
// visible through the meshes (depthTest is off) without a solid white bar.
export const CROSSHAIR_LINE_OPACITY = 0.5;
export const CROSSHAIR_AXIS_COLORS = {
    // left-right runs normal to the sagittal plane
    x: "rgb(200, 200, 0)",
    // superior-inferior runs normal to the axial plane
    y: "rgb(200, 0, 0)",
    // anterior-posterior runs normal to the coronal plane
    z: "rgb(0, 200, 0)",
} as const;

function makeMaterial(color: string) {
    return new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: CROSSHAIR_LINE_OPACITY,
    });
}

export function SceneCrosshair3D({
    position,
    bounds,
    padding = 0,
}: SceneCrosshair3DProps) {
    const [x, y, z] = position;

    // The caller passes the shown organs' box, so with no padding the lines end
    // at the anatomy and do not run to the pane's edge.
    const minX = bounds.min[0] - padding;
    const minY = bounds.min[1] - padding;
    const minZ = bounds.min[2] - padding;

    const maxX = bounds.max[0] + padding;
    const maxY = bounds.max[1] + padding;
    const maxZ = bounds.max[2] + padding;

    /**
     * X line:
     *   x varies
     *   y,z fixed at crosshair position
     *
     * Y line:
     *   y varies
     *   x,z fixed
     *
     * Z line:
     *   z varies
     *   x,y fixed
     */
    const materials = useMemo(
        () => ({
            x: makeMaterial(CROSSHAIR_AXIS_COLORS.x),
            y: makeMaterial(CROSSHAIR_AXIS_COLORS.y),
            z: makeMaterial(CROSSHAIR_AXIS_COLORS.z),
        }),
        []
    );

    const xLine = useMemo(() => {
    return makeLine([minX, y, z], [maxX, y, z], materials.x);
    }, [minX, maxX, y, z, materials]);

    const yLine = useMemo(() => {
        return makeLine([x, minY, z], [x, maxY, z], materials.y);
    }, [x, minY, maxY, z, materials]);

    const zLine = useMemo(() => {
        return makeLine([x, y, minZ], [x, y, maxZ], materials.z);
    }, [x, y, minZ, maxZ, materials]);

    // <primitive> objects are not disposed by R3F, so every crosshair move would
    // otherwise leave the replaced lines' GPU buffers behind.
    useEffect(() => () => xLine.geometry.dispose(), [xLine]);
    useEffect(() => () => yLine.geometry.dispose(), [yLine]);
    useEffect(() => () => zLine.geometry.dispose(), [zLine]);
    useEffect(() => () => {
        materials.x.dispose();
        materials.y.dispose();
        materials.z.dispose();
    }, [materials]);

    return (
        <group renderOrder={999}>
        <primitive object={xLine} />
        <primitive object={yLine} />
        <primitive object={zLine} />
        </group>
    );
}