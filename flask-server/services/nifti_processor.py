import nibabel as nib
import numpy as np
from constants import Constants
from services.label_scheme import VIEWER_LABELS
from werkzeug.datastructures import MultiDict
import scipy.ndimage as ndimage
import os
import tempfile
from scipy.ndimage import label
from scipy.stats import skew, kurtosis
import builtins

def has_large_connected_component(slice_mask, threshold=8):
    """
    Check if there is a connected component larger than a threshold in a 2D mask.
    """
    labeled, num_features = label(slice_mask)
    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0  # ignore background
    return np.any(sizes > threshold)

def voxel_to_world(affine: np.ndarray, voxel_coord) -> list[float]:
    """
    Convert a voxel coordinate [i, j, k] into a NIFTI world coordinate
    using the image affine.
    """
    world_coord = nib.affines.apply_affine(
        affine,
        np.asarray(voxel_coord, dtype=np.float64)
    )

    return [round(float(value), 3) for value in world_coord]

class NiftiProcessor:
    def __init__(self, main_nifti_path, clabel_path, organ_intensities=None):
        self._main_nifti_path = main_nifti_path
        self._clabel_path = clabel_path
        self.number_max = 999999
        self._organ_intensities = organ_intensities

    def set_organ_intensities(self, organ_intensities):
        self._organ_intensities = organ_intensities

    @classmethod
    def from_clabel_path(cls, clabel_path):
        return cls(None, clabel_path)

    def calculate_metrics(self):
        if (
            self._organ_intensities is None
            or self._clabel_path is None
            or self._main_nifti_path is None
        ):
            raise Exception(
                "Cannot calculate metrics if self._organ_intensities, "
                "self._clabel_path, or self._main_nifti_path is None."
            )

        if not isinstance(self._organ_intensities, dict):
            raise TypeError(
                "self._organ_intensities must be a dict like "
                f"{{'liver': 14}}, got {type(self._organ_intensities)}: "
                f"{repr(self._organ_intensities)[:500]}"
            )

        clabel_obj = nib.load(self._clabel_path)
        main_nifti_obj = nib.load(self._main_nifti_path)

        labels_raw = np.asanyarray(clabel_obj.dataobj)
        labels = np.rint(labels_raw).astype(np.int32, copy=True)

        hu_raw = np.asanyarray(main_nifti_obj.dataobj)
        hu = np.asanyarray(main_nifti_obj.dataobj).astype(np.float64, copy=True)

        if labels.shape != hu.shape:
            raise ValueError(
                "The segmentation and main NIFTI image must have the same shape. "
                f"Segmentation shape: {labels.shape}; main image shape: {hu.shape}"
            )

        main_affine = main_nifti_obj.affine

        voxel_volume_mm3 = float(abs(np.linalg.det(clabel_obj.affine[:3, :3])))
        voxel_volume_cm3 = voxel_volume_mm3 / 1000.0

        data = {"organ_metrics": []}

        max_label = int(labels.max())

        # Fast volume count for every label in one pass.
        voxel_counts = np.bincount(labels.ravel(), minlength=max_label + 1)

        # Only work with labeled voxels, not the entire CT repeatedly.
        label_flat = labels.ravel()
        hu_flat = hu.ravel()

        nonzero_mask = label_flat > 0
        nonzero_labels = label_flat[nonzero_mask]
        nonzero_hu = hu_flat[nonzero_mask]
        nonzero_flat_indices = np.flatnonzero(nonzero_mask)

        # Sort labeled voxels by label so each organ is one contiguous range.
        order = np.argsort(nonzero_labels)
        sorted_labels = nonzero_labels[order]
        sorted_hu = nonzero_hu[order]
        sorted_flat_indices = nonzero_flat_indices[order]

        unique_labels, starts = np.unique(sorted_labels, return_index=True)
        ends = np.r_[starts[1:], len(sorted_labels)]

        label_to_range = {
            int(label): (int(start), int(end))
            for label, start, end in zip(unique_labels, starts, ends)
        }

        for organ, label_val in self._organ_intensities.items():
            label_val = int(label_val)

            voxel_count = int(voxel_counts[label_val]) if label_val <= max_label else 0

            if voxel_count == 0 or label_val not in label_to_range:
                data["organ_metrics"].append({
                    "organ_name": organ,
                    "min_value": None,
                    "min_coord": None,
                    "max_value": None,
                    "max_coord": None,
                    "mean_value": None,
                    "mean_hu": None,
                    "standard_deviation": None,
                    "voxel_count": 0,
                    "median": None,
                    "skewness": None,
                    "kurtosis": None,
                    "volume_mm3": 0.0,
                    "volume_cm3": 0.0,
                    "center": None,
                    "truncated": False,
                })
                continue

            # Check truncation only on first/last slices, not full volume.
            slice_0_mask = labels[:, :, 0] == label_val
            slice_last_mask = labels[:, :, -1] == label_val

            truncated = builtins.bool(
                has_large_connected_component(slice_0_mask, 8)
                or has_large_connected_component(slice_last_mask, 8)
            )

            start, end = label_to_range[label_val]

            organ_values = sorted_hu[start:end]
            organ_flat_indices = sorted_flat_indices[start:end]

            finite_mask = np.isfinite(organ_values)
            finite_values = organ_values[finite_mask]

            volume_mm3 = voxel_count * voxel_volume_mm3
            volume_cm3 = voxel_count * voxel_volume_cm3

            # Compute center using all voxels in this organ.
            organ_coords = np.column_stack(
                np.unravel_index(organ_flat_indices, labels.shape)
            )
            center_voxel_coord = organ_coords.mean(axis=0)

            if finite_values.size == 0:
                data["organ_metrics"].append({
                    "organ_name": organ,
                    "min_value": None,
                    "min_coord": None,
                    "max_value": None,
                    "max_coord": None,
                    "mean_value": None,
                    "mean_hu": None,
                    "standard_deviation": None,
                    "voxel_count": voxel_count,
                    "median": None,
                    "skewness": None,
                    "kurtosis": None,
                    "volume_mm3": round(volume_mm3, Constants.DECIMAL_PRECISION_VOLUME),
                    "volume_cm3": round(volume_cm3, Constants.DECIMAL_PRECISION_VOLUME),
                    "center": voxel_to_world(main_affine, center_voxel_coord),
                    "truncated": builtins.bool(truncated),
                    "center_voxel_coord": [
                        round(float(value), 3) for value in center_voxel_coord
                    ],
                })
                continue

            finite_flat_indices = organ_flat_indices[finite_mask]

            min_index = int(np.argmin(finite_values))
            max_index = int(np.argmax(finite_values))

            min_voxel_coord = np.array(
                np.unravel_index(finite_flat_indices[min_index], labels.shape)
            )
            max_voxel_coord = np.array(
                np.unravel_index(finite_flat_indices[max_index], labels.shape)
            )

            mean_value = float(np.mean(finite_values))
            standard_deviation = float(np.std(finite_values, ddof=0))
            median_value = float(np.median(finite_values))

            if finite_values.size < 3 or standard_deviation == 0:
                skewness_value = 0.0
            else:
                skewness_value = float(skew(finite_values, bias=False))

            if finite_values.size < 4 or standard_deviation == 0:
                kurtosis_value = 0.0
            else:
                kurtosis_value = float(
                    kurtosis(finite_values, fisher=False, bias=False)
                )

            metrics = {
                "organ_name": organ,

                "min_value": round(float(finite_values[min_index]), 3),
                "min_coord": voxel_to_world(main_affine, min_voxel_coord),

                "max_value": round(float(finite_values[max_index]), 3),
                "max_coord": voxel_to_world(main_affine, max_voxel_coord),

                "mean_value": round(mean_value, 3),
                "mean_hu": round(mean_value, 3),
                "standard_deviation": round(standard_deviation, 3),
                "voxel_count": voxel_count,
                "median": round(median_value, 3),
                "skewness": round(skewness_value, 3),
                "kurtosis": round(kurtosis_value, 3),

                "volume_mm3": round(volume_mm3, Constants.DECIMAL_PRECISION_VOLUME),
                "volume_cm3": round(volume_cm3, Constants.DECIMAL_PRECISION_VOLUME),

                "center": voxel_to_world(main_affine, center_voxel_coord),

                "truncated": bool(truncated),

                "min_voxel_coord": [int(value) for value in min_voxel_coord],
                "max_voxel_coord": [int(value) for value in max_voxel_coord],
                "center_voxel_coord": [
                    round(float(value), 3) for value in center_voxel_coord
                ],
            }

            data["organ_metrics"].append(metrics)

        return data
    def calculate_mean_hu_with_erosion(self, binary_mask, ct_array):
        """
        Calculate mean HU using erosion to avoid edge noise.
        """
        erosion_array = ndimage.binary_erosion(binary_mask, structure=Constants.STRUCTURING_ELEMENT)
        hu_values = ct_array[erosion_array > 0]

        if hu_values.size == 0:
            hu_values = ct_array[binary_mask > 0]

        if hu_values.size == 0:
            return 0

        return round(float(np.mean(hu_values)), Constants.DECIMAL_PRECISION_HU)

    def clean_organ_name(filename: str) -> str:
        name = os.path.basename(filename)

        if name.endswith(".nii.gz"):
            return name[:-7]
        if name.endswith(".nii"):
            return name[:-4]

        return os.path.splitext(name)[0]


    def load_uploaded_nifti(self, file_storage):
        """
        Safely load a Flask/Werkzeug uploaded NIfTI file on Windows.
        """
        file_storage.stream.seek(0)
        data = file_storage.read()

        if not data:
            raise ValueError(f"Uploaded file {file_storage.filename} is empty or already read")

        temp_path = None

        try:
            # delete=False + close-before-reopen: Windows won't let nib.load
            # open a NamedTemporaryFile that's still held open by this process.
            with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as temp:
                temp.write(data)
                temp.flush()
                temp_path = temp.name

            nifti_obj = nib.load(temp_path)
            img_data = nifti_obj.get_fdata()
            affine = nifti_obj.affine
            header = nifti_obj.header.copy()
        finally:
            if temp_path is not None and os.path.exists(temp_path):
                os.remove(temp_path)

        return img_data, affine, header

    def combine_labels(self, filenames: list[str], nifti_multi_dict: MultiDict, save=True):
        """
        Merge multiple label masks into one combined segmentation and re-index the labels.
        """
        organ_intensities = {}

        if not filenames:
            raise ValueError("No NIFTI label files were provided.")

        # In case caller accidentally passes list(nifti_multi_dict.items())
        if isinstance(filenames[0], tuple):
            filenames = [item[0] for item in filenames]

        if len(filenames) == 1:
            filename = filenames[0]
            segmentation = nifti_multi_dict[filename]

            img_data, affine, header = self.load_uploaded_nifti(segmentation)

            combined_labels_img_data = np.rint(img_data).astype(np.uint16)

            unique_labels = sorted(
                int(v) for v in np.unique(combined_labels_img_data)
                if int(v) != 0
            )

            original_to_new = {}

            for new_label, original_label in enumerate(unique_labels, start=1):
                original_to_new[original_label] = new_label
                combined_labels_img_data[combined_labels_img_data == original_label] = new_label

            # An uploaded labelmap is expected in the viewer's organ ids.
            for original_label, new_label in original_to_new.items():
                organ_name = VIEWER_LABELS.get(original_label, {}).get(
                    "key",
                    f"label_{original_label}"
                )

                organ_intensities[str(organ_name)] = int(new_label)

            header.set_data_dtype(np.uint16)

            combined_labels = nib.Nifti1Image(
                combined_labels_img_data.astype(np.uint16, copy=False),
                affine=affine,
                header=header,
            )

            combined_labels.set_data_dtype(np.uint16)

        else:
            combined_labels_img_data = None
            combined_labels_header = None
            combined_labels_affine = None
            expected_shape = None

            for i, filename in enumerate(filenames):
                segmentation = nifti_multi_dict[filename]

                img_data, affine, header = self.load_uploaded_nifti(segmentation)

                if expected_shape is None:
                    expected_shape = img_data.shape
                elif img_data.shape != expected_shape:
                    raise ValueError(
                        f"Shape mismatch for {filename}: "
                        f"expected {expected_shape}, got {img_data.shape}"
                    )

                if combined_labels_header is None:
                    combined_labels_header = header.copy()

                if combined_labels_affine is None:
                    combined_labels_affine = affine.copy()

                if combined_labels_img_data is None:
                    combined_labels_img_data = np.zeros(img_data.shape, dtype=np.uint16)

                label_value = i + 1

                mask = img_data > 0

                # If masks overlap, later files overwrite earlier files.
                combined_labels_img_data[mask] = label_value

                organ_name = self.clean_organ_name(filename)
                organ_intensities[organ_name] = label_value

            combined_labels_header.set_data_dtype(np.uint16)

            combined_labels = nib.Nifti1Image(
                combined_labels_img_data.astype(np.uint16, copy=False),
                affine=combined_labels_affine,
                header=combined_labels_header,
            )

            combined_labels.set_data_dtype(np.uint16)

        if save:
            nib.save(combined_labels, self._clabel_path)

        return combined_labels, organ_intensities

    def __str__(self):
        return f"NiftiProcessor Object\n main_nifti_path: {self._main_nifti_path}\n clabel_path: {self._clabel_path}"

    def calculate_pdac_sma_staging(self):
        """
        Determine staging of pancreatic cancer based on SMA contact ratio.
        """
        if self._clabel_path is None:
            raise Exception("clabel path is not set.")

        clabel_obj = nib.load(self._clabel_path)
        clabel_data = np.around(clabel_obj.get_fdata()).astype(np.uint8)

        PDAC_LABEL = 20  # pancreatic_pdac
        SMA_LABEL = 26   # superior_mesenteric_artery

        pdac_mask = (clabel_data == PDAC_LABEL)
        sma_mask = (clabel_data == SMA_LABEL)

        if np.sum(pdac_mask) == 0:
            return "Stage T1 (No PDAC tumor present)"
        if np.sum(sma_mask) == 0:
            return "Unknown (SMA not found)"

        pdac_dilated = ndimage.binary_dilation(pdac_mask, structure=Constants.STRUCTURING_ELEMENT)
        contact_voxels = pdac_dilated & sma_mask
        contact_ratio = np.sum(contact_voxels) / np.sum(sma_mask)

        if contact_ratio > 0.7:
            return "Stage T4 (SMA encasement > 180°)"
        elif contact_ratio > 0.3:
            return "Stage T3 (SMA encasement ~90°–180°)"
        elif contact_ratio > 0:
            return "Stage T2 (SMA contact < 90°)"
        else:
            return "Stage T1 (No SMA contact)"