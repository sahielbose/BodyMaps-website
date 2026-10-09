import { useGLTF } from "@react-three/drei";
import type { Color } from "@cornerstonejs/core/types";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { segmentation_category_colors } from '../../helpers/constants';
import type { OrganMeshInfo } from "../../types";
type OrganMeshProps = {
  organ: OrganMeshInfo;
  visible: boolean;
  opacity?: number;
  color?: Color;
};

export const rgbToHex = (r: number, g: number, b: number, _a: number) => 
  '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');

export function OrganMesh({ organ, visible, opacity = 1, color }: OrganMeshProps) {
  const gltf = useGLTF(organ.url);
  const object = useMemo(() => {
    return gltf.scene.clone(true);
  }, [gltf.scene]);

  useEffect(() => {
    const createdMaterials: THREE.Material[] = [];
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgbToHex(...(color ?? segmentation_category_colors[organ.id]))),
        roughness: 0.75,
        metalness: 0.0,
        transparent: opacity < 1,
        opacity,
        // A see-through organ must not write depth: the GLBs share one scene space, so
        // their sort origins tie and whichever draws first would hide every organ behind it.
        depthWrite: opacity >= 1,
        side: THREE.DoubleSide,
      });
      child.material = material;
      createdMaterials.push(material);

      child.frustumCulled = true;
    });
    return () => {
      for (const material of createdMaterials) material.dispose();
    };
  }, [object, organ.id, opacity, color]);

  return <primitive object={object} visible={visible} />;
}
