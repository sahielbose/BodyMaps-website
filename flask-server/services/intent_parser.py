from __future__ import annotations

import re
from typing import Any

ALLOWED_ACTION_TYPES = {
    "isolate_organs",
    "show_organs",
    "hide_organs",
    "focus_organ",
    "get_organ_metric",
    "set_opacity",
    "set_window",
    "set_window_preset",
    "set_zoom",
    "zoom_to_fit",
    "set_view",
    "activate_measurement_tool",
    "clear_measurements",
    "list_structures",
    "get_structure_count",
    "get_largest_structure",
    "get_smallest_structure",
}

ALLOWED_VIEW_MODES = {"mpr", "axial", "sagittal", "coronal", "3d"}
ALLOWED_PRESETS = {"soft_tissue", "bone", "lung", "liver"}
ALLOWED_METRICS = {"volume_cm3", "mean_hu", "all"}
ALLOWED_TOOLS = {"distance", "probe", "roi"}
# The viewer's zoom range, the same as MIN_ZOOM and MAX_ZOOM in
# PanTS-Demo/src/helpers/viewer/useKeyboardShortcuts.ts. The confirmation sentence
# quotes the value, so a wider range here would claim a zoom the panes never show.
MIN_ZOOM = 0.2
MAX_ZOOM = 8

ORGAN_SYNONYMS = {
    "liver": ["liver", "hepatic"],
    "pancreas": ["pancreas", "pancreatic"],
    "spleen": ["spleen", "splenic"],
    "kidney_left": ["left kidney", "kidney left", "left renal"],
    "kidney_right": ["right kidney", "kidney right", "right renal"],
    "stomach": ["stomach", "gastric"],
    "duodenum": ["duodenum"],
    "colon": ["colon", "large intestine"],
    "intestine": ["intestine", "small intestine", "bowel"],
    "bladder": ["bladder", "urinary bladder"],
    "gall_bladder": ["gall bladder", "gallbladder"],
    "aorta": ["aorta"],
    "postcava": ["postcava", "vena cava", "inferior vena cava", "ivc"],
    "adrenal_gland_left": ["left adrenal", "left adrenal gland"],
    "adrenal_gland_right": ["right adrenal", "right adrenal gland"],
    "femur_left": ["left femur"],
    "femur_right": ["right femur"],
    "prostate": ["prostate"],
    "celiac_artery": ["celiac artery"],
    "superior_mesenteric_artery": ["superior mesenteric artery", "sma"],
    "common_bile_duct": ["common bile duct", "bile duct"],
    "veins": ["veins", "vein"],
}


def _normalize(text: str) -> str:
    value = text.lower().strip()
    value = value.replace("hounsfield units", "hu").replace("hounsfield unit", "hu")
    value = value.replace("3 d", "3d")
    cleaned = []
    for index, char in enumerate(value):
        # A "." stays in front of a digit ("0.5", ".5"); at the end of a sentence
        # it would glue itself to the last word ("isolate the liver.").
        decimal_point = char == "." and index < len(value) - 1 and value[index + 1].isdigit() and (index == 0 or not value[index - 1].isalpha())
        if char.isalnum() or char.isspace() or char in {"%", "-"} or decimal_point:
            cleaned.append(char)
        else:
            cleaned.append(" ")
    return " ".join("".join(cleaned).split())


def _pretty_organ(value: str) -> str:
    return value.replace("_", " ").title()


def _contains_any(text: str, terms: list[str]) -> bool:
    return any(term in text for term in terms)


def _has_word(text: str, words: list[str]) -> bool:
    """Whole-word test, so "mpr" is not found in "comprehensive" or "roi" in "microinvasive"."""
    return any(_has_phrase(text, word) for word in words)


# Words that open a question. A message that starts with one asks about the
# scan, it does not tell the viewer to change. "can", "could", "would" and
# "will" are here too; "can you", "could we", "would you" and "will I" are
# polite commands and are handled before this test.
_QUESTION_OPENERS = {
    "what", "whats", "is", "are", "was", "were", "does", "do", "did",
    "how", "why", "which", "where", "when", "who",
    "should", "would", "could", "can", "will", "shall", "has", "have", "had",
    "any", "explain", "describe",
}
_COMMAND_LEADS = r"(?:(?:please|kindly|can you|could you|would you|will you|now|then|and|also|just)\s+)*"
# Filler a person puts in front of a clause without changing what it is.
_FILLER_LEAD = re.compile(r"^(?:(?:please|kindly|now|ok|okay|and|then|also|just|hey|hi|thanks|thank you|so|well)\s+)+")
# "Can you ...", "Could we ...", "May I ..." and "Is there a way to ..." ask for
# a change politely; what follows decides whether it is a command or a question.
# "Would I ..." and "Will we ..." ask what would happen, so they stay questions.
_POLITE_LEAD = re.compile(r"^(?:(?:can|could|would|will) you|(?:can|could|may) (?:we|i)|is there (?:a|any|some) way to)\b\s*")
# Phrasings that ask for a change in question form ("what about only showing
# the liver?"). They are commands, so the question rules leave them alone.
_SUGGESTION_LEAD = re.compile(r"^(?:what about|how about|what if|is it possible to)\b")
# A verb that tells the viewer what to do. A clause that opens with one is a
# command even when it ends with a question mark ("Hide the spleen?").
_COMMAND_OPENER = re.compile(
    r"^(?:show|hide|isolate|zoom|display|highlight|switch|use|set|apply|enable|activate|turn|remove|segment|"
    r"focus|center|centre|go|jump|navigate|reset|clear|measure|make|change|increase|decrease|raise|lower|"
    r"reduce|select|open|start|fit|bring|only|keep|toggle)\b"
)
# A conjunction that starts a new clause because a question follows it
# ("isolate the liver and tell me its volume"). "any" is left out: "and any
# fat" is more often part of a list than a new question.
_QUESTION_CLAUSE_SPLIT = re.compile(
    r"\s*(?:[,;]|\b(?:and|then|but|also)\b)\s+(?=(?:what|how|why|which|where|when|who|is|are|does|did|tell me|explain|describe|give me)\b)",
    re.IGNORECASE,
)
# Actions that change what the viewer shows. A question never runs these; the
# read-only ones (counts, lists, organ metrics) still answer it.
_VIEWER_CHANGING_ACTIONS = {
    "isolate_organs", "show_organs", "hide_organs", "focus_organ",
    "set_opacity", "set_window", "set_window_preset", "set_zoom", "zoom_to_fit",
    "set_view", "activate_measurement_tool", "clear_measurements",
}


def _opens_question(text: str) -> bool:
    tokens = text.split()
    return bool(tokens) and (tokens[0] in _QUESTION_OPENERS or text.startswith("tell me"))


def _strip_leads(norm: str) -> str:
    """The clause without the filler and polite leads in front of it ("ok, could we remove the spleen" becomes "remove the spleen")."""
    rest = _FILLER_LEAD.sub("", norm, count=1)
    polite = _POLITE_LEAD.match(rest)
    if polite:
        rest = _FILLER_LEAD.sub("", rest[polite.end():], count=1)
    return rest


def _clause_kind(norm: str, asked: bool) -> str:
    """"question", "command" or "other" for one clause of a message.

    `asked` is true when a question mark ends the clause. It makes a clause with
    no recognised opener a question, but never one that opens with a command verb.
    """
    rest = _FILLER_LEAD.sub("", norm, count=1)
    if _SUGGESTION_LEAD.match(rest):
        return "command"
    polite = _POLITE_LEAD.match(rest)
    if polite:
        # "Can you show the liver?" is a command; "Can you tell me about the liver?" is not.
        rest = _FILLER_LEAD.sub("", rest[polite.end():], count=1)
        return "question" if _opens_question(rest) else "command"
    if _opens_question(rest):
        return "question"
    if _COMMAND_OPENER.match(rest):
        return "command"
    return "question" if asked else "other"


def _classified_clauses(message: str) -> list[tuple[str, str]]:
    """Split a message into sentences, and a sentence into clauses at a conjunction that starts a question.

    Returns (normalized clause, kind) pairs. The question mark belongs to the
    last clause of its sentence.
    """
    clauses = []
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", message):
        if not sentence.strip():
            continue
        asked = re.search(r"\?[\s!.\"')]*$", sentence) is not None
        parts = _QUESTION_CLAUSE_SPLIT.split(sentence)
        for index, part in enumerate(parts):
            norm = _normalize(part)
            if norm:
                clauses.append((norm, _clause_kind(norm, asked and index == len(parts) - 1)))
    return clauses


def is_question(message: str, norm: str) -> bool:
    """True when the message asks about the scan instead of telling the viewer what to do.

    `message` is the original text, because `_normalize` strips the question mark.
    A message that mixes a command with a question is not a question as a whole;
    `parse_intent` keeps the viewer actions of its command clauses only.
    """
    kinds = [kind for _, kind in _classified_clauses(message)]
    if not kinds:
        return _clause_kind(norm, message.rstrip().endswith("?")) == "question"
    return "question" in kinds and "command" not in kinds


def _imperative(norm: str, verbs: list[str]) -> bool:
    """A verb used as a command: the message opens with it, or it follows a filler or polite lead such as "ok", "could we" or "and"."""
    alternatives = "|".join(re.escape(verb) for verb in verbs)
    return re.search(rf"^{_COMMAND_LEADS}(?:{alternatives})\b", _strip_leads(norm)) is not None or re.search(rf"\b(?:and|then|also|please)\s+(?:{alternatives})\b", norm) is not None


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _has_phrase(text: str, phrase: str) -> bool:
    return f" {phrase} " in f" {text} "


def _parse_float_token(token: str) -> float | None:
    value = token.strip().strip("%")
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _number_after_terms(text: str, terms: list[str], scan_tokens: int = 5) -> float | None:
    tokens = text.split()
    for term in terms:
        term_tokens = term.split()
        term_len = len(term_tokens)
        for index in range(0, len(tokens) - term_len + 1):
            if tokens[index:index + term_len] == term_tokens:
                start = index + term_len
                end = min(len(tokens), start + scan_tokens)
                for candidate in tokens[start:end]:
                    number = _parse_float_token(candidate)
                    if number is not None:
                        return number
    return None


def _organ_aliases_for_available(organ: str) -> list[str]:
    aliases = set()
    base = _normalize(organ).replace(" ", "_")
    spaced = base.replace("_", " ")
    aliases.add(base)
    aliases.add(spaced)
    if base in ORGAN_SYNONYMS:
        aliases.update(ORGAN_SYNONYMS[base])
    parts = base.split("_")
    if len(parts) == 2 and parts[1] in {"left", "right"}:
        aliases.add(f"{parts[1]} {parts[0]}")
    if len(parts) >= 3 and parts[-1] in {"left", "right"}:
        aliases.add(f"{parts[-1]} {' '.join(parts[:-1])}")
    return sorted(aliases, key=len, reverse=True)


def _match_organs(text: str, available_organs: list[str]) -> list[str]:
    norm = _normalize(text)
    matched = []
    if any(phrase in norm for phrase in ["kidneys", "both kidneys", "both kidney"]):
        for organ in available_organs:
            if "kidney" in _normalize(organ) and organ not in matched:
                matched.append(organ)
    for organ in available_organs:
        for alias in _organ_aliases_for_available(organ):
            normalized_alias = _normalize(alias.replace("_", " "))
            if normalized_alias and _has_phrase(norm, normalized_alias):
                if organ not in matched:
                    matched.append(organ)
                break
    if not matched:
        words = set(norm.split())
        for organ in available_organs:
            organ_words = set(_normalize(organ).split()) - {"left", "right", "the", "and"}
            if organ_words and organ_words.issubset(words):
                matched.append(organ)
    return matched


def _educational_answer(norm: str) -> str | None:
    if _contains_any(norm, ["what is a ct scan", "what is ct scan", "explain ct scan", "computed tomography"]):
        return "A CT scan, or computed tomography scan, uses X-rays taken from multiple angles and computer processing to create cross-sectional images of the body. In this viewer, the CT image is shown with segmented anatomical structures overlaid in color."
    if _contains_any(norm, ["what is segmentation", "what does segmentation mean", "segmented structure", "segmented organ"]):
        return "Segmentation means labeling specific anatomical structures in the scan, such as the liver, spleen, pancreas, kidneys, vessels, or bones. The colored overlays represent those segmented regions so you can see where each structure is located."
    if _contains_any(norm, ["colored overlay", "colored overlays", "what are the colors", "what do the colors mean"]):
        return "The colored overlays are segmentation masks. Each color corresponds to a different labeled structure in the CT scan. They help separate organs and anatomical regions from the grayscale CT image."
    if _contains_any(norm, ["what is hu", "what are hu", "hounsfield", "mean hu"]):
        return "HU stands for Hounsfield Unit. It is a CT intensity scale where air is very low, water is around 0, soft tissues fall in intermediate ranges, and dense bone is high. Mean HU is the average CT intensity inside a selected organ or region."
    if _contains_any(norm, ["what is roi", "roi tool", "region of interest"]):
        return "ROI means region of interest. In medical imaging, an ROI is an area selected for measurement. In this viewer, the ROI tool lets you draw a region on the CT image."
    if _contains_any(norm, ["distance tool", "measure distance", "distance measurement"]):
        return "The distance tool lets you click two points in the CT viewer to measure the distance between them. This is useful for estimating sizes or spacing between structures."
    if _contains_any(norm, ["brightness", "contrast", "windowing", "window level", "window width", "ct window"]):
        return "CT windowing controls how grayscale intensities are displayed. Window width mainly affects contrast, while window center affects brightness. Presets such as soft tissue, bone, lung, and liver make different tissues easier to see."
    if "bone window" in norm:
        return "A bone window uses a wide CT window to make dense structures like bone easier to see."
    if "lung window" in norm:
        return "A lung window is optimized for air-filled lung tissue and low-density structures."
    if "soft tissue window" in norm:
        return "A soft tissue window is designed to show organs, muscles, vessels, and other soft tissues more clearly."
    if _contains_any(norm, ["axial", "sagittal", "coronal", "mpr"]):
        return "Axial, sagittal, and coronal are standard CT viewing planes. Axial shows slices across the body, sagittal shows side views, and coronal shows front-facing views. MPR means multiplanar reconstruction, where these views are shown together."
    if _contains_any(norm, ["3d view", "3d segmentation", "three dimensional"]):
        return "The 3D view shows the segmented anatomy as a three-dimensional model. It helps show the spatial relationship between structures."
    if _contains_any(norm, ["how do i move through", "move through ct slices", "scroll through slices", "navigate slices"]):
        return "To move through CT slices, scroll over a 2D CT pane or use the viewer navigation controls. The crosshair helps link the axial, sagittal, and coronal views."
    if "crosshair" in norm:
        return "The crosshair marks a shared location across the CT views. Moving it in one plane helps locate the same point in the axial, sagittal, coronal, and 3D views."
    organ_answers = {
        "liver": "The liver is a large organ in the upper abdomen. It helps process nutrients, produce bile, store energy, and filter substances from the blood.",
        "pancreas": "The pancreas is an abdominal organ involved in digestion and blood sugar regulation. It produces digestive enzymes and hormones such as insulin.",
        "spleen": "The spleen helps filter blood, supports immune function, and manages blood cells. It is located in the upper left abdomen.",
        "kidney": "The kidneys filter blood, remove waste products, regulate fluid balance, and help control blood pressure. Most people have a left and right kidney.",
        "stomach": "The stomach stores food, mixes it with acid and enzymes, and begins digestion.",
        "colon": "The colon, or large intestine, absorbs water and helps form and move stool through the digestive tract.",
        "intestine": "The intestines are part of the digestive system. The small intestine absorbs nutrients, while the large intestine absorbs water and helps form stool.",
        "bladder": "The bladder stores urine before it leaves the body. It sits in the pelvis and expands as it fills.",
        "gallbladder": "The gallbladder stores bile produced by the liver and releases it to help digest fats.",
        "aorta": "The aorta is the main artery that carries oxygen-rich blood from the heart to the rest of the body.",
        "adrenal": "The adrenal glands sit above the kidneys and produce hormones involved in stress response, blood pressure, and metabolism.",
        "femur": "The femur is the thigh bone and is one of the strongest and largest bones in the body.",
        "prostate": "The prostate is a gland in the male pelvis that contributes fluid to semen.",
        "duodenum": "The duodenum is the first part of the small intestine. It receives partially digested food from the stomach and digestive juices from the pancreas and bile ducts.",
    }
    for key, answer in organ_answers.items():
        if f"what does the {key}" in norm or f"what is the {key}" in norm or f"function of the {key}" in norm or f"explain the {key}" in norm or f"tell me about the {key}" in norm:
            return answer
    if _contains_any(norm, ["what can you do", "help", "commands", "how can you help"]):
        return "I can explain CT and anatomy concepts, isolate organs, show or hide structures, change opacity, adjust CT window settings, activate ROI or distance tools, list segmented structures, and retrieve available organ metrics."
    return None


def _unsafe_medical_request(norm: str) -> bool:
    patterns = [
        "do i have",
        "does this show cancer",
        "is this cancer",
        "is this tumor",
        "is it malignant",
        "is it benign",
        "what disease do i have",
        "diagnose",
        "diagnosis",
        "treatment",
        "what should i take",
        "am i sick",
        "is this normal",
        "is this abnormal",
        "interpret this scan",
        "read this scan",
    ]
    return any(pattern in norm for pattern in patterns)


def _unsafe_reply() -> dict[str, Any]:
    return {
        "reply": "I can't diagnose, interpret disease, determine whether something is cancer, or recommend treatment from this scan. A radiologist or qualified clinician should review the imaging and clinical history. I can still explain CT concepts or help you visualize and measure segmented structures.",
        "actions": [],
        "source": "hardcoded",
        "intent": "unsafe_medical_request",
    }


def _parse_case_data_question(norm: str) -> dict[str, Any] | None:
    if _contains_any(norm, ["how many structures", "how many organs", "how many segmented", "number of structures", "number of organs", "number of segmented", "count structures", "count organs"]):
        return {"type": "get_structure_count"}
    list_terms = ["list structures", "list the structures", "list organs", "list the organs", "what structures", "which structures", "what organs", "which organs", "structures present", "organs present"]
    if _contains_any(norm, list_terms) or (("segmented structures" in norm or "segmented organs" in norm) and ("list" in norm or "present" in norm)):
        return {"type": "list_structures"}
    if _contains_any(norm, ["largest", "biggest", "highest volume", "most volume"]) and _contains_any(norm, ["organ", "structure", "segmented", "scan", "case"]):
        return {"type": "get_largest_structure"}
    if _contains_any(norm, ["smallest", "tiniest", "lowest volume", "least volume"]) and _contains_any(norm, ["organ", "structure", "segmented", "scan", "case"]):
        return {"type": "get_smallest_structure"}
    return None


def _parse_opacity(norm: str, viewer_state: dict[str, Any]) -> dict[str, Any] | None:
    explicit = _number_after_terms(norm, ["opacity", "transparent", "transparency"])
    if explicit is not None:
        return {"type": "set_opacity", "value": _clamp(explicit, 0, 100)}
    current = float(viewer_state.get("opacity", 70) or 70)
    if _contains_any(norm, ["more transparent", "less opaque", "decrease opacity", "lower opacity", "reduce opacity"]):
        return {"type": "set_opacity", "value": _clamp(current - 20, 0, 100)}
    if _contains_any(norm, ["less transparent", "more opaque", "increase opacity", "raise opacity", "higher opacity"]):
        return {"type": "set_opacity", "value": _clamp(current + 20, 0, 100)}
    return None


def _parse_window(norm: str, viewer_state: dict[str, Any]) -> list[dict[str, Any]]:
    actions = []
    presets = {"soft tissue": "soft_tissue", "bone": "bone", "lung": "lung", "liver": "liver"}
    for phrase, preset in presets.items():
        # "bone" and "lung" are also ordinary anatomy words, so a preset needs
        # the word "window" or "preset" beside it, or a command that names it.
        named = (
            re.search(rf"\b{phrase} (?:window|preset)\b", norm)
            or re.search(rf"\b(?:window|preset) (?:preset )?(?:to |of |for )?{phrase}\b", norm)
            or (phrase != "liver" and re.search(rf"\b(?:switch to|use|apply|set|change to|select) (?:the |a )?{phrase}(?: window| preset| setting)?$", norm))
        )
        if named:
            return [{"type": "set_window_preset", "preset": preset}]
    width = float(viewer_state.get("windowWidth", 400) or 400)
    center = float(viewer_state.get("windowCenter", 50) or 50)
    if _contains_any(norm, ["increase brightness", "brighter", "make brighter"]):
        actions.append({"type": "set_window", "width": width, "center": center + 40})
    if _contains_any(norm, ["decrease brightness", "darker", "make darker", "lower brightness"]):
        actions.append({"type": "set_window", "width": width, "center": center - 40})
    if _contains_any(norm, ["increase contrast", "more contrast"]):
        actions.append({"type": "set_window", "width": max(1, width - 80), "center": center})
    if _contains_any(norm, ["decrease contrast", "less contrast", "lower contrast"]):
        actions.append({"type": "set_window", "width": width + 80, "center": center})
    # A bare "contrast 100 mL" or "level 3" is report wording, not a window
    # value, so those words count only after a verb that sets them.
    parsed_width = _number_after_terms(norm, ["window width", "ww", "set contrast", "use contrast", "contrast to"])
    parsed_center = _number_after_terms(norm, ["window center", "window level", "wc", "set level", "use level", "level to", "set brightness", "brightness to"])
    if parsed_width is not None or parsed_center is not None:
        actions.append({"type": "set_window", "width": max(1, parsed_width if parsed_width is not None else width), "center": parsed_center if parsed_center is not None else center})
    return actions


def _parse_view(norm: str) -> dict[str, Any] | None:
    if _has_word(norm, ["mpr", "multi planar", "multiplanar"]):
        return {"type": "set_view", "view": "mpr"}
    if _has_word(norm, ["axial"]):
        return {"type": "set_view", "view": "axial"}
    if _has_word(norm, ["sagittal", "side view"]):
        return {"type": "set_view", "view": "sagittal"}
    if _has_word(norm, ["coronal", "front view"]):
        return {"type": "set_view", "view": "coronal"}
    if _has_word(norm, ["3d", "three dimensional", "volume view"]):
        return {"type": "set_view", "view": "3d"}
    return None


def _parse_zoom(norm: str, viewer_state: dict[str, Any]) -> dict[str, Any] | None:
    current = float(viewer_state.get("zoomLevel", 1) or 1)
    explicit = _number_after_terms(norm, ["zoom"])
    if explicit is not None:
        return {"type": "set_zoom", "value": _clamp(explicit, MIN_ZOOM, MAX_ZOOM)}
    if "zoom to fit" in norm or "fit to screen" in norm or "reset zoom" in norm:
        return {"type": "zoom_to_fit"}
    if _has_word(norm, ["zoom in", "zoom into"]):
        return {"type": "set_zoom", "value": _clamp(current + 0.25, MIN_ZOOM, MAX_ZOOM)}
    if _has_word(norm, ["zoom out"]):
        return {"type": "set_zoom", "value": _clamp(current - 0.25, MIN_ZOOM, MAX_ZOOM)}
    return None


def _parse_measurement(norm: str) -> dict[str, Any] | None:
    if "clear measurement" in norm or "remove measurement" in norm or "delete measurement" in norm:
        return {"type": "clear_measurements"}
    if _has_word(norm, ["roi", "region of interest", "area tool"]):
        return {"type": "activate_measurement_tool", "tool": "roi"}
    # "distance" and "probe" are ordinary words in a question about the scan,
    # so they count only as a named tool or after a verb that turns one on.
    use = r"(?:use|activate|enable|start|open|select|switch to|turn on|set)(?: the| a| an)?"
    measure = r"measur(?:e|ing)(?: the| a)?"
    turn_on = r"turn (?:the |a |an )?{tool}(?: tool)? on"
    if (
        _has_word(norm, ["ruler", "distance tool", "distance measurement"])
        or re.search(rf"\b(?:{use}|{measure}) (?:length|distance)\b", norm)
        or re.search(rf"\b{turn_on.format(tool='distance')}\b", norm)
    ):
        return {"type": "activate_measurement_tool", "tool": "distance"}
    if _has_word(norm, ["hu probe", "point hu", "click hu", "probe tool"]) or re.search(rf"\b{use} probe\b", norm) or re.search(rf"\b{turn_on.format(tool='probe')}\b", norm):
        return {"type": "activate_measurement_tool", "tool": "probe"}
    return None


def _parse_organ_actions(norm: str, available_organs: list[str]) -> list[dict[str, Any]]:
    actions = []
    organs = _match_organs(norm, available_organs)
    if not organs:
        return actions
    if _contains_any(norm, ["volume", "how big"]) or _has_word(norm, ["size"]):
        actions.append({"type": "get_organ_metric", "organ": organs[0], "metric": "volume_cm3"})
    if _contains_any(norm, ["mean hu", "average hu", "hu of", "hounsfield"]):
        actions.append({"type": "get_organ_metric", "organ": organs[0], "metric": "mean_hu"})
    if _contains_any(norm, ["statistics", "stats", "metrics"]):
        actions.append({"type": "get_organ_metric", "organ": organs[0], "metric": "all"})
    # "segment" and "remove" are ordinary words in a question about the scan
    # ("is the pancreas segmented correctly", "if the surgeon has to remove the
    # spleen"), and "isolated" is not "isolate", so those count only as a command.
    if _contains_any(norm, ["only show", "show only", "just show", "display only", "see only", "only see", "keep only", "only keep"]) or _has_word(norm, ["isolate"]) or _imperative(norm, ["segment", "segmentation of"]):
        actions.append({"type": "isolate_organs", "organs": organs})
        return actions
    if _has_word(norm, ["hide", "turn off"]) or _imperative(norm, ["remove"]):
        actions.append({"type": "hide_organs", "organs": organs})
        return actions
    if _has_word(norm, ["focus", "center", "go to", "jump to", "navigate to"]):
        actions.append({"type": "focus_organ", "organ": organs[0]})
        return actions
    if _has_word(norm, ["show", "display", "highlight", "make visible"]):
        actions.append({"type": "show_organs", "organs": organs})
    return actions


def _validate_action(action: dict[str, Any], available_organs: list[str]) -> bool:
    action_type = action.get("type")
    if action_type not in ALLOWED_ACTION_TYPES:
        return False
    if action_type in {"isolate_organs", "show_organs", "hide_organs"}:
        organs = action.get("organs")
        if not isinstance(organs, list) or not organs:
            return False
        action["organs"] = [organ for organ in organs if organ in available_organs]
        return len(action["organs"]) > 0
    if action_type == "focus_organ":
        return isinstance(action.get("organ"), str) and action["organ"] in available_organs
    if action_type == "get_organ_metric":
        return isinstance(action.get("organ"), str) and action["organ"] in available_organs and action.get("metric") in ALLOWED_METRICS
    if action_type == "set_opacity":
        value = action.get("value")
        if not isinstance(value, (int, float)):
            return False
        action["value"] = _clamp(float(value), 0, 100)
        return True
    if action_type == "set_window":
        return isinstance(action.get("width"), (int, float)) and isinstance(action.get("center"), (int, float))
    if action_type == "set_window_preset":
        return action.get("preset") in ALLOWED_PRESETS
    if action_type == "set_zoom":
        value = action.get("value")
        if not isinstance(value, (int, float)):
            return False
        action["value"] = _clamp(float(value), MIN_ZOOM, MAX_ZOOM)
        return True
    if action_type == "set_view":
        return action.get("view") in ALLOWED_VIEW_MODES
    if action_type == "activate_measurement_tool":
        return action.get("tool") in ALLOWED_TOOLS
    return True


def _action_label(action: dict[str, Any]) -> str:
    action_type = action.get("type")
    if action_type == "isolate_organs":
        return f"Click below to isolate {', '.join(_pretty_organ(organ) for organ in action.get('organs', []))}."
    if action_type == "show_organs":
        return f"Click below to show {', '.join(_pretty_organ(organ) for organ in action.get('organs', []))}."
    if action_type == "hide_organs":
        return f"Click below to hide {', '.join(_pretty_organ(organ) for organ in action.get('organs', []))}."
    if action_type == "focus_organ":
        return f"Click below to focus on {_pretty_organ(action.get('organ', 'the organ'))}."
    if action_type == "get_organ_metric":
        organ = _pretty_organ(action.get("organ", "organ"))
        metric = action.get("metric", "all")
        if metric == "volume_cm3":
            return f"Click below to calculate the volume of {organ}."
        if metric == "mean_hu":
            return f"Click below to calculate the mean HU of {organ}."
        return f"Click below to calculate metrics for {organ}."
    labels = {
        "get_largest_structure": "Click below to calculate the largest segmented structure.",
        "get_smallest_structure": "Click below to calculate the smallest segmented structure.",
        "list_structures": "Click below to list the segmented structures.",
        "get_structure_count": "Click below to count the segmented structures.",
        "zoom_to_fit": "Click below to reset zoom to fit.",
        "clear_measurements": "Click below to clear measurements.",
    }
    if action_type in labels:
        return labels[action_type]
    if action_type == "activate_measurement_tool":
        return f"Click below to activate the {action.get('tool')} tool."
    if action_type == "set_opacity":
        return f"Click below to set opacity to {action.get('value'):.0f}%."
    if action_type == "set_window_preset":
        return f"Click below to apply the {str(action.get('preset')).replace('_', ' ')} window preset."
    if action_type == "set_window":
        return "Click below to apply the CT window change."
    if action_type == "set_view":
        return f"Click below to switch to {str(action.get('view')).upper()} view."
    if action_type == "set_zoom":
        return f"Click below to set zoom to {action.get('value')}."
    return "Click below to apply this action."


def _collect_actions(norm: str, available_organs: list[str], viewer_state: dict[str, Any]) -> list[dict[str, Any]]:
    actions = []
    case_action = _parse_case_data_question(norm)
    if case_action:
        actions.append(case_action)
    opacity_action = _parse_opacity(norm, viewer_state)
    if opacity_action:
        actions.append(opacity_action)
    actions.extend(_parse_window(norm, viewer_state))
    view_action = _parse_view(norm)
    if view_action:
        actions.append(view_action)
    zoom_action = _parse_zoom(norm, viewer_state)
    if zoom_action:
        actions.append(zoom_action)
    measurement_action = _parse_measurement(norm)
    if measurement_action:
        actions.append(measurement_action)
    actions.extend(_parse_organ_actions(norm, available_organs))
    return actions


def parse_intent(message: str, available_organs: list[str], viewer_state: dict | None = None, case_id: str | None = None) -> dict[str, Any]:
    norm = _normalize(message[:1000])
    current_viewer_state = viewer_state or {}
    current_organs = available_organs or []
    if not norm:
        return {"reply": "Please type a question or viewer command.", "actions": [], "source": "hardcoded", "intent": "clarification_needed"}
    if _unsafe_medical_request(norm):
        return _unsafe_reply()
    actions = _collect_actions(norm, current_organs, current_viewer_state)
    clauses = _classified_clauses(message[:1000])
    if any(kind == "question" for _, kind in clauses):
        # A question never moves the viewer, but a command clause beside it still does.
        command_actions = [
            action
            for clause, kind in clauses
            if kind == "command"
            for action in _collect_actions(clause, current_organs, current_viewer_state)
        ]
        actions = [a for a in actions if a["type"] not in _VIEWER_CHANGING_ACTIONS] + [a for a in command_actions if a["type"] in _VIEWER_CHANGING_ACTIONS]
    education = _educational_answer(norm)
    deduped = []
    seen = set()
    for action in actions:
        key = repr(sorted(action.items()))
        if key not in seen:
            deduped.append(action)
            seen.add(key)
    valid_actions = [action for action in deduped if _validate_action(action, current_organs)]
    if education and valid_actions:
        reply = education + "\n\n" + " ".join(_action_label(action) for action in valid_actions)
        intent = "hybrid"
    elif education:
        reply = education
        intent = "educational_question"
    elif valid_actions:
        reply = " ".join(_action_label(action) for action in valid_actions)
        intent = "viewer_action"
    else:
        reply = "I did not recognize that yet. Try: “Only show the liver.” “What does the pancreas do?” “What is a CT scan?” “Set opacity to 50%.” “Enable ROI.” “Which structure is largest?” “List the structures present in this case.”"
        intent = "clarification_needed"
    return {"reply": reply, "actions": valid_actions, "source": "hardcoded", "intent": intent}
