"""Wording the assistant shows when it cannot answer, and one-structure counts.

The offline bubble already carries a Try again button, and a typed "yes" is a
new turn that never reaches the model with the question, so the text must not
ask one. Counts of one must not read "1 segmented structures".
"""

import services.ai_reasoning as ai_reasoning
import services.lesion_grounding as lesion_grounding


def test_the_offline_reply_asks_no_question():
    reply = ai_reasoning.model_offline_reply(has_images=False)

    assert "?" not in reply
    assert reply.rstrip().endswith("the viewer controls in the top panel still work.")


def _absent(*displays):
    return {
        "available": True,
        "lesions": [
            {"key": d.replace(" ", "_"), "display": d, "organ": d.split()[0], "present": False}
            for d in displays
        ],
    }


def test_one_absent_lesion_class_keeps_the_singular_sentence():
    text = lesion_grounding.lesion_summary(_absent("pancreatic lesion"))

    assert text.startswith("No pancreatic lesion is present in this case")


def test_several_absent_lesion_classes_read_as_a_group():
    text = lesion_grounding.lesion_summary(
        _absent("pancreatic lesion", "liver lesion", "kidney lesion")
    )

    assert "is present" not in text
    assert "that class" not in text
    assert text.startswith(
        "None of the lesion classes (pancreatic lesion, liver lesion, kidney lesion) "
        "contain any voxels"
    )


from api import api_blueprint as bp


def _grounded(action, organs):
    metrics = [bp._ai_public_metric({"organ_name": o, "volume_cm3": 10.0}) for o in organs]
    return bp._ai_grounded_reply(
        "which is it?", [{"type": action}], metrics, organs, {}, None, "case_measurement"
    )


def test_a_single_structure_is_counted_in_the_singular():
    assert "**1 segmented structure**" in _grounded("get_structure_count", ["liver"])
    assert "**1 segmented structure**:" in _grounded("list_structures", ["liver"])


def test_several_structures_keep_the_plural():
    assert "**2 segmented structures**" in _grounded("get_structure_count", ["liver", "spleen"])
    assert "**2 segmented structures**:" in _grounded("list_structures", ["liver", "spleen"])


def test_the_agent_inventory_tool_counts_one_structure_in_the_singular():
    status, result, _actions, _fact = bp._ai_agent_execute(
        "list_structures", {}, metrics=[], metadata={}, available_organs=["liver"], references=[]
    )
    assert "1 segmented structure:" in result
    assert "1 segmented structures" not in result
