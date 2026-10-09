"""The assistant's zoom range matches the viewer's (MIN_ZOOM 0.2, MAX_ZOOM 8).

The reply quotes the zoom it set, so a wider server range would say 15x while
the panes and the Zoom slider stop at 8x.
"""

from api import api_blueprint as bp
from services import intent_parser


def _sanitized_zoom(value):
    actions = bp._ai_sanitize_actions([{"type": "set_zoom", "value": value}], [])
    return actions[0]["value"]


def test_sanitized_zoom_stops_at_the_viewer_range():
    assert _sanitized_zoom(15) == 8
    assert _sanitized_zoom(0.1) == 0.2
    assert _sanitized_zoom(3) == 3


def test_confirmation_quotes_the_clamped_zoom():
    text = bp._ai_action_confirmation(bp._ai_sanitize_actions([{"type": "set_zoom", "value": 15}], []))
    assert "Set zoom to 8x." in text


def test_parsed_zoom_stops_at_the_viewer_range():
    high = intent_parser.parse_intent("zoom 15", [], {"zoomLevel": 1})
    low = intent_parser.parse_intent("zoom 0.1", [], {"zoomLevel": 1})
    assert high["actions"][0]["value"] == 8
    assert low["actions"][0]["value"] == 0.2
