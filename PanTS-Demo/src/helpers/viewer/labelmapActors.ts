import { addVolumesToViewports, Enums, type RenderingEngine } from "@cornerstonejs/core";
import { Enums as csToolsEnums } from "@cornerstonejs/tools";

type Camera = { focalPoint?: number[]; position?: number[] };
type VolumeActor = {
  getProperty?: () => { setScalarOpacityUnitDistance?: (index: number, distance: number) => void };
  getMapper?: () => { getSampleDistance?: () => number };
};
type Pane = {
  getActors?: () => Array<{ representationUID?: string; actor?: VolumeActor }>;
  getCamera: () => Camera;
  setCamera: (camera: Camera) => void;
};

/** vtk.js scales a volume's opacity by its sample distance over the opacity unit distance
 *  (alpha' = 1 - (1 - alpha)^(sample / unit)), and Cornerstone samples at half the mean
 *  voxel spacing with a unit distance of 1 mm. So one fill value drew at a strength that
 *  followed the grid: a 0.6 fill showed as 0.47 on the 1.25 mm preview and 0.27 once the
 *  0.625 mm full resolution grid replaced it, a 43% fade on HD, and it differed from scan
 *  to scan. Each labelmap's unit distance now scales with its own sample distance, so the
 *  exponent is the preview grid's on every grid and a fill looks as it did when it was tuned. */
export const FILL_REFERENCE_SAMPLE_DISTANCE = 0.683;

export function evenLabelmapOpacity(actor: VolumeActor | undefined): void {
  const sampleDistance = actor?.getMapper?.()?.getSampleDistance?.();
  if (!sampleDistance || !Number.isFinite(sampleDistance)) return;
  actor?.getProperty?.()?.setScalarOpacityUnitDistance?.(0, sampleDistance / FILL_REFERENCE_SAMPLE_DISTANCE);
}

/** The representation UID Cornerstone's labelmap render looks its actors up by. */
export function labelmapRepresentationUID(segmentationId: string): string {
  return `${segmentationId}-${csToolsEnums.SegmentationRepresentations.Labelmap}`;
}

/** Runs `run`, then puts each pane's focal point and position back where they were. */
export async function keepingCameras<T>(
  engine: { getViewport: (id: string) => unknown },
  viewportIds: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  const before = new Map<string, Camera>();
  for (const id of viewportIds) {
    try {
      const { focalPoint, position } = (engine.getViewport(id) as Pane).getCamera();
      if (focalPoint && position) before.set(id, { focalPoint: [...focalPoint], position: [...position] });
    } catch {
      /* pane not ready */
    }
  }
  const result = await run();
  for (const [id, camera] of before) {
    try {
      (engine.getViewport(id) as Pane).setCamera(camera);
    } catch {
      /* pane replaced meanwhile */
    }
  }
  return result;
}

/** Cornerstone's labelmap render checks whether a pane has the labelmap actor and
 *  then adds it asynchronously, so every render queued before the first add lands
 *  (adding the representation, making it active, a style or visibility change)
 *  adds another copy: panes ended up with two to five stacked labelmaps, drawn
 *  more opaque than the rest and rendered several times over. Each add also
 *  re-seats the pane's camera by a slice index (Viewport.addActors), which a
 *  labelmap with its own spacing turns into another plane: the full resolution
 *  room mask over the fast preview CT opened the coronal pane on the first slice,
 *  and the reset makes the crosshairs tool recentre every pane. Adding the actor
 *  here first, one pane at a time and under the UID the render looks for, leaves
 *  the render nothing to add, and the cameras are put back once every pane has it.
 *  The actor starts hidden: until the render applies the colour table it has
 *  vtk's default grey ramp at full opacity, which paints the whole slab grey over
 *  the CT. The render's colour pass (_setLabelmapColorAndOpacity) ends by making
 *  the actor visible, so a pane never shows the labelmap before it is coloured. */
export async function addLabelmapActors(
  engine: RenderingEngine,
  segmentationId: string,
  volumeId: string,
  viewportIds: readonly string[],
): Promise<void> {
  const representationUID = labelmapRepresentationUID(segmentationId);
  await keepingCameras(engine, viewportIds, async () => {
    for (const id of viewportIds) {
      let pane: Pane | undefined;
      try {
        pane = engine.getViewport(id) as unknown as Pane | undefined;
      } catch {
        continue;
      }
      if (!pane) continue;
      const labelmaps = () => pane!.getActors?.().filter((actor) => actor.representationUID?.startsWith(representationUID)) ?? [];
      if (!labelmaps().length) {
        await addVolumesToViewports(
          engine,
          [{ volumeId, visibility: false, representationUID, blendMode: Enums.BlendModes.MAXIMUM_INTENSITY_BLEND }],
          [id],
          false,
          true,
        );
      }
      for (const entry of labelmaps()) evenLabelmapOpacity(entry.actor);
    }
  });
}
