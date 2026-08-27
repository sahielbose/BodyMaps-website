# Interactive segmentation demo, from scratch

Click-to-segment for the PanTS viewer, powered by [nnInteractive](https://github.com/MIC-DKFZ/nnInteractive)
(DKFZ, Isensee et al. 2025). One click, box, scribble, or lasso on any slice
produces a full 3D mask; further prompts on the same class refine that same
object with the model seeing every prior prompt as context.

> Model weights are CC BY-NC-SA 4.0 — non-commercial research use.

## One-time setup

Three environments, set up once (each step is skipped or automated by the
launcher when already done):

```bash
# 1. Model server env (torch; lives NEXT TO this repo by default)
python3 -m venv ../nninteractive-env
../nninteractive-env/bin/pip install nnInteractive

# 2. Backend env
cd flask-server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd ..

# 3. Viewer deps
cd PanTS-Demo && npm install && cd ..
```

No dataset, no config, and no model weights need to exist beforehand: the
launcher creates `flask-server/.env` from the example, downloads demo case 1
(~90 MB from the public HuggingFace mirror `BodyMaps/iPanTSMini`), and the
model server fetches its weights (~400 MB) on first start.

## Start

```bash
scripts/demo_interactive.sh
```

Brings up the model server (:1527), the Flask backend (:5001), and the Vite
viewer (:5173), in order, waiting for each to be healthy; re-running reuses
anything already up. Then open **http://localhost:5173/case/1**. Ctrl+C in
the script's terminal stops everything it started. First run takes a few
minutes (downloads); later runs take seconds.

## The 5-minute tour

All four tools live in the annotation toolbar (open the Segments panel,
pick or add a class first — the toolbar needs an active class).

1. **Segment from click.** Add a new class, arm "Segment from click", click
   once inside an organ. The model returns the organ's full 3D mask in a
   few seconds, in the class's color, on all three panes.
2. **Refine, don't restart.** The tool stays armed and the session
   accumulates: every further left-click adds to the SAME object, and a
   right-click (or Alt-click) carves away — aim corrective clicks at the
   overshoot's EDGE, not the object's center (a center click tells the
   model the whole region is wrong). Green/red dots mark where your
   prompts landed on the current slice.
3. **Undo, model included.** Ctrl+Z restores the voxels AND rewinds the
   model server's context by one prompt, so the next click refines the
   pre-undo object. (The server keeps one undo snapshot; deeper undos and
   any redo end the session cleanly — the next prompt just re-seeds from
   the labelmap as shown.)
4. **Scribble and lasso.** "Segment from scribble": drag a quick stroke
   along a structure. "Segment from lasso": circle it instead — everything
   inside the drawn contour seeds the object. Both accept Alt-drag as a
   corrective stroke.
5. **Refine a shipped label.** Arm any prompt tool with an EXISTING organ
   selected (e.g. spleen): the first prompt seeds the session from that
   mask, so the model edits the real label instead of growing a duplicate
   next to it — right-click an overshoot and watch it carve.

## Configuration

| Env var | Where | Meaning |
|---|---|---|
| `NNINTERACTIVE_SERVER_URL` | `flask-server/.env` | Model server address (default `http://127.0.0.1:1527`; point at a GPU host / SSH tunnel for deployments) |
| `NNINTERACTIVE_API_KEY` | `flask-server/.env` | Bearer token, only when the model server runs with `--api-key` |
| `NNINTERACTIVE_ENV` | launcher | Python env holding `nninteractive-server` |
| `NNINTERACTIVE_DEVICE` | launcher | `mps` (Apple Silicon default), `cuda`, or `cpu` (last resort — minutes per prompt, has deadlocked on macOS) |
| `BODYMAPS_DATA` | launcher | Dataset folder (`image_only/`, `mask_only/`) |

## Troubleshooting

- **"Interactive segmentation failed (503)" / capacity errors** — the model
  server caps concurrent sessions (3 by default). A killed backend frees
  its slot within ~60 s on the server's default timeouts; just retry.
- **Prompts hang only on LARGE structures (macOS)** — the launcher already
  sets `PYTORCH_ENABLE_MPS_FALLBACK=1`; if you started the model server by
  hand, you must too (autozoom needs an op MPS lacks).
- **"That prompt needs the interactive model server"** — corrective,
  scribble, lasso, and seeded prompts have no fallback; check the model
  server is reachable (`curl http://127.0.0.1:1527/healthz`).
- **First model prompt after startup is slow** — the volume uploads to the
  model server once per case/resolution; later prompts reuse it.
- Logs land in `tmp/demo-logs/` (`model-server.log`, `flask.log`,
  `vite.log`).
