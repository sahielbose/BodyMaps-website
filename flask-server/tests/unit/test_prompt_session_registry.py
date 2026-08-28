"""Token-keyed prompt sessions.

The predictor used to hold ONE live session for the whole process, so two
people prompting at once reset each other's accumulated model context on
every alternating request. Sessions are now keyed by token: each token owns
its own model-server lease, tokenless requests share one anonymous slot, a
full house refuses the newcomer instead of evicting someone's live session,
and abandoned sessions are reaped on the model server's own idle schedule.
"""
import numpy as np
import pytest

import nnInteractive.inference.remote.remote_session as remote_mod
import services.nninteractive_predictor as predictor


CT = np.zeros((4, 4, 4), dtype=np.float32)
CT2 = np.zeros((5, 5, 5), dtype=np.float32)


class FakeRemote:
    """Stands in for nnInteractiveRemoteInferenceSession, recording calls."""

    instances: list["FakeRemote"] = []

    def __init__(self, server_url=None, api_key=None, read_timeout=None):
        self.read_timeout = read_timeout
        self.calls = []
        self.closed = False
        self.buffer = None
        self.supports_undo = True
        self._last_paste_bbox = [[0, 2], [0, 2], [0, 2]]
        FakeRemote.instances.append(self)

    def ping(self):
        return True

    def set_image(self, img):
        self.calls.append(("set_image", tuple(img.shape)))

    def set_target_buffer(self, buf):
        self.buffer = buf

    def reset_interactions(self):
        self.calls.append(("reset",))

    def add_point_interaction(self, coords, include_interaction=True, run_prediction=True):
        self.calls.append(("point", tuple(coords), include_interaction, run_prediction))
        if self.buffer is not None and run_prediction:
            self.buffer[tuple(coords)] = 1

    def add_initial_seg_interaction(self, seg, run_prediction=False):
        self.calls.append(("initial_seg", int(seg.sum())))
        if self.buffer is not None:
            self.buffer[:] = seg

    def undo(self):
        self.calls.append(("undo",))
        return True

    def close(self):
        self.closed = True


def _point_calls(fake):
    return [c for c in fake.calls if c[0] == "point"]


@pytest.fixture(autouse=True)
def registry(monkeypatch):
    """Fresh registry + fake remote class for every test."""
    FakeRemote.instances = []
    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", FakeRemote)
    for state in list(predictor._states.values()):
        state.session = None  # never close a real lease from a unit test
    predictor._states.clear()
    yield
    predictor._states.clear()


def test_two_tokens_keep_separate_model_contexts():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="bob")
    predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="alice")

    assert len(FakeRemote.instances) == 2
    alice, bob = FakeRemote.instances
    # Alice's second click ACCUMULATED: no reset between her two points.
    assert [c[1] for c in _point_calls(alice)] == [(0, 0, 0), (2, 2, 2)]
    assert alice.calls.count(("reset",)) == 1
    assert [c[1] for c in _point_calls(bob)] == [(1, 1, 1)]
    # Bob's arrival must not have touched Alice's session at all.
    assert predictor.session_is_active("alice")
    assert predictor.session_is_active("bob")
    assert len(predictor._states["alice"].history) == 2
    assert len(predictor._states["bob"].history) == 1


def test_a_full_house_refuses_the_newcomer_not_the_residents(monkeypatch):
    monkeypatch.setattr(predictor, "MAX_SESSIONS", 2)
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="bob")

    with pytest.raises(predictor.PromptCapacityError):
        predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="carol")

    assert predictor.session_is_active("alice")
    assert predictor.session_is_active("bob")
    assert "carol" not in predictor._states


def test_idle_sessions_are_reaped_to_free_a_slot(monkeypatch):
    monkeypatch.setattr(predictor, "MAX_SESSIONS", 1)
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    alice_remote = FakeRemote.instances[0]

    # Alice walks away past the idle window; Carol's arrival reaps her.
    monkeypatch.setattr(predictor, "SESSION_IDLE_S", -1.0)
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="carol")

    assert alice_remote.closed
    assert "alice" not in predictor._states
    assert predictor.session_is_active("carol")


def test_tokenless_requests_share_one_resetting_slot():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token=None)
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token=None)

    assert len(FakeRemote.instances) == 1
    anon = FakeRemote.instances[0]
    # Each tokenless request starts over: reset before every point.
    assert anon.calls.count(("reset",)) == 2
    assert not predictor.session_is_active(None)


def test_undo_rewinds_only_its_own_session():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="bob")

    remaining = predictor.undo_last("alice")

    alice, bob = FakeRemote.instances
    assert remaining == 1
    assert ("undo",) in alice.calls
    assert ("undo",) not in bob.calls
    assert len(predictor._states["bob"].history) == 1


def test_a_seed_restarts_the_same_token_as_a_fresh_object():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    seed = np.ones(CT.shape, dtype=np.uint8)
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="alice",
                      initial_seg=seed)

    history = predictor._states["alice"].history
    assert [e["kind"] for e in history] == ["initial_seg", "point"]
    assert FakeRemote.instances[0].calls.count(("reset",)) == 2


def test_switching_cases_clears_that_tokens_context_only():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="bob")
    predictor.predict(CT2, "2:full", point_ijk=[0, 0, 0], session_token="alice")

    assert len(predictor._states["alice"].history) == 1
    assert predictor._states["alice"].case_key == "2:full"
    assert len(predictor._states["bob"].history) == 1
    alice = FakeRemote.instances[0]
    assert alice.calls.count(("set_image", (1, 4, 4, 4))) == 1
    assert alice.calls.count(("set_image", (1, 5, 5, 5))) == 1


def test_process_exit_releases_every_lease():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="bob")

    predictor._release_on_exit()

    assert all(f.closed for f in FakeRemote.instances)
    assert predictor._states == {}
