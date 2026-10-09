"""PanTS dataset masks are read in the viewer's organ numbering, converted once.

The dataset numbers 22-28 differently from the viewer catalog (22 postcava ...
27 veins, 28 pancreatic_lesion, where the viewer has the lesion at 22). Read raw,
the spleen showed as "Prostate", the IVC as an 81 mL pancreatic lesion and the real
lesion as "Veins"; the report's own 0-based table also called the liver lung_left.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from flask import Flask

import api.api_blueprint as bp
import api.utils as api_utils
from constants import Constants
from services import case35, lesion_grounding, mesh_generation
from services.auto_segmentor import _VIEWER_LABELS as AUTO_SEGMENTOR_LABELS
from services.label_scheme import (
    PANTS_IDS,
    PANTS_LABELS,
    PANTS_TO_VIEWER,
    SCHEME,
    VIEWER_IDS,
    VIEWER_LABELS,
    to_viewer,
    viewer_labelmap_path,
)
from services.live_room_store import LiveRoomStore
from services.user_dataset import _LABEL_NAMES as USER_DATASET_LABELS

REPO = Path(__file__).resolve().parents[3]
CASE = "PanTS_00000035"
# One 5x5x5 blob per raw value, so each organ clears the report's voxel threshold.
RAW_VALUES = (1, 3, 14, 19, 22, 24, 28)


def test_dataset_to_viewer_table_is_exact():
    assert PANTS_TO_VIEWER[:22].tolist() == list(range(22))
    assert {raw: int(PANTS_TO_VIEWER[raw]) for raw in range(22, 29)} == {
        22: 23, 23: 24, 24: 25, 25: 26, 26: 27, 27: 28, 28: 22,
    }
    # Values PanTS never writes become background, not unrelated viewer classes.
    assert not PANTS_TO_VIEWER[29:].any()
    assert sorted(PANTS_TO_VIEWER[1:29].tolist()) == list(range(1, 29))
    assert PANTS_LABELS[24] == "spleen" and VIEWER_IDS["spleen"] == 25
    assert to_viewer(np.array([24.0, 28.0, 22.4, -1.0, np.nan, 300.0])).tolist() == [25, 22, 23, 0, 0, 0]


def test_every_viewer_table_matches_the_frontend_catalog():
    source = (REPO / "PanTS-Demo" / "src" / "helpers" / "constants.ts").read_text(encoding="utf-8")
    block = source.split("export const segmentation_categories", 1)[1].split("];", 1)[0]
    catalog = re.findall(r'"([a-z_]+)"', block)
    assert catalog == [VIEWER_LABELS[i]["key"] for i in range(1, len(VIEWER_LABELS) + 1)]

    assert mesh_generation.LABELS is VIEWER_LABELS
    assert AUTO_SEGMENTOR_LABELS == VIEWER_IDS
    assert USER_DATASET_LABELS == {i: meta["key"] for i, meta in VIEWER_LABELS.items()}
    assert {i: meta["key"] for i, meta in lesion_grounding.LESION_LABELS.items()} == {
        i: VIEWER_LABELS[i]["key"] for i in lesion_grounding.LESION_LABELS
    }
    assert lesion_grounding._PANCREAS_SUBREGIONS == {
        VIEWER_IDS["pancreas_head"]: "head",
        VIEWER_IDS["pancreas_body"]: "body",
        VIEWER_IDS["pancreas_tail"]: "tail",
    }
    assert lesion_grounding._CONTACT_LABELS[VIEWER_IDS["superior_mesenteric_artery"]] == "superior mesenteric artery"
    assert lesion_grounding._CONTACT_LABELS[VIEWER_IDS["veins"]] == "veins"


def test_case35_reads_the_raw_lesion_and_reveals_the_viewer_mesh():
    assert case35.LESION_LABEL == PANTS_IDS["pancreatic_lesion"] == 28
    assert case35.LESION_MESH_ORGAN_ID == VIEWER_IDS["pancreatic_lesion"] == 22


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    pants = tmp_path / "pants"
    mask_dir = pants / "mask_only" / CASE
    image_dir = pants / "image_only" / CASE
    lowres_dir = tmp_path / "lowres" / "mask_only" / CASE
    for directory in (mask_dir, image_dir, lowres_dir):
        directory.mkdir(parents=True)
    labels = np.zeros((40, 8, 8), dtype=np.float32)
    for index, value in enumerate(RAW_VALUES):
        labels[index * 5 + 1:index * 5 + 6, 1:6, 1:6] = value
    affine = np.eye(4)
    # Float, as several dataset masks are stored, to exercise the rounding.
    nib.save(nib.Nifti1Image(labels, affine), mask_dir / "combined_labels.nii.gz")
    nib.save(nib.Nifti1Image(labels[::2], np.diag([2.0, 1.0, 1.0, 1.0])), lowres_dir / "combined_labels_lowres.nii.gz")
    nib.save(nib.Nifti1Image(np.full(labels.shape, 40, dtype=np.int16), affine), image_dir / "ct.nii.gz")
    monkeypatch.setattr(Constants, "PANTS_PATH", str(pants))
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"))
    monkeypatch.setattr(bp, "LOWRES_ROOT", str(tmp_path / "lowres"))
    monkeypatch.setattr(bp, "_AI_HF_CACHE_ROOT", str(tmp_path / "hf"))

    def no_download(*_args, **_kwargs):
        raise AssertionError("a local case must never reach the HuggingFace mirror")

    monkeypatch.setattr(bp, "_ai_download_case_file", no_download)
    return pants


def client():
    app = Flask(__name__)
    app.register_blueprint(bp.api_blueprint, url_prefix="/api")
    return app.test_client()


def served_values(response, tmp_path):
    path = tmp_path / "served.nii.gz"
    path.write_bytes(response.data)
    image = nib.load(str(path))
    assert image.get_data_dtype() == np.uint8
    return set(np.unique(np.asanyarray(image.dataobj)).tolist()) - {0}


def test_served_masks_are_in_viewer_ids_at_both_resolutions(dataset, tmp_path):
    expected = {1, 3, 14, 19, 23, 25, 22}
    full = client().get(f"/api/get-segmentations/35.nii.gz?labels={SCHEME}")
    assert full.status_code == 200
    assert full.headers["Cache-Control"] == "public, max-age=604800, immutable"
    assert served_values(full, tmp_path) == expected

    low = client().get(f"/api/get-segmentations/35.nii.gz?labels={SCHEME}&res=low")
    assert low.status_code == 200
    assert served_values(low, tmp_path) == expected

    # An old client without the query value gets the converted mask too.
    assert served_values(client().get("/api/get-segmentations/35.nii.gz"), tmp_path) == expected
    # The dataset itself is never written to.
    assert sorted(os.listdir(dataset / "mask_only" / CASE)) == ["combined_labels.nii.gz"]


def test_converted_copy_follows_its_source(dataset):
    source = dataset / "mask_only" / CASE / "combined_labels.nii.gz"
    first = viewer_labelmap_path(source)
    assert viewer_labelmap_path(source) == first
    image = nib.load(str(source))
    data = np.asanyarray(image.dataobj).copy()
    data[0, 0, 0] = 24
    nib.save(nib.Nifti1Image(data, image.affine), source)
    os.utime(source, ns=(1, 1))
    second = viewer_labelmap_path(source)
    assert second != first and not os.path.exists(first)
    assert np.asanyarray(nib.load(second).dataobj)[0, 0, 0] == 25


def test_organ_metrics_name_the_dataset_organs_correctly(dataset):
    names = {m["organ_name"] for m in bp._ai_compute_organ_metrics_from_labels("35")["organ_metrics"]}
    assert names == {"adrenal_gland_left", "aorta", "liver", "pancreas_head", "postcava", "spleen", "pancreatic_lesion"}

    # The richer table ignores a per-case organ_intensities.json that lists ids
    # in directory order.
    (dataset / "mask_only" / CASE / "organ_intensities.json").write_text(json.dumps({"lung_left": 14}))
    metrics = api_utils.get_mask_data_internal(35)["organ_metrics"]
    present = {m["organ_name"]: m["voxel_count"] for m in metrics if m["voxel_count"]}
    assert present == {name: 125 for name in names}
    assert {m["organ_name"] for m in metrics} == set(PANTS_LABELS.values())


def test_mask_data_route_answers_in_viewer_names(dataset):
    app = Flask(__name__)
    app.add_url_rule("/api/mask-data", view_func=bp.get_mask_data, methods=["POST"])
    metrics = app.test_client().post("/api/mask-data", data={"sessionKey": "35"}).get_json()["organ_metrics"]
    present = {m["organ_name"] for m in metrics if m["voxel_count"]}
    assert {"spleen", "postcava", "pancreatic_lesion"} <= present
    assert "prostate" not in present and "veins" not in present


def test_report_rows_use_the_viewer_table(dataset, monkeypatch):
    monkeypatch.setattr(bp, "_REPORT_STUDY_META", {})
    bp._REPORT_DATA_CACHE.pop("35", None)
    try:
        organs = bp._build_report_data("35")["organ_volumes"]
    finally:
        bp._REPORT_DATA_CACHE.pop("35", None)
    assert set(organs) == {"adrenal_gland_left", "aorta", "liver", "pancreas_head", "postcava", "spleen", "pancreatic_lesion"}
    assert organs["liver"]["volume"] == pytest.approx(0.125, abs=0.01)


def test_session_masks_are_never_converted(monkeypatch):
    monkeypatch.setattr(bp, "_session_seg_path", lambda _sid: "/sessions/abc/combined_labels.nii.gz")
    assert bp._ai_mask_path_for("abc-session") == "/sessions/abc/combined_labels.nii.gz"


def test_new_bake_is_in_viewer_ids_and_marked(dataset):
    response = client().get("/api/cases/35/mesh-manifest")
    assert response.status_code == 200
    manifest = response.get_json()
    assert manifest["labelScheme"] == SCHEME
    by_id = {organ["id"]: organ["key"] for organ in manifest["organs"]}
    assert by_id == {1: "adrenal_gland_left", 3: "aorta", 14: "liver", 19: "pancreas_head",
                     22: "pancreatic_lesion", 23: "postcava", 25: "spleen"}
    assert all(organ["url"].endswith(f".glb?v={SCHEME}") for organ in manifest["organs"])
    lesion = next(o for o in manifest["organs"] if o["id"] == 22)
    assert client().get(lesion["url"]).data[:4] == b"glTF"


def legacy_manifest(case_dir: Path) -> dict:
    """What a bake straight from the raw mask wrote: raw ids, catalog names at that id."""
    case_dir.mkdir(parents=True, exist_ok=True)
    organs = []
    for raw in (14, 22, 24, 25, 28):
        meta = VIEWER_LABELS[raw]
        filename = f"{meta['key']}.glb"
        (case_dir / filename).write_bytes(b"glTF" + bytes([raw]))
        organs.append({"id": raw, "key": meta["key"], "name": meta["name"],
                       "url": f"/api/cases/{CASE}/render_only/{filename}"})
    manifest = {"caseId": CASE, "center": [0, 0, 0], "bounds": {"min": [0, 0, 0], "max": [1, 1, 1]}, "organs": organs}
    (case_dir / "manifest.json").write_text(json.dumps(manifest))
    return manifest


def test_legacy_manifest_is_relabelled_not_rebaked(tmp_path, monkeypatch):
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"))
    case_dir = tmp_path / "meshes" / CASE
    legacy_manifest(case_dir)

    def no_mask(_case_id):
        raise AssertionError("relabelling must not need the mask")

    monkeypatch.setattr(bp, "_ai_local_mask_path", no_mask)
    manifest = client().get("/api/cases/35/mesh-manifest").get_json()
    entries = {organ["id"]: (organ["key"], organ["url"].rsplit("/", 1)[-1]) for organ in manifest["organs"]}
    # Each organ keeps the GLB that holds its geometry.
    assert entries == {
        14: ("liver", f"liver.glb?v={SCHEME}"),
        23: ("postcava", f"pancreatic_lesion.glb?v={SCHEME}"),
        25: ("spleen", f"prostate.glb?v={SCHEME}"),
        26: ("stomach", f"spleen.glb?v={SCHEME}"),
        22: ("pancreatic_lesion", f"veins.glb?v={SCHEME}"),
    }
    assert [organ["id"] for organ in manifest["organs"]] == [14, 22, 23, 25, 26]

    saved = json.loads((case_dir / "manifest.json").read_text())
    assert saved["labelScheme"] == SCHEME
    assert mesh_generation._manifest_is_complete(case_dir / "manifest.json")
    # Served again, the saved copy is not relabelled a second time.
    again = client().get("/api/cases/35/mesh-manifest").get_json()
    assert {organ["id"]: organ["key"] for organ in again["organs"]} == {k: v[0] for k, v in entries.items()}
    assert client().get(f"/api/cases/{CASE}/render_only/veins.glb?v={SCHEME}").data == b"glTF" + bytes([28])


def test_relabel_survives_a_read_only_mesh_mount(tmp_path, monkeypatch):
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"))
    case_dir = tmp_path / "meshes" / CASE
    legacy_manifest(case_dir)
    monkeypatch.setattr(bp, "_ai_local_mask_path", lambda _case_id: None)
    case_dir.chmod(0o500)
    try:
        response = client().get("/api/cases/35/mesh-manifest")
    finally:
        case_dir.chmod(0o700)
    assert response.status_code == 200
    assert {organ["id"]: organ["key"] for organ in response.get_json()["organs"]}[22] == "pancreatic_lesion"
    assert "labelScheme" not in json.loads((case_dir / "manifest.json").read_text())


def test_missing_relabelled_glb_is_rebuilt_as_the_organ_it_draws(tmp_path, monkeypatch):
    monkeypatch.setattr(Constants, "MESH_PATH", str(tmp_path / "meshes"))
    case_dir = tmp_path / "meshes" / CASE
    legacy_manifest(case_dir)
    monkeypatch.setattr(bp, "_ai_local_mask_path", lambda _case_id: "viewer.nii.gz")
    client().get("/api/cases/35/mesh-manifest")
    (case_dir / "spleen.glb").unlink()
    asked = []
    monkeypatch.setattr(bp, "generate_organ_glb_bytes", lambda key, _path: asked.append(key) or b"glTF")
    assert client().get(f"/api/cases/{CASE}/render_only/spleen.glb").status_code == 200
    assert asked == ["stomach"]


def test_live_room_edits_viewer_ids_while_the_quiz_reveals_the_raw_lesion(dataset, tmp_path, monkeypatch):
    store = LiveRoomStore(tmp_path / "sessions", dataset)
    metadata, _key = store.create_room("35", "full")
    room_dir = store.root / metadata["room_id"]
    stored = json.loads((room_dir / "metadata.json").read_text())
    assert stored["base_mask_path"] == str(room_dir / "base_mask_viewer.nii.gz")
    assert stored["source_mask_path"].endswith(f"mask_only/{CASE}/combined_labels.nii.gz")
    base = np.asanyarray(nib.load(stored["base_mask_path"]).dataobj)
    assert set(np.unique(base).tolist()) == {0, 1, 3, 14, 19, 22, 23, 25}

    pack = {"ground_truth": {"lesion_present": True,
                             "reveal_mask": {"kind": "labels", "source_labels": [28], "output_label": 1}}}
    monkeypatch.setattr(store, "_pack_locked", lambda _room_dir, _metadata: pack)
    reveal = np.asanyarray(nib.load(str(store._quiz_mask_locked(room_dir, stored, revealed=True))).dataobj)
    raw = np.rint(np.asanyarray(nib.load(stored["source_mask_path"]).dataobj))
    assert np.array_equal(reveal == 1, raw == 28)


PANTS_DATA = os.environ.get("PANTS_DATA_TEST_PATH")


@pytest.mark.skipif(not PANTS_DATA, reason="set PANTS_DATA_TEST_PATH to a PanTS folder with cases 1 and 3")
@pytest.mark.parametrize("case", ["PanTS_00000001", "PanTS_00000003"])
def test_real_cases_read_anatomically_after_conversion(case):
    source = Path(PANTS_DATA) / "mask_only" / case / "combined_labels.nii.gz"
    image = nib.load(viewer_labelmap_path(source))
    data = np.asanyarray(image.dataobj)

    def centroid_x(label):
        return nib.affines.apply_affine(image.affine, np.argwhere(data == label).mean(axis=0))[0]

    # RAS: +x is the patient's right. The liver and IVC sit right of the spleen and aorta.
    assert centroid_x(VIEWER_IDS["liver"]) > centroid_x(VIEWER_IDS["spleen"])
    assert centroid_x(VIEWER_IDS["postcava"]) > centroid_x(VIEWER_IDS["aorta"])
    lesion_voxels = int(np.count_nonzero(data == VIEWER_IDS["pancreatic_lesion"]))
    if case.endswith("3"):
        assert lesion_voxels * float(np.prod(image.header.get_zooms()[:3])) / 1000 == pytest.approx(5.3, abs=0.2)
    else:
        assert lesion_voxels == 0
        assert not np.any(data == VIEWER_IDS["prostate"])
