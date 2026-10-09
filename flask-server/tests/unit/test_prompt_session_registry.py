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


def test_releasing_a_finished_session_frees_its_slot(monkeypatch):
    """Annotating one structure after another must not exhaust the pool.

    Each class holds its own session, and the server refuses newcomers rather
    than evicting residents, so without an explicit release a run of classes
    stalls at MAX_SESSIONS while every held session sits idle and finished.
    """
    monkeypatch.setattr(predictor, "MAX_SESSIONS", 2)
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="vertebra-1")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="vertebra-2")
    with pytest.raises(predictor.PromptCapacityError):
        predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="vertebra-3")

    first = FakeRemote.instances[0]
    assert predictor.release_session("vertebra-1") is True
    assert first.closed
    assert "vertebra-1" not in predictor._states

    # The freed slot is immediately usable, and the untouched session survives.
    predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="vertebra-3")
    assert predictor.session_is_active("vertebra-3")
    assert predictor.session_is_active("vertebra-2")


def test_releasing_an_unknown_token_is_not_an_error():
    """The client releases fire-and-forget, so a token the server already
    reaped (or never had) must report "nothing to do", not raise."""
    assert predictor.release_session("never-existed") is False
    assert predictor.release_session(None) is False
    assert predictor.release_session("") is False


def test_releasing_one_session_leaves_the_others_contexts_intact():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="bob")
    alice, bob = FakeRemote.instances

    predictor.release_session("alice")

    assert alice.closed
    assert not bob.closed
    assert predictor.session_is_active("bob")


def test_a_full_model_server_is_a_capacity_refusal_not_a_model_failure(monkeypatch):
    # Our own cap can sit above the model server's --max-sessions (or other
    # processes can hold its leases). Its 503 at lease time must surface as
    # PromptCapacityError, and the refused token must not keep a local slot.
    def full(*args, **kwargs):
        raise remote_mod.ServerAtCapacityError("server is at capacity")

    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", full)
    with pytest.raises(predictor.PromptCapacityError):
        predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="carol")
    assert "carol" not in predictor._states


def test_a_full_model_server_never_degrades_a_box_into_region_grow(monkeypatch):
    import services.advanced_analysis as analysis

    def full(*args, **kwargs):
        raise remote_mod.ServerAtCapacityError("server is at capacity")

    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", full)
    monkeypatch.setattr(analysis, "region_grow", lambda *a, **k: pytest.fail("fell back to region_grow"))
    affine = np.eye(4)
    prompt = {
        "point_lps": [-1.0, -1.0, 1.0],
        "box_lps": [[0.0, 0.0, 1.0], [-3.0, -3.0, 1.0]],
        "session_token": "carol",
    }
    with pytest.raises(predictor.PromptCapacityError):
        analysis.segment_from_prompt(CT, affine, prompt, case_key="1:full")


def test_a_refused_rebuild_parks_the_state_without_holding_a_slot(monkeypatch):
    # alice's lease expires mid-request while the model server is full. She
    # gets the capacity refusal, but her object is kept for her retry, and
    # the lease-less state must not lock carol out of our own slots.
    monkeypatch.setattr(predictor, "MAX_SESSIONS", 2)
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="alice")
    alice_remote = FakeRemote.instances[0]

    def expire(*args, **kwargs):
        raise remote_mod.SessionExpiredError("expired")

    alice_remote.add_point_interaction = expire

    def full(*args, **kwargs):
        raise remote_mod.ServerAtCapacityError("server is at capacity")

    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", full)
    with pytest.raises(predictor.PromptCapacityError):
        predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="alice")

    parked = predictor._states["alice"]
    assert parked.session is None
    assert len(parked.history) == 3  # the refreshed seed head plus both clicks

    monkeypatch.setattr(remote_mod, "nnInteractiveRemoteInferenceSession", FakeRemote)
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="bob")
    # alice holds no lease, so carol still fits under MAX_SESSIONS = 2.
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="carol")

    # alice's retry replays her object on a fresh lease instead of starting over.
    predictor._states.pop("carol")
    predictor.predict(CT, "1:full", point_ijk=[3, 3, 3], session_token="alice")
    resumed = predictor._states["alice"].session
    seeds = [c for c in resumed.calls if c[0] == "initial_seg"]
    points = _point_calls(resumed)
    assert len(seeds) == 1
    # The two earlier clicks replay deferred, then the new one predicts.
    assert [c[1] for c in points] == [(0, 0, 0), (1, 1, 1), (3, 3, 3)]
    assert [c[3] for c in points] == [False, False, True]
    assert ("reset",) not in resumed.calls


def test_a_parked_state_is_not_resumed_for_a_fresh_seeded_start(monkeypatch):
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    state = predictor._states["alice"]
    state.session = None  # parked, as after a refused rebuild

    seed = np.zeros(CT.shape, dtype=np.uint8)
    seed[1, 1, 1] = 1
    predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="alice", initial_seg=seed)

    remote = predictor._states["alice"].session
    assert [c[1] for c in _point_calls(remote)] == [(2, 2, 2)]
    assert ("set_image", (1, 4, 4, 4)) in remote.calls  # a fresh lease gets the volume


def test_a_returning_owner_is_told_the_reaper_took_their_session(monkeypatch):
    # alice leaves the tool armed past the idle window. Answering her next
    # click from an empty session would hand back a one-click object that her
    # client diffs against the old one, retracting the rest of it.
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    alice_remote = FakeRemote.instances[0]
    monkeypatch.setattr(predictor, "SESSION_IDLE_S", -1.0)

    with pytest.raises(predictor.PromptSessionLostError):
        predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="alice",
                          expect_session=True)

    assert alice_remote.closed
    assert "alice" not in predictor._states
    assert len(FakeRemote.instances) == 1  # no fresh lease claimed for it


def test_a_restarted_process_refuses_a_token_it_never_saw():
    with pytest.raises(predictor.PromptSessionLostError):
        predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="ghost",
                          expect_session=True)
    assert "ghost" not in predictor._states
    assert FakeRemote.instances == []


def test_a_live_session_keeps_refining_when_the_client_expects_it():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor.predict(CT, "1:full", point_ijk=[1, 1, 1], session_token="alice",
                      expect_session=True)

    alice = FakeRemote.instances[0]
    assert [c[1] for c in _point_calls(alice)] == [(0, 0, 0), (1, 1, 1)]
    assert len(predictor._states["alice"].history) == 2


def test_a_parked_session_still_resumes_when_the_client_expects_it():
    predictor.predict(CT, "1:full", point_ijk=[0, 0, 0], session_token="alice")
    predictor._states["alice"].session = None  # parked, as after a refused rebuild

    predictor.predict(CT, "1:full", point_ijk=[2, 2, 2], session_token="alice",
                      expect_session=True)

    resumed = predictor._states["alice"].session
    assert [c[1] for c in _point_calls(resumed)] == [(0, 0, 0), (2, 2, 2)]


def test_a_lost_session_never_degrades_into_region_grow(monkeypatch):
    import services.advanced_analysis as analysis

    monkeypatch.setattr(analysis, "region_grow", lambda *a, **k: pytest.fail("fell back to region_grow"))
    prompt = {"point_lps": [-1.0, -1.0, 1.0], "session_token": "ghost", "expect_session": True}
    with pytest.raises(predictor.PromptSessionLostError):
        analysis.segment_from_prompt(CT, np.eye(4), prompt, case_key="1:full")
