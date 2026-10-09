import os
from dotenv import load_dotenv
import numpy as np
from datetime import datetime

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"))


class Constants:
    # app variables
    SESSIONS_DIR_NAME = os.environ.get('SESSIONS_DIR_PATH', 'sessions')

    # Full SQLAlchemy URL, so SQLite -> Postgres later is an env change, not code.
    # Defaults to a local file; prod sets DATABASE_URL outside the repo (.env.example).
    DATABASE_URL = os.environ.get(
        'DATABASE_URL',
        'sqlite:///' + os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pants-dev.db'),
    )

    # Legacy Postgres parts, unused; superseded by DATABASE_URL.
    DB_USER = os.environ.get('DB_USER')
    DB_PASS = os.environ.get('DB_PASS')
    DB_HOST = os.environ.get('DB_HOST')
    DB_NAME = os.environ.get('DB_NAME')

    SCHEDULED_CHECK_INTERVAL = 5  # minutes  

    # api_blueprint variables
    BASE_PATH = os.environ.get('BASE_PATH', '/')
    PANTS_PATH = os.environ.get('PANTS_PATH')
    # Second dataset (CT-only, no masks yet). CV_%08d ids, CSV metadata.
    # Low-res copies live under CANCERVERSE_LOWRES_PATH/image_only/<case>/ct_lowres.nii.gz.
    CANCERVERSE_PATH = os.environ.get('CANCERVERSE_PATH')
    CANCERVERSE_LOWRES_PATH = os.environ.get('CANCERVERSE_LOWRES_PATH', '/home/visitor/cancerverse_lowres')
    DATASET_PREFIXES = {'PanTS': 'PanTS', 'CancerVerse': 'CV'}
    # Where accepted user scans (CT + mask + sublabels) are collected, in a
    # PanTS-mirroring layout (image_only/, mask_only/). Unset => the collection
    # gatekeeper (services/user_dataset.py) is a no-op. Point it at a writable
    # staging dir now; relocate beside PanTS/CancerVerse once write access lands.
    USER_DATASET_PATH = os.environ.get('USER_DATASET_PATH')
    PERMISSIONS_DIR = os.environ.get('PERMISSIONS_DIR', "/home/visitor/data")
    MESH_PATH = os.environ.get('MESH_PATH', os.path.join(PERMISSIONS_DIR, "render_only"))
    CASE_QUALITY_MANIFEST = os.environ.get('BODYMAPS_CASE_QUALITY_MANIFEST')
    THUMBNAIL_VISION_MODEL = os.environ.get(
        'BODYMAPS_THUMBNAIL_VISION_MODEL',
        'qwen3-vl:4b',
    )
    THUMBNAIL_VISION_TIMEOUT_SECONDS = float(
        os.environ.get('BODYMAPS_THUMBNAIL_VISION_TIMEOUT_SECONDS', '120')
    )
    MAIN_NIFTI_FORM_NAME = 'MAIN_NIFTI'
    MAIN_NPZ_FILENAME = 'ct.npz'
    MAIN_NIFTI_FILENAME = 'ct.nii.gz'
    COMBINED_LABELS_FILENAME = 'combined_labels.npz'
    COMBINED_LABELS_NIFTI_FILENAME = 'combined_labels.nii.gz'
    ORGAN_INTENSITIES_FILENAME = 'organ_intensities.json'
    SESSION_TIMEDELTA = 3  # in days

    # NiftiProcessor Variables
    EROSION_PIXELS = 2
    CUBE_LEN = (2 * EROSION_PIXELS) + 1
    STRUCTURING_ELEMENT = np.ones([CUBE_LEN, CUBE_LEN, CUBE_LEN], dtype=bool)

    DECIMAL_PRECISION_VOLUME = 2
    DECIMAL_PRECISION_HU = 1
    VOXEL_THRESHOLD = 100

    MODEL_ALIASES = {
        # GE
        "lightspeed 16": "LightSpeed 16",
        "lightspeed16": "LightSpeed 16",
        "lightspeed vct": "LightSpeed VCT",
        "lightspeed qx/i": "LightSpeed QX/i",
        "lightspeed pro 16": "LightSpeed Pro 16",
        "lightspeed pro 32": "LightSpeed Pro 32",
        "lightspeed plus": "LightSpeed Plus",
        "lightspeed ultra": "LightSpeed Ultra",
        # Siemens
        "somatom definition as+": "SOMATOM Definition AS+",
        "somatom definition as": "SOMATOM Definition AS",
        "somatom definition flash": "SOMATOM Definition Flash",
        "somatom definition edge": "SOMATOM Definition Edge",
        "somatom force": "SOMATOM Force",
        "somatom go.top": "SOMATOM Go.Top",
        "somatom plus 4": "SOMATOM PLUS 4",
        "somatom scope": "SOMATOM Scope",
        "somatom definition": "SOMATOM Definition",
        "sensation 4": "Sensation 4",
        "sensation 10": "Sensation 10",
        "sensation 16": "Sensation 16",
        "sensation 40": "Sensation 40",
        "sensation 64": "Sensation 64",
        "sensation cardiac 64": "Sensation Cardiac 64",
        "sensation open": "Sensation Open",
        "emotion 16": "Emotion 16",
        "emotion 6 (2007)": "Emotion 6 (2007)",
        "perspective": "Perspective",
        # Philips
        "brilliance 10": "Brilliance 10",
        "brilliance 16": "Brilliance 16",
        "brilliance 16p": "Brilliance 16P",
        "brilliance 40": "Brilliance 40",
        "brilliance 64": "Brilliance 64",
        "ingenuity core 128": "Ingenuity Core 128",
        "iqon - spectral ct": "IQon - Spectral CT",
        "philips ct aura": "Philips CT Aura",
        "precedence 16p": "Precedence 16P",
        # Canon / Toshiba
        "aquilion one": "Aquilion ONE",
        "aquilion": "Aquilion",
        # GE 其他
        "optima ct540": "Optima CT540",
        "optima ct660": "Optima CT660",
        "optima ct520 series": "Optima CT520 Series",
        "revolution ct": "Revolution CT",
        "revolution evo": "Revolution EVO",
        "discovery st": "Discovery ST",
        "discovery ste": "Discovery STE",
        "discovery mi": "Discovery MI",
        "hispeed ct/i": "HiSpeed CT/i",
        # PET/CT
        "biograph128": "Biograph128",
        "biograph 128": "Biograph128",
    }
