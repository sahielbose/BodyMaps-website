"""Assistant replies never contain em dashes.

Small local models ignore the prompt rule, so the streamed deltas, the final
event and the non-streaming replies are all normalised on the server. Code,
numbers and ranges such as 5-10 mm are left alone, and the final text matches
what was streamed.
"""

import json

from flask import Flask

from api import api_blueprint as bp
from services import ai_reasoning
from services import ollama_client

EM = "—"
EN = "–"


def _events(monkeypatch, chat_stream, body=None, chat_with_tools=None):
    def tools_down(**_kwargs):
        raise ollama_client.OllamaUnavailable("x")

    monkeypatch.setattr(bp, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "_ai_record_answered", lambda _user: None)
    monkeypatch.setattr(bp, "resolve_text_model", lambda _model: "llama3")
    monkeypatch.setattr(bp, "chat_stream", chat_stream)
    monkeypatch.setattr(bp, "chat_with_tools", chat_with_tools or tools_down)
    app = Flask(__name__)
    app.add_url_rule("/api/ai-command-stream", view_func=bp.ai_command_stream, methods=["POST"])
    response = app.test_client().post(
        "/api/ai-command-stream", json=body or {"message": "Tell me about the liver."}
    )
    return [json.loads(line) for line in response.get_data(as_text=True).splitlines() if line.strip()]


def test_spaced_and_tight_em_dashes_become_commas():
    assert ai_reasoning.strip_em_dashes(f"Within range {EM} a mild asymmetry is common") == (
        "Within range, a mild asymmetry is common"
    )
    assert ai_reasoning.strip_em_dashes(f"Within range{EM}a mild asymmetry") == "Within range, a mild asymmetry"
    assert ai_reasoning.strip_em_dashes(f"Pause {EN} then continue") == "Pause, then continue"


def test_ranges_code_and_plain_text_are_left_alone():
    assert ai_reasoning.strip_em_dashes("A 5-10 mm nodule") == "A 5-10 mm nodule"
    assert ai_reasoning.strip_em_dashes(f"A 5{EN}10 mm nodule") == f"A 5{EN}10 mm nodule"
    assert ai_reasoning.strip_em_dashes(f"A 5{EM}10 mm nodule") == "A 5-10 mm nodule"
    code = f"Use `a {EM} b` here"
    assert ai_reasoning.strip_em_dashes(code) == code
    fenced = f"Run:\n```\nx {EM} y\n```\nThen {EM} stop"
    assert ai_reasoning.strip_em_dashes(fenced) == f"Run:\n```\nx {EM} y\n```\nThen, stop"
    assert ai_reasoning.strip_em_dashes("") == ""


def test_spaced_en_dash_between_numbers_stays_a_range():
    assert ai_reasoning.strip_em_dashes(f"pH 7.35 {EN} 7.45 is normal") == "pH 7.35 to 7.45 is normal"
    assert ai_reasoning.strip_em_dashes(f"A 5 {EN} 10 mm nodule") == "A 5 to 10 mm nodule"
    assert ai_reasoning.strip_em_dashes(f"Levels T1 {EN} T2") == "Levels T1 to T2"
    assert ai_reasoning.strip_em_dashes(f"Levels 1 {EN} L2") == "Levels 1 to L2"
    # Not a range: a word follows the dash.
    assert ai_reasoning.strip_em_dashes(f"After 5 {EN} then stop") == "After 5, then stop"


def test_spaced_en_dash_with_units_percent_or_months_stays_a_range():
    assert ai_reasoning.strip_em_dashes(f"Normal is 10 mm {EN} 15 mm.") == "Normal is 10 mm to 15 mm."
    assert ai_reasoning.strip_em_dashes(f"Fat is 40 HU {EN} 60 HU") == "Fat is 40 HU to 60 HU"
    assert ai_reasoning.strip_em_dashes(f"About 20% {EN} 30% of cases") == "About 20% to 30% of cases"
    assert ai_reasoning.strip_em_dashes(f"From Jan 2020 {EN} Mar 2021") == "From Jan 2020 to Mar 2021"
    assert ai_reasoning.strip_em_dashes(f"BP 120 mmHg {EN} 140 mmHg") == "BP 120 mmHg to 140 mmHg"
    # Still a break: words on the far side.
    assert ai_reasoning.strip_em_dashes(f"It measures 12 mm {EN} likely benign") == "It measures 12 mm, likely benign"


def test_a_spaced_en_dash_break_before_another_number_stays_a_break():
    assert ai_reasoning.strip_em_dashes(f"Seen in 5 days {EN} 3 had fever") == "Seen in 5 days, 3 had fever"
    assert ai_reasoning.strip_em_dashes(f"Lesion 12 mm {EN} a 2 cm cyst") == "Lesion 12 mm, a 2 cm cyst"
    assert ai_reasoning.strip_em_dashes(f"Only 2 {EN} the 3 largest") == "Only 2, the 3 largest"
    assert ai_reasoning.strip_em_dashes(f"From March 2020 {EN} September 2021") == "From March 2020 to September 2021"


def test_normalising_twice_changes_nothing():
    once = ai_reasoning.strip_em_dashes(f"{EM} Start {EM} middle {EM}\nend")
    assert EM not in once
    assert ai_reasoning.strip_em_dashes(once) == once


def test_streaming_form_is_a_stable_prefix_for_every_split():
    text = f"The pancreas is within range {EM} a mild asymmetry is common {EM}5{EM}10 mm."
    full = ai_reasoning.strip_em_dashes(text)
    previous = ""
    for end in range(1, len(text) + 1):
        shown = ai_reasoning.strip_em_dashes_streaming(text[:end])
        assert shown.startswith(previous)
        assert EM not in shown
        previous = shown
    assert previous == full


def test_streaming_form_is_stable_across_inline_code_and_ranges():
    text = (
        f"Use `a {EM} b` and then {EM} stop. Levels T1 {EN} T2 and pH 7.35 {EN} 7.45."
        f" Normal is 10 mm {EN} 15 mm, 20% {EN} 30% or Jan 2020 {EN} Mar 2021 {EN} Marching on."
        f" Seen in 5 days {EN} 3 had fever, lesion 12 mm {EN} a 2 cm cyst, only 2 {EN} the 3 largest."
        f"\nA stray ` tick {EM} here\n```\nx {EM} y"
    )
    full = ai_reasoning.strip_em_dashes(text)
    previous = ""
    for end in range(1, len(text) + 1):
        shown = ai_reasoning.strip_em_dashes_streaming(text[:end])
        assert shown.startswith(previous), text[:end]
        previous = shown
    # The last word after a dash is still held back; the stream flushes it.
    assert full.startswith(previous)
    assert f"`a {EM} b`" in full
    assert f"x {EM} y" in full
    assert "T1 to T2" in full
    assert "7.35 to 7.45" in full
    assert "10 mm to 15 mm, 20% to 30% or Jan 2020 to Mar 2021, Marching on." in full
    assert "5 days, 3 had fever, lesion 12 mm, a 2 cm cyst, only 2, the 3 largest." in full


def test_an_unclosed_inline_code_span_is_held_back_while_streaming():
    assert ai_reasoning.strip_em_dashes_streaming(f"Use `a {EM} b") == "Use"
    assert ai_reasoning.strip_em_dashes_streaming(f"Use `a {EM} b`") == f"Use `a {EM} b`"


def test_prompts_ask_for_no_em_dashes_and_do_not_use_them():
    assert "never use em dashes" in ai_reasoning._BASE_PROMPT
    assert "never use em dashes" in bp._AI_AGENT_SYSTEM_PROMPT
    assert EM not in ai_reasoning._BASE_PROMPT
    assert EM not in bp._AI_AGENT_SYSTEM_PROMPT


def test_streamed_deltas_and_final_reply_have_no_em_dashes_and_agree(monkeypatch):
    def model(**_kwargs):
        # Split so the dash and its spaces arrive in different chunks.
        for chunk in ["The pancreas is within range ", EM, " a mild asymmetry", " is common."]:
            yield "content", chunk

    events = _events(monkeypatch, model)
    streamed = "".join(event["delta"] for event in events if event["type"] == "reply")
    final = next(event for event in events if event["type"] == "final")["reply"]

    assert EM not in streamed
    assert EM not in final
    assert streamed == "The pancreas is within range, a mild asymmetry is common."
    assert final == streamed



def _reply_and_final(events):
    streamed = "".join(event["delta"] for event in events if event["type"] == "reply")
    final = next(event for event in events if event["type"] == "final")["reply"]
    return streamed, final


def test_a_reply_ending_after_a_dash_is_flushed_when_the_stream_ends(monkeypatch):
    def model(**_kwargs):
        yield "content", f"The scan is clear {EM} yes"

    streamed, final = _reply_and_final(_events(monkeypatch, model))

    assert streamed == "The scan is clear, yes"
    assert final == streamed


def test_the_agent_answer_has_no_em_dashes_when_streamed_or_final(monkeypatch):
    monkeypatch.setattr(bp, "_ai_case_allowed", lambda _case: True)

    def tools(**_kwargs):
        return {"content": f"The pancreas is within range {EM} a mild asymmetry is common."}

    def model_must_not_run(**_kwargs):
        raise AssertionError("the agent already wrote the answer")
        yield

    events = _events(
        monkeypatch,
        model_must_not_run,
        body={"message": "What is the pancreas volume in this case?", "session_id": "case-1"},
        chat_with_tools=tools,
    )
    streamed, final = _reply_and_final(events)

    assert streamed == "The pancreas is within range, a mild asymmetry is common."
    assert final == streamed


def test_the_legend_answer_has_no_em_dashes(monkeypatch):
    monkeypatch.setattr(bp, "resolve_vision_model", lambda _model: "vision")
    monkeypatch.setattr(bp, "_ai_legend_answer", lambda _message, _legend: f"The liver is green {EM} the kidney is blue.")

    events = _events(
        monkeypatch,
        lambda **_k: iter(()),
        body={
            "message": "Which color is the liver?",
            "images": ["data:image/png;base64,AAAA"],
            "mask_legend": [{"organ": "liver", "color": "#00ff00"}],
        },
    )
    streamed, final = _reply_and_final(events)

    assert streamed == "The liver is green, the kidney is blue."
    assert final == streamed


def test_a_spaced_en_dash_range_survives_the_stream(monkeypatch):
    def model(**_kwargs):
        yield "content", f"A pH of 7.35 {EN} 7.45 is normal."

    streamed, final = _reply_and_final(_events(monkeypatch, model))

    assert streamed == "A pH of 7.35 to 7.45 is normal."
    assert final == streamed


def test_the_non_streaming_command_reply_has_no_em_dashes(monkeypatch):
    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(bp, "_ai_record_answered", lambda _user: None)
    monkeypatch.setattr(
        bp, "chat_json", lambda **_k: {"reply": f"Zooming in {EM} done. Range 5 {EN} 10 mm.", "actions": []}
    )
    app = Flask(__name__)
    with app.test_request_context("/api/ai-command", method="POST", json={"message": "zoom in"}):
        reply = bp.ai_command().get_json()["reply"]

    assert EM not in reply
    assert reply.startswith("Zooming in, done.")
    assert "5 to 10 mm" in reply


def test_the_vision_command_reply_has_no_em_dashes(monkeypatch):
    def model(**_kwargs):
        yield "content", f"The liver looks normal {EM} no focal lesion."

    monkeypatch.setattr(bp, "_ai_gate", lambda: None)
    monkeypatch.setattr(bp, "current_user", lambda: {"id": "owner"})
    monkeypatch.setattr(bp, "_ai_record_answered", lambda _user: None)
    monkeypatch.setattr(bp, "resolve_vision_model", lambda _model: "vision")
    monkeypatch.setattr(bp, "chat_stream", model)
    app = Flask(__name__)
    with app.test_request_context(
        "/api/ai-command",
        method="POST",
        json={"message": "What is in this?", "images": ["data:image/png;base64,AAAA"]},
    ):
        reply = bp.ai_command().get_json()["reply"]

    assert EM not in reply
    assert reply.startswith("The liver looks normal, no focal lesion.")
