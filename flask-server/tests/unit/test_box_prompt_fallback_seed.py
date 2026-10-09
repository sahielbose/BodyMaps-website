"""A box prompt that falls back to region_grow seeds at the box centre.

The client sends the drag-start corner as point_lps; growing from it would
band on the fat or air outside the organ the user boxed.
"""

import numpy as np

import services.advanced_analysis as analysis


# LPS -> RAS flips x and y, so this affine makes lps equal voxel indices.
AFFINE = np.diag([-1.0, -1.0, 1.0, 1.0])


def _ct():
    ct = np.full((40, 40, 40), -100.0, dtype=np.float32)  # fat around
    ct[10:30, 10:30, 10:30] = 60.0  # the boxed organ
    return ct


def test_a_box_fallback_grows_the_boxed_organ_not_the_corner_tissue(monkeypatch):
    monkeypatch.setattr(analysis, "USE_NNINTERACTIVE", False)
    ct = _ct()
    prompt = {
        "point_ijk": [8, 8, 8],  # drag-start corner, in fat
        "box_lps": [[8, 8, 8], [31, 31, 31]],
    }
    mask, bbox = analysis.segment_from_prompt(ct, AFFINE, prompt)
    assert bbox is None
    assert mask[20, 20, 20] == 1
    assert mask[9, 9, 9] == 0
    assert int(mask.sum()) == 20 ** 3


def test_a_point_prompt_fallback_still_seeds_at_the_click(monkeypatch):
    monkeypatch.setattr(analysis, "USE_NNINTERACTIVE", False)
    ct = _ct()
    mask, _ = analysis.segment_from_prompt(ct, AFFINE, {"point_ijk": [20, 20, 20]})
    assert int(mask.sum()) == 20 ** 3
