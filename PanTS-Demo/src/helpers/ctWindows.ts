// CT display windows in Hounsfield units, shared by the viewer's Window menu, the
// compare viewer's and the assistant's set-window action so they cannot drift apart.
// center is the window level in HU; the toolbar's Brightness slider shows it negated
// (brighter = lower level), which is why upstream's "Brightness 50" was entered as a
// level of -50 and whited out the liver.
//
// Liver: W 150 / L 80 shows -5 to 155 HU. On the local PanTS cases the liver's median
// sits between 38 HU (non-contrast) and 111 HU (portal venous), so it reads as grey on
// all of them; level 30 still turned most of a contrast-enhanced liver white.
export const CT_WINDOWS = {
  softTissue: { width: 400, center: 40 },
  bone: { width: 1800, center: 400 },
  lung: { width: 1500, center: -600 },
  liver: { width: 150, center: 80 },
  brain: { width: 80, center: 40 },
  // Contrast-enhanced vessels (CTA).
  angio: { width: 600, center: 150 },
} as const;
