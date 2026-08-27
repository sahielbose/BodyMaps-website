"""interactive-segment must read the same low-res volumes the viewer serves.

make_lowres.py writes low-res copies under LOWRES_ROOT because the dataset
mount is read-only, and the viewer's volume endpoint reads them from there.
_case_ct_path/_case_mask_path used to look for them beside the originals under
PANTS_PATH, found nothing, and quietly returned full resolution — so on any
deployment where the low-res batch had run, the viewer displayed a half-size
grid while segmentation ran full size, and the client rejected every proposal
with a resolution-mismatch error. These pin the two halves together.
"""
import api.api_blueprint as api_routes
from constants import Constants


CASE_NUM = "35"
CASE_DIR = "PanTS_00000035"


def _dataset(tmp_path, monkeypatch):
    """A read-only-style dataset root plus a separate writable low-res root."""
    pants = tmp_path / "pants"
    lowres = tmp_path / "pants_lowres"
    for sub, name in (("image_only", Constants.MAIN_NIFTI_FILENAME),
                      ("mask_only", Constants.COMBINED_LABELS_NIFTI_FILENAME)):
        full = pants / sub / CASE_DIR / name
        full.parent.mkdir(parents=True)
        full.write_bytes(b"full-res")
        low = lowres / sub / CASE_DIR / name.replace(".nii.gz", "_lowres.nii.gz")
        low.parent.mkdir(parents=True)
        low.write_bytes(b"low-res")
    monkeypatch.setattr(Constants, "PANTS_PATH", str(pants))
    monkeypatch.setattr(api_routes, "LOWRES_ROOT", str(lowres))
    return pants, lowres


def test_low_res_request_finds_the_copy_under_lowres_root(tmp_path, monkeypatch):
    _, lowres = _dataset(tmp_path, monkeypatch)

    ct = api_routes._case_ct_path(CASE_NUM, low=True)
    mask = api_routes._case_mask_path(CASE_NUM, low=True)

    assert ct == str(lowres / "image_only" / CASE_DIR / "ct_lowres.nii.gz")
    assert mask == str(
        lowres / "mask_only" / CASE_DIR / "combined_labels_lowres.nii.gz")


def test_low_res_request_matches_what_the_viewer_serves(tmp_path, monkeypatch):
    """The whole point: both halves of the feature land on one voxel grid."""
    _, lowres = _dataset(tmp_path, monkeypatch)

    viewer_path = (f"{api_routes.LOWRES_ROOT}/image_only/{CASE_DIR}/"
                   f"{Constants.MAIN_NIFTI_FILENAME.replace('.nii.gz', '_lowres.nii.gz')}")

    assert api_routes._case_ct_path(CASE_NUM, low=True) == viewer_path


def test_full_res_request_still_reads_the_dataset_mount(tmp_path, monkeypatch):
    pants, _ = _dataset(tmp_path, monkeypatch)

    assert api_routes._case_ct_path(CASE_NUM, low=False) == str(
        pants / "image_only" / CASE_DIR / Constants.MAIN_NIFTI_FILENAME)
    assert api_routes._case_mask_path(CASE_NUM, low=False) == str(
        pants / "mask_only" / CASE_DIR / Constants.COMBINED_LABELS_NIFTI_FILENAME)


def test_falls_back_to_full_res_when_the_batch_has_not_run(tmp_path, monkeypatch):
    """Low-res is additive: absent files must not break anything."""
    pants, lowres = _dataset(tmp_path, monkeypatch)
    for sub, name in (("image_only", "ct_lowres.nii.gz"),
                      ("mask_only", "combined_labels_lowres.nii.gz")):
        (lowres / sub / CASE_DIR / name).unlink()

    assert api_routes._case_ct_path(CASE_NUM, low=True) == str(
        pants / "image_only" / CASE_DIR / Constants.MAIN_NIFTI_FILENAME)
    assert api_routes._case_mask_path(CASE_NUM, low=True) == str(
        pants / "mask_only" / CASE_DIR / Constants.COMBINED_LABELS_NIFTI_FILENAME)


def test_colocated_low_res_copies_are_still_found(tmp_path, monkeypatch):
    """Some setups put the low-res copies beside the originals; honor that too."""
    pants, lowres = _dataset(tmp_path, monkeypatch)
    for sub, name in (("image_only", "ct_lowres.nii.gz"),
                      ("mask_only", "combined_labels_lowres.nii.gz")):
        (lowres / sub / CASE_DIR / name).unlink()
        (pants / sub / CASE_DIR / name).write_bytes(b"low-res-colocated")

    assert api_routes._case_ct_path(CASE_NUM, low=True) == str(
        pants / "image_only" / CASE_DIR / "ct_lowres.nii.gz")


def test_case_id_is_still_sanitized(tmp_path, monkeypatch):
    """The traversal guard has to survive the refactor."""
    _dataset(tmp_path, monkeypatch)
    for bad in ("../etc", "1/../..", "abc", ""):
        try:
            api_routes._case_ct_path(bad, low=True)
        except ValueError:
            continue
        raise AssertionError(f"{bad!r} should have been rejected")
