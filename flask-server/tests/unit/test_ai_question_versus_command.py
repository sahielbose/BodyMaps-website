"""A question about the scan never changes the viewer; an explicit command still does.

The rule parser matched plain substrings, so "Is there any bone lesion?" set the
bone window, "comprehensive summary" switched to MPR and "Is the pancreas
segmented correctly?" hid every other organ, while the reply never mentioned it.
"""

import pytest

from services.intent_parser import (
    _normalize,
    _parse_measurement,
    _parse_organ_actions,
    _parse_view,
    _parse_window,
    _parse_zoom,
    is_question,
    parse_intent,
)

ORGANS = ["liver", "pancreas", "spleen", "kidney_left", "kidney_right", "superior_mesenteric_artery"]
STATE = {"windowWidth": 400, "windowCenter": 50, "zoomLevel": 1, "opacity": 70}

# Actions that read the case and leave the display as it is.
READ_ONLY = {"get_organ_metric", "list_structures", "get_structure_count", "get_largest_structure", "get_smallest_structure"}


def _actions(message):
    return parse_intent(message, ORGANS, STATE)["actions"]


@pytest.mark.parametrize(
    "message",
    [
        "Is there any bone lesion in this scan?",
        "What is the lung segmentation like?",
        "Give me a comprehensive summary of this case",
        "What is your impression?",
        "What does an axial slice show?",
        "Is the pancreas segmented correctly?",
        "What happens if the surgeon has to remove the spleen?",
        "Was the scan done with contrast 100 mL?",
        "Was the level 3 node enlarged?",
        "What is the distance between the pancreas and the SMA?",
        "Is there a microinvasive component?",
        "Did the probe show anything?",
        "Give me the report on the lung",
        # No listed opener: only the question mark, or a later opener, marks these.
        "Should I use MPR for this?",
        "Would an axial slice show it?",
        "Can an MPR view show this lesion?",
        "Has the liver been isolated?",
        "Tell me about the 3D reconstruction",
        "In the axial view, is there a lesion?",
        # No opener at all: these would change the window or view without the "?".
        "The bone lesion in the lung window?",
        "Lung window?",
        "Tell me if the liver is isolated",
        "Tell me about the segmentation of the liver",
        "Explain the 3D view",
        "Describe the axial slice",
        "Any lesion in the lung window?",
        "Can you tell me about the 3D reconstruction?",
    ],
)
def test_a_question_does_not_change_the_viewer(message):
    changing = [a for a in _actions(message) if a["type"] not in READ_ONLY]
    assert changing == [], message


@pytest.mark.parametrize(
    "message, expected",
    [
        ("switch to bone window", {"type": "set_window_preset", "preset": "bone"}),
        ("switch to bone", {"type": "set_window_preset", "preset": "bone"}),
        ("use the lung window", {"type": "set_window_preset", "preset": "lung"}),
        ("apply the soft tissue preset", {"type": "set_window_preset", "preset": "soft_tissue"}),
        ("show MPR", {"type": "set_view", "view": "mpr"}),
        ("show the axial view", {"type": "set_view", "view": "axial"}),
        ("isolate the pancreas", {"type": "isolate_organs", "organs": ["pancreas"]}),
        ("segment the liver", {"type": "isolate_organs", "organs": ["liver"]}),
        ("hide the spleen", {"type": "hide_organs", "organs": ["spleen"]}),
        ("remove the spleen from view", {"type": "hide_organs", "organs": ["spleen"]}),
        ("enable ROI", {"type": "activate_measurement_tool", "tool": "roi"}),
        ("use the distance tool", {"type": "activate_measurement_tool", "tool": "distance"}),
        ("activate distance", {"type": "activate_measurement_tool", "tool": "distance"}),
        ("set contrast to 100", {"type": "set_window", "width": 100.0, "center": 50.0}),
    ],
)
def test_an_explicit_command_still_runs(message, expected):
    assert expected in _actions(message), message


def test_a_question_still_gets_its_read_only_answer():
    actions = _actions("What is the volume of the pancreas?")
    assert {"type": "get_organ_metric", "organ": "pancreas", "metric": "volume_cm3"} in actions


@pytest.mark.parametrize(
    "message",
    [
        "Should I use MPR?",
        "Tell me about the 3D view",
        "Has the liver been isolated?",
    ],
)
def test_a_question_without_a_listed_opener_is_still_a_question(message):
    assert is_question(message, _normalize(message))


@pytest.mark.parametrize(
    "message",
    [
        "Can you show the liver?",
        "Could you isolate the pancreas?",
        "Please switch to MPR",
        "What about only showing the liver?",
        "How about the bone window?",
        "What if I switch to the bone window?",
        "Is it possible to isolate the pancreas?",
    ],
)
def test_a_command_in_question_form_is_not_a_question(message):
    assert not is_question(message, _normalize(message))


@pytest.mark.parametrize(
    "message, expected",
    [
        ("Can you only show the liver?", {"type": "isolate_organs", "organs": ["liver"]}),
        ("What about only showing the liver?", {"type": "isolate_organs", "organs": ["liver"]}),
        ("What if I switch to the bone window?", {"type": "set_window_preset", "preset": "bone"}),
        ("Is it possible to isolate the pancreas?", {"type": "isolate_organs", "organs": ["pancreas"]}),
    ],
)
def test_a_conversational_command_still_runs(message, expected):
    assert expected in _actions(message), message


def test_a_question_then_a_command_answers_the_question_and_runs_the_command():
    # Each sentence is judged on its own: the metric is answered and the named organ is isolated.
    actions = _actions("What is the pancreas volume? Then isolate the pancreas.")
    assert {"type": "get_organ_metric", "organ": "pancreas", "metric": "volume_cm3"} in actions
    assert {"type": "isolate_organs", "organs": ["pancreas"]} in actions


def test_a_question_then_a_command_naming_no_organ_changes_nothing():
    # "it" names no organ, so there is nothing to isolate.
    changing = [a for a in _actions("What is the pancreas volume? Then isolate it.") if a["type"] not in READ_ONLY]
    assert changing == []


@pytest.mark.parametrize(
    "message, expected",
    [
        ("zoom .5", {"type": "set_zoom", "value": 0.5}),
        ("zoom 0.5", {"type": "set_zoom", "value": 0.5}),
        ("set opacity to .5", {"type": "set_opacity", "value": 0.5}),
        ("Set the opacity to 0.5", {"type": "set_opacity", "value": 0.5}),
    ],
)
def test_a_leading_decimal_point_keeps_its_value(message, expected):
    assert expected in _actions(message), message


def test_a_full_stop_does_not_glue_to_the_next_word():
    assert _normalize("isolate the liver.5") == "isolate the liver 5"
    assert _normalize("isolate the liver.") == "isolate the liver"


@pytest.mark.parametrize(
    "parse, message",
    [
        (lambda n: _parse_window(n, STATE), "is there a bone lesion"),
        (lambda n: _parse_window(n, STATE), "the lung segmentation"),
        (lambda n: _parse_window(n, STATE), "scan done with contrast 100 ml"),
        (lambda n: _parse_window(n, STATE), "level 3 node"),
        (lambda n: _parse_view(n), "a comprehensive summary"),
        (lambda n: _parse_view(n), "your impression"),
        (lambda n: _parse_view(n), "the axially oriented slab"),
        (lambda n: _parse_zoom(n, STATE), "the image was zoomed in on the liver"),
        (lambda n: _parse_measurement(n), "a microinvasive component"),
        (lambda n: _parse_measurement(n), "the distance between the pancreas and the sma"),
        (lambda n: _parse_measurement(n), "the probe showed nothing"),
        (lambda n: _parse_organ_actions(n, ORGANS), "the pancreas was segmented correctly"),
        (lambda n: _parse_organ_actions(n, ORGANS), "if the surgeon has to remove the spleen"),
        (lambda n: _parse_organ_actions(n, ORGANS), "tell me if the liver is isolated"),
        (lambda n: _parse_organ_actions(n, ORGANS), "tell me about the segmentation of the liver"),
        (lambda n: _parse_organ_actions(n, ORGANS), "the liver is centered in the field"),
        (lambda n: _parse_organ_actions(n, ORGANS), "the focused lesion in the liver"),
    ],
)
def test_the_individual_triggers_need_a_whole_word_or_a_command(parse, message):
    assert not parse(message), message


def test_the_whole_word_triggers_still_fire_on_their_own():
    assert _parse_view("show mpr") == {"type": "set_view", "view": "mpr"}
    assert _parse_zoom("zoom into the liver", STATE) == {"type": "set_zoom", "value": 1.25}
    assert _parse_measurement("use the roi tool") == {"type": "activate_measurement_tool", "tool": "roi"}
    assert {"type": "isolate_organs", "organs": ["liver"]} in _parse_organ_actions("isolate the liver", ORGANS)
    assert {"type": "focus_organ", "organ": "liver"} in _parse_organ_actions("focus on the liver", ORGANS)


@pytest.mark.parametrize(
    "message, expected",
    [
        # A bare imperative stays a command when a question mark ends it.
        ("Show only the liver?", {"type": "isolate_organs", "organs": ["liver"]}),
        ("Hide the spleen?", {"type": "hide_organs", "organs": ["spleen"]}),
        ("Zoom in?", {"type": "set_zoom", "value": 1.25}),
        ("Show me the liver, please?", {"type": "show_organs", "organs": ["liver"]}),
        # "Show me" opens a command, so it runs even when it also asks for a number.
        ("Show me the volume of the liver?", {"type": "show_organs", "organs": ["liver"]}),
        # Do this, then ask that: the command clause still runs.
        ("Isolate the liver. How big is it?", {"type": "isolate_organs", "organs": ["liver"]}),
        ("Isolate the liver and tell me its volume?", {"type": "isolate_organs", "organs": ["liver"]}),
        ("Hide the spleen, what is the pancreas volume?", {"type": "hide_organs", "organs": ["spleen"]}),
        # Filler and other polite leads in front of the request.
        ("Can I see only the liver?", {"type": "isolate_organs", "organs": ["liver"]}),
        ("Could we hide the spleen?", {"type": "hide_organs", "organs": ["spleen"]}),
        ("Now can you show only the liver?", {"type": "isolate_organs", "organs": ["liver"]}),
        ("Ok can you zoom in?", {"type": "set_zoom", "value": 1.25}),
        ("And can you hide the spleen?", {"type": "hide_organs", "organs": ["spleen"]}),
        ("Thanks, could you please hide the spleen?", {"type": "hide_organs", "organs": ["spleen"]}),
        ("Is there a way to isolate the liver?", {"type": "isolate_organs", "organs": ["liver"]}),
        # "Remove" and "segment" count as commands only after a lead the parser strips.
        ("Ok remove the spleen", {"type": "hide_organs", "organs": ["spleen"]}),
        ("Could we remove the spleen?", {"type": "hide_organs", "organs": ["spleen"]}),
        ("May I remove the spleen?", {"type": "hide_organs", "organs": ["spleen"]}),
        ("Hey, segment the liver", {"type": "isolate_organs", "organs": ["liver"]}),
        ("Is there a way to segment only the liver?", {"type": "isolate_organs", "organs": ["liver"]}),
        # The distance tool.
        ("Measure the distance between the liver and spleen", {"type": "activate_measurement_tool", "tool": "distance"}),
        ("Start measuring distance", {"type": "activate_measurement_tool", "tool": "distance"}),
        ("Can you measure the distance?", {"type": "activate_measurement_tool", "tool": "distance"}),
        ("Turn the probe on", {"type": "activate_measurement_tool", "tool": "probe"}),
    ],
)
def test_a_request_to_change_the_viewer_runs_whatever_its_punctuation_or_lead(message, expected):
    assert expected in _actions(message), message


def test_a_command_with_a_question_still_answers_the_question():
    actions = _actions("Isolate the liver and tell me its volume?")
    assert {"type": "get_organ_metric", "organ": "liver", "metric": "volume_cm3"} in actions
    actions = _actions("Isolate the liver. How big is it?")
    assert {"type": "isolate_organs", "organs": ["liver"]} in actions


@pytest.mark.parametrize(
    "message",
    [
        "Is there any bone lesion?",
        "Give me a comprehensive summary",
        "Is the pancreas segmented correctly?",
        "What does an axial slice show?",
        "In the axial view, is there a lesion?",
        "How do I measure the distance between the liver and the spleen?",
        "Now what is the volume of the liver?",
        "And is there any lesion in the lung window?",
        # "Would I" and "Will we" ask what would happen; they are not requests.
        "Would I see the pancreas better in the bone window?",
        "Will we see the liver in 3D view?",
        "Would we see more in the lung window?",
    ],
)
def test_a_genuine_question_with_a_filler_lead_never_moves_the_viewer(message):
    changing = [a for a in _actions(message) if a["type"] not in READ_ONLY]
    assert changing == [], message


def test_a_question_between_two_commands_only_drops_its_own_clause():
    actions = _actions("Hide the spleen. Is the pancreas segmented correctly? Show only the liver?")
    assert {"type": "hide_organs", "organs": ["spleen"]} in actions
    assert {"type": "isolate_organs", "organs": ["liver"]} in actions
    assert not any(a["type"] == "isolate_organs" and "pancreas" in a["organs"] for a in actions)


@pytest.mark.parametrize(
    "message",
    ["Can I trust the segmentation?", "Is the liver isolated?"],
)
def test_the_polite_leads_do_not_turn_a_question_into_a_command(message):
    changing = [a for a in _actions(message) if a["type"] not in READ_ONLY]
    assert changing == [], message
