// Transfer-function presets for the 3D pane's "Volume" mode. Kept apart from
// CornerstoneNifti2 so the list and the blend switch can be tested without the
// Cornerstone runtime; CornerstoneNifti2 re-exports both lists.
//
// Each name is a stock Cornerstone (Slicer) preset. The labels say what the preset
// actually shows on PanTS abdominal CT, not what Slicer calls it:
// - CT-Bones is clear below about 150 HU, so muscle and organs drop out and the
//   skeleton shows. (CT-Bone ramps up from -16 HU, which turns a whole abdomen into
//   an opaque reddish shell.)
// - CT-AAA is opaque above about 144 HU, which is iodinated contrast and bone alike;
//   on a non-contrast or venous scan it shows only the skeleton.
// - CT-Chest-Contrast-Enhanced starts at about 67 HU: enhanced organs plus bone.
// - CT-Soft-Tissue is opaque from -160 HU, so fat counts and only the skin shows.
// - CT-MIP and MR-MIP are only transfer functions. A real projection needs the
//   mapper's maximum intensity blend, which applyVolume3DBlend sets.

export type Volume3DBlend = "composite" | "mip";

export type Volume3DPreset = {
  readonly name: string;
  readonly label: string;
  readonly blend: Volume3DBlend;
};

export const VOLUME_3D_PRESETS = [
  { name: "CT-Bones", label: "Bone", blend: "composite" },
  { name: "CT-AAA", label: "Contrast + bone", blend: "composite" },
  { name: "CT-Chest-Contrast-Enhanced", label: "Enhanced organs", blend: "composite" },
  { name: "CT-Lung", label: "Lung", blend: "composite" },
  { name: "CT-Soft-Tissue", label: "Skin", blend: "composite" },
  { name: "CT-MIP", label: "MIP", blend: "mip" },
] as const satisfies readonly Volume3DPreset[];

// MR intensities aren't Hounsfield units, so the CT transfer functions above
// render MR as an opaque slab. Cornerstone ships MR presets; the viewer offers
// these instead when the loaded volume is MR (local DICOM can be any modality).
export const VOLUME_3D_PRESETS_MR = [
  { name: "MR-Default", label: "Default", blend: "composite" },
  { name: "MR-Angio", label: "Angio", blend: "composite" },
  { name: "MR-MIP", label: "MIP", blend: "mip" },
  { name: "MR-T2-Brain", label: "T2 brain", blend: "composite" },
] as const satisfies readonly Volume3DPreset[];

const ALL_PRESETS: readonly Volume3DPreset[] = [...VOLUME_3D_PRESETS, ...VOLUME_3D_PRESETS_MR];

export function volume3DBlendFor(presetName: string): Volume3DBlend {
  return ALL_PRESETS.find((p) => p.name === presetName)?.blend ?? "composite";
}

// The preset list for the volume the viewer just loaded. The page is reused across
// routes, so this is chosen on every load: an MR scan followed by a CT case must
// get the CT list back.
export function volume3DPresetsForModality(modality: string | undefined): readonly Volume3DPreset[] {
  return modality === "MR" ? VOLUME_3D_PRESETS_MR : VOLUME_3D_PRESETS;
}

type BlendModeValues = { COMPOSITE: number; MAXIMUM_INTENSITY_BLEND: number };
type VolumeViewportLike = {
  getDefaultActor?: () =>
    | { actor?: { getMapper?: () => { setBlendMode?: (mode: number) => void } | null | undefined } }
    | null
    | undefined;
};

// VolumeViewport3D.setBlendMode is a no-op in Cornerstone 4, and the mapper only
// takes a blend mode from setVolumes, so set it on the volume actor's mapper. Every
// non-MIP preset sets composite back, so leaving MIP restores shaded rendering.
export function applyVolume3DBlend(
  viewport: VolumeViewportLike | null | undefined,
  presetName: string,
  blendModes: BlendModeValues
): void {
  const mapper = viewport?.getDefaultActor?.()?.actor?.getMapper?.();
  mapper?.setBlendMode?.(
    volume3DBlendFor(presetName) === "mip" ? blendModes.MAXIMUM_INTENSITY_BLEND : blendModes.COMPOSITE
  );
}
