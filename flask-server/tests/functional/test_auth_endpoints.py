"""End-to-end tests for the auth endpoints via a Flask test client.

Only the auth blueprint is registered (it doesn't pull in the heavy nibabel/
scipy stack), so the full register -> cookie -> me -> logout flow, the
require_auth guard, and /me/jobs are exercised without the whole app.
"""

import hashlib
import importlib
import json

import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'auth_ep.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.job_store  # noqa: F401
    import services.plan_store as plan_store
    importlib.reload(plan_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as bp_mod
    importlib.reload(bp_mod)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(bp_mod.auth_blueprint, url_prefix="/api")
    with app.test_client() as c:
        yield c
    engine.reset_engine_for_tests()


def test_register_sets_cookie_and_me_works(client):
    r = client.post("/api/auth/register", json={"email": "a@b.com", "password": "password1"})
    assert r.status_code == 201
    assert r.get_json()["user"]["email"] == "a@b.com"
    assert "bm_session" in r.headers.get("Set-Cookie", "")

    # cookie persists on the test client -> /me is authenticated
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.get_json()["user"]["email"] == "a@b.com"


def test_me_requires_auth(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/me/jobs").status_code == 401


def test_register_validation_and_duplicate(client):
    assert client.post("/api/auth/register", json={"email": "x@y.com", "password": "short"}).status_code == 400
    assert client.post("/api/auth/register", json={"email": "", "password": "password1"}).status_code == 400
    client.post("/api/auth/register", json={"email": "dup@y.com", "password": "password1"})
    dup = client.post("/api/auth/register", json={"email": "dup@y.com", "password": "password2"})
    assert dup.status_code == 409


def test_login_wrong_password(client):
    client.post("/api/auth/register", json={"email": "c@d.com", "password": "password1"})
    client.get("/api/auth/logout")  # drop the auto-login cookie
    bad = client.post("/api/auth/login", json={"email": "c@d.com", "password": "nope"})
    assert bad.status_code == 401
    good = client.post("/api/auth/login", json={"email": "c@d.com", "password": "password1"})
    assert good.status_code == 200


def test_login_is_throttled_per_account(client):
    client.post("/api/auth/register", json={"email": "guess@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    for _ in range(10):
        bad = client.post("/api/auth/login", json={"email": "guess@d.com", "password": "nope"})
        assert bad.status_code == 401
    # Past the ceiling even the right password waits, whatever the spelling.
    blocked = client.post("/api/auth/login", json={"email": " Guess@D.com ", "password": "password1"})
    assert blocked.status_code == 429
    assert "Too many sign-in attempts" in blocked.get_json()["error"]

    # Another account from the same address is still under its own ceiling.
    client.post("/api/auth/register", json={"email": "other@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    ok = client.post("/api/auth/login", json={"email": "other@d.com", "password": "password1"})
    assert ok.status_code == 200


def test_successful_sign_ins_never_count_toward_the_ceilings(client, monkeypatch):
    """A shared lab account, or a class behind one NAT, signs in many times
    with the right password; none of that may lock anyone out."""
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_IP", 3)
    client.post("/api/auth/register", json={"email": "lab@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    for _ in range(12):
        ok = client.post("/api/auth/login", json={"email": "lab@d.com", "password": "password1"})
        assert ok.status_code == 200
        client.post("/api/auth/logout")


def test_the_right_password_clears_the_account_count(client):
    client.post("/api/auth/register", json={"email": "typo@d.com", "password": "password1"})
    client.post("/api/auth/logout")
    for _ in range(9):
        assert client.post("/api/auth/login", json={"email": "typo@d.com", "password": "nope"}).status_code == 401
    assert client.post("/api/auth/login", json={"email": "typo@d.com", "password": "password1"}).status_code == 200
    client.post("/api/auth/logout")
    # A fresh allowance: nine more typos still get a 401, not a lockout.
    for _ in range(9):
        assert client.post("/api/auth/login", json={"email": "typo@d.com", "password": "nope"}).status_code == 401


def test_login_is_throttled_per_ip(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    monkeypatch.setattr(bp_mod, "LOGIN_MAX_PER_IP", 3)

    codes = [
        client.post("/api/auth/login", json={"email": f"spray{i}@d.com", "password": "nope"}).status_code
        for i in range(4)
    ]
    assert codes == [401, 401, 401, 429]


def test_register_is_throttled_per_ip(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    from services import auth_store
    sent = []
    monkeypatch.setattr(bp_mod, "REGISTER_MAX_PER_IP", 2)
    monkeypatch.setattr(bp_mod.mailer, "send", lambda to, *_args: sent.append(to) or True)

    codes = [
        client.post("/api/auth/register", json={"email": f"new{i}@d.com", "password": "password1"}).status_code
        for i in range(3)
    ]
    assert codes == [201, 201, 429]
    assert sent == ["new0@d.com", "new1@d.com"]
    assert auth_store.authenticate("new2@d.com", "password1") is None


def test_the_signup_name_is_escaped_in_the_html_email(client, monkeypatch):
    import api.auth_blueprint as bp_mod
    mails = []
    monkeypatch.setattr(
        bp_mod.mailer, "send",
        lambda to, subject, text, html: mails.append((text, html)) or True,
    )
    name = '<a href="https://evil.example">Click here</a>'

    r = client.post("/api/auth/register", json={
        "email": "phish@d.com", "password": "password1", "name": name,
    })
    assert r.status_code == 201
    client.post("/api/auth/logout")
    client.post("/api/auth/forgot-password", json={"email": "phish@d.com"})

    assert len(mails) == 2  # verification, then reset
    for text, html in mails:
        assert "&lt;a href=&quot;https://evil.example&quot;&gt;Click here&lt;/a&gt;" in html
        assert html.count("<a href=") == 1  # only the real link
        # The plain-text part is not HTML, so it carries the name as typed.
        assert text.startswith(f"Hi {name},")


def test_admin_coupon_requires_authentication(client, monkeypatch):
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(b"local-admin-coupon").hexdigest(),
    )
    response = client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": "local-admin-coupon"}
    )
    assert response.status_code == 401


def test_admin_coupon_grants_unlimited_plan_without_admin_role(client, monkeypatch):
    """The coupon unlocks model limits server-side but is not an admin role."""
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    client.post("/api/auth/register", json={
        "email": "coupon@example.com", "password": "password1",
    })

    invalid = client.post("/api/auth/redeem-admin-coupon", json={"coupon": "wrong"})
    assert invalid.status_code == 403

    redeemed = client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": coupon}
    )
    assert redeemed.status_code == 200
    assert redeemed.get_json()["access"] == "admin_coupon"
    assert redeemed.get_json()["user"]["plan"] == "enterprise"
    assert redeemed.get_json()["user"]["roles"] == []

    usage = client.get("/api/me/usage").get_json()
    assert usage["plan"] == "enterprise"
    assert usage["limits"]["models"] is None


def test_admin_coupon_keeps_plan_unchanged_for_malformed_input(client, monkeypatch):
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    client.post("/api/auth/register", json={
        "email": "malformed-coupon@example.com", "password": "password1",
    })

    for payload in ({}, {"coupon": 123}, {"coupon": ""}, {"coupon": "x" * 257}):
        response = client.post("/api/auth/redeem-admin-coupon", json=payload)
        assert response.status_code == 400
        assert client.get("/api/auth/me").get_json()["user"]["plan"] == "free"


def test_admin_coupon_rate_limits_failed_attempts(client, monkeypatch):
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    client.post("/api/auth/register", json={
        "email": "rate-limited-coupon@example.com", "password": "password1",
    })

    responses = [
        client.post("/api/auth/redeem-admin-coupon", json={"coupon": "wrong"})
        for _ in range(6)
    ]
    assert [response.status_code for response in responses[:5]] == [403] * 5
    assert responses[5].status_code == 429
    assert client.get("/api/auth/me").get_json()["user"]["plan"] == "free"


def test_admin_coupon_persists_and_unblocks_both_media_models_without_admin_role(
    client, monkeypatch
):
    coupon = "local-admin-coupon"
    monkeypatch.setenv(
        "BODYMAPS_ADMIN_COUPON_SHA256",
        hashlib.sha256(coupon.encode("utf-8")).hexdigest(),
    )
    response = client.post("/api/auth/register", json={
        "email": "media-coupon@example.com", "password": "password1",
    })
    user_id = response.get_json()["user"]["id"]
    assert client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": coupon}
    ).status_code == 200

    from services import plan_store, role_store

    me = client.get("/api/auth/me").get_json()["user"]
    assert me["plan"] == "enterprise"
    assert me["roles"] == []
    assert not role_store.has_role(user_id, role_store.ROLE_ADMIN)
    assert plan_store.check_inference(user_id, "cads551") is None
    assert plan_store.check_inference(user_id, "cads552") is None


def test_admin_coupon_requires_server_configuration(client, monkeypatch):
    monkeypatch.delenv("BODYMAPS_ADMIN_COUPON_SHA256", raising=False)
    client.post("/api/auth/register", json={
        "email": "unconfigured@example.com", "password": "password1",
    })
    response = client.post(
        "/api/auth/redeem-admin-coupon", json={"coupon": "anything"}
    )
    assert response.status_code == 503


def test_logout_clears_session(client):
    client.post("/api/auth/register", json={"email": "e@f.com", "password": "password1"})
    assert client.get("/api/auth/me").status_code == 200
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401


def test_me_jobs_empty_for_new_user(client):
    client.post("/api/auth/register", json={"email": "g@h.com", "password": "password1"})
    r = client.get("/api/me/jobs")
    assert r.status_code == 200
    assert r.get_json() == {"jobs": []}


def _write_run(runs, session_id, **record):
    folder = runs / session_id
    folder.mkdir(parents=True)
    (folder / "job.json").write_text(json.dumps(record))


def test_me_runs_requires_auth(client):
    assert client.get("/api/me/runs").status_code == 401


def test_me_runs_lists_only_my_runs_newest_first(client, tmp_path, monkeypatch):
    import api.api_blueprint as api_routes
    runs = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    me = client.post("/api/auth/register", json={"email": "r@s.com", "password": "password1"}).get_json()["user"]["id"]
    _write_run(runs, "older", user_id=me, status="completed", model="ePAI", created_at=1_700_000_000,
               ct_path="/srv/sessions/older/ct.nii.gz", zip_path="/srv/sessions/older/auto_masks.zip")
    _write_run(runs, "newer", user_id=me, status="failed", model="LesionSegmenter", created_at=1_700_000_500)
    _write_run(runs, "someone-elses", user_id="another-user", status="completed", model="ePAI", created_at=1_700_000_900)
    _write_run(runs, "unowned", status="completed", model="ePAI", created_at=1_700_000_900)

    r = client.get("/api/me/runs")

    assert r.status_code == 200
    body = r.get_json()
    assert [run["session_id"] for run in body["runs"]] == ["newer", "older"]
    assert body["runs"][1] == {
        "session_id": "older", "model": "ePAI", "status": "completed",
        "created_at": "2023-11-14T22:13:20+00:00",
    }
    assert "/srv" not in r.get_data(as_text=True)  # no server paths


def test_me_runs_owned_requires_auth(client):
    assert client.post("/api/me/runs/owned", json={"session_ids": ["a"]}).status_code == 401


def test_me_runs_owned_names_only_the_callers_sessions_including_ones_the_listing_cuts_off(client, tmp_path, monkeypatch):
    import api.api_blueprint as api_routes
    runs = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    me = client.post("/api/auth/register", json={"email": "o@w.com", "password": "password1"}).get_json()["user"]["id"]
    for i in range(60):
        _write_run(runs, f"s{i:02d}", user_id=me, status="completed", model="ePAI", created_at=1_700_000_000 + i)
    _write_run(runs, "theirs", user_id="another-user", status="completed", model="ePAI", created_at=1_700_000_900)

    listed = {run["session_id"] for run in client.get("/api/me/runs").get_json()["runs"]}
    assert "s00" not in listed  # cut off by the listing's cap

    r = client.post("/api/me/runs/owned", json={"session_ids": ["s00", "s59", "theirs", "nothing"]})

    assert r.status_code == 200
    assert r.get_json() == {"owned": ["s00", "s59"]}


def test_me_runs_owned_rejects_a_body_it_cannot_use(client):
    client.post("/api/auth/register", json={"email": "p@w.com", "password": "password1"})

    assert client.post("/api/me/runs/owned", json={}).status_code == 400
    assert client.post("/api/me/runs/owned", json={"session_ids": "abc"}).status_code == 400
    assert client.post("/api/me/runs/owned", json={"session_ids": ["a"] * 501}).status_code == 400
    assert client.post("/api/me/runs/owned", data="not json", content_type="text/plain").status_code == 400


def test_me_runs_is_capped_at_fifty(client, tmp_path, monkeypatch):
    import api.api_blueprint as api_routes
    runs = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    me = client.post("/api/auth/register", json={"email": "t@u.com", "password": "password1"}).get_json()["user"]["id"]
    for i in range(60):
        _write_run(runs, f"s{i:02d}", user_id=me, status="completed", model="ePAI", created_at=1_700_000_000 + i)

    listed = client.get("/api/me/runs").get_json()["runs"]

    assert len(listed) == 50
    assert listed[0]["session_id"] == "s59"


def test_me_runs_reports_a_run_this_process_is_running_as_running(client, tmp_path, monkeypatch):
    import api.api_blueprint as api_routes
    runs = tmp_path / "runs"
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(runs))
    me = client.post("/api/auth/register", json={"email": "v@x.com", "password": "password1"}).get_json()["user"]["id"]
    _write_run(runs, "live", user_id=me, status="running", model="ePAI", created_at=1_700_000_100)
    _write_run(runs, "dead", user_id=me, status="running", model="ePAI", created_at=1_700_000_000)
    monkeypatch.setitem(api_routes.inference_jobs, "live", {"user_id": me, "status": "running"})

    listed = client.get("/api/me/runs").get_json()["runs"]

    assert {run["session_id"]: run["status"] for run in listed} == {"live": "running", "dead": "failed"}


# ---- display name ---------------------------------------------------------

def test_register_accepts_a_name_and_me_returns_it(client):
    r = client.post("/api/auth/register",
                    json={"email": "n@o.com", "password": "password1", "name": "Ada Lovelace"})
    assert r.get_json()["user"]["name"] == "Ada Lovelace"
    assert client.get("/api/auth/me").get_json()["user"]["name"] == "Ada Lovelace"


def test_patch_me_updates_the_name(client):
    client.post("/api/auth/register", json={"email": "p@q.com", "password": "password1"})
    assert client.get("/api/auth/me").get_json()["user"]["name"] is None

    r = client.patch("/api/auth/me", json={"name": "Grace Hopper"})
    assert r.status_code == 200
    assert r.get_json()["user"]["name"] == "Grace Hopper"
    assert client.get("/api/auth/me").get_json()["user"]["name"] == "Grace Hopper"


def test_patch_me_updates_the_profile_fields(client):
    client.post("/api/auth/register", json={"email": "p2@q.com", "password": "password1"})
    r = client.patch("/api/auth/me", json={
        "organization": "  Example University  ",
        "occupation": "Radiology resident",
        "role_description": "Annotating pancreas CTs for a research project",
    })
    assert r.status_code == 200
    u = r.get_json()["user"]
    assert u["organization"] == "Example University"     # trimmed
    assert u["occupation"] == "Radiology resident"
    assert u["role_description"].startswith("Annotating")

    # Blank clears back to "not provided"; other fields are untouched.
    r = client.patch("/api/auth/me", json={"organization": ""})
    assert r.get_json()["user"]["organization"] is None
    assert r.get_json()["user"]["occupation"] == "Radiology resident"

    # Wrong type is refused.
    assert client.patch("/api/auth/me", json={"occupation": 7}).status_code == 400


def test_patch_me_rejects_an_empty_body_and_a_non_string(client):
    client.post("/api/auth/register", json={"email": "r@s.com", "password": "password1"})
    assert client.patch("/api/auth/me", json={}).status_code == 400
    assert client.patch("/api/auth/me", json={"name": 42}).status_code == 400


def test_the_verified_researcher_journey_promotes_to_pro(client):
    from services import auth_store

    client.post("/api/auth/register", json={"email": "vr@x.com", "password": "password1"})
    body = client.get("/api/me/usage").get_json()
    assert body["plan"] == "free" and body["limits"]["daily_scans"] == 1

    client.patch("/api/auth/me", json={
        "organization": "Example University",
        "occupation": "Radiologist",
        "role_description": "Annotating CTs for a research project",
    })
    # A complete profile alone is not enough.
    assert client.get("/api/me/usage").get_json()["plan"] == "free"

    user_id = client.get("/api/auth/me").get_json()["user"]["id"]
    _, raw = auth_store.create_email_verification(user_id)
    assert client.post("/api/auth/verify-email", json={"token": raw}).status_code == 200

    body = client.get("/api/me/usage").get_json()
    assert body["plan"] == "pro"
    assert body["limits"]["daily_scans"] == 10
    # The stored column is untouched, and self-service plan writes stay closed.
    assert client.get("/api/auth/me").get_json()["user"]["plan"] == "free"
    assert client.post("/api/me/plan", json={"plan": "team"}).status_code == 403


def test_send_verification_requires_auth_and_verify_rejects_garbage(client):
    assert client.post("/api/auth/send-verification").status_code == 401
    r = client.post("/api/auth/verify-email", json={"token": "nope"})
    assert r.status_code == 400

    # Signed in and unverified: the endpoint reports honestly whether mail
    # left the building (unconfigured SMTP logs the link and says sent=False).
    client.post("/api/auth/register", json={"email": "v@w.com", "password": "password1"})
    r = client.post("/api/auth/send-verification")
    assert r.status_code == 200
    body = r.get_json()
    assert body["ok"] is True and body["already_verified"] is False


def test_account_endpoints_require_auth(client):
    assert client.patch("/api/auth/me", json={"name": "x"}).status_code == 401
    assert client.get("/api/me/export").status_code == 401
    assert client.delete("/api/me/jobs").status_code == 401
    assert client.delete("/api/me").status_code == 401


# ---- export ---------------------------------------------------------------

def test_export_returns_only_the_account_basics(client):
    client.post("/api/auth/register",
                json={"email": "t@u.com", "password": "password1", "name": "Ada"})
    r = client.get("/api/me/export")
    assert r.status_code == 200
    assert "attachment" in r.headers["Content-Disposition"]

    body = r.get_json()
    assert set(body) == {"exported_at", "account"}
    assert set(body["account"]) == {
        "email", "name", "account_type", "plan", "created_at",
        "organization", "occupation", "role_description",
    }
    assert body["account"]["email"] == "t@u.com"
    assert body["account"]["name"] == "Ada"
    assert body["account"]["plan"] == "free"
    assert "id" not in body["account"]        # nothing internal
    assert "jobs" not in body                 # no server paths
    assert "password_hash" not in str(body)   # never leak the hash


# ---- deletion -------------------------------------------------------------

def test_delete_jobs_keeps_the_account(client, tmp_path, monkeypatch):
    import api.api_blueprint as api_routes
    # Upload page runs are looked for in their own folder; keep it in the test's.
    monkeypatch.setattr(api_routes, "SESSIONS_DIR", str(tmp_path / "runs"))
    client.post("/api/auth/register", json={"email": "v@w.com", "password": "password1"})
    r = client.delete("/api/me/jobs")
    assert r.status_code == 200
    assert r.get_json()["deleted"] == {"jobs": 0, "files": 0, "runs": 0}
    assert client.get("/api/auth/me").status_code == 200  # still signed in


def test_delete_account_signs_out_and_reports_the_deadline(client):
    client.post("/api/auth/register", json={"email": "x@y.com", "password": "password1"})
    r = client.delete("/api/me")
    assert r.status_code == 200
    body = r.get_json()
    assert body["grace_days"] == 30
    assert body["restore_by"] > body["deletion_requested_at"]

    # session is gone
    assert client.get("/api/auth/me").status_code == 401


def test_signing_back_in_restores_a_deleted_account(client):
    client.post("/api/auth/register", json={"email": "z@a.com", "password": "password1"})
    client.delete("/api/me")
    assert client.get("/api/auth/me").status_code == 401

    back = client.post("/api/auth/login", json={"email": "z@a.com", "password": "password1"})
    assert back.status_code == 200
    assert client.get("/api/auth/me").status_code == 200


def test_new_account_reports_the_free_plan(client):
    r = client.post("/api/auth/register", json={"email": "p@q.com", "password": "password1"})
    assert r.get_json()["user"]["plan"] == "free"


def test_plan_and_usage_require_auth(client):
    assert client.get("/api/me/usage").status_code == 401
    assert client.post("/api/me/plan", json={"plan": "pro"}).status_code == 401


def _register_admin(client, email="p@q.com"):
    """Register, stay signed in, and hold admin. The paid plans are closed to
    everyone else, so this is the only account that can change plan."""
    from services import role_store
    r = client.post("/api/auth/register", json={"email": email, "password": "password1"})
    user_id = r.get_json()["user"]["id"]
    role_store.grant(user_id, role_store.ROLE_ADMIN)
    return user_id


def test_changing_plan_changes_the_reported_limits(client):
    _register_admin(client)

    r = client.post("/api/me/plan", json={"plan": "pro"})
    assert r.status_code == 200
    assert r.get_json()["user"]["plan"] == "pro"
    assert client.get("/api/auth/me").get_json()["user"]["plan"] == "pro"


def test_an_ordinary_account_is_held_on_free(client):
    """The paid plans aren't open yet. The picker greys them out; this is the
    half that matters, because a disabled button only stops a click."""
    client.post("/api/auth/register", json={"email": "p@q.com", "password": "password1"})

    before = client.get("/api/me/usage").get_json()
    assert before["plan"] == "free"
    assert before["limits"]["daily_scans"] == 1
    assert before["limits"]["models"] == ["LesionSegmenter"]

    for plan in ("pro", "team", "enterprise"):
        assert client.post("/api/me/plan", json={"plan": plan}).status_code == 403

    # Still free, and still on free's limits.
    assert client.get("/api/me/usage").get_json()["plan"] == "free"
    assert client.post("/api/me/plan", json={"plan": "free"}).status_code == 200


def test_an_admin_reports_unlimited_whatever_plan_they_are_on(client):
    """Admins bypass the limits without their account changing plan."""
    _register_admin(client)
    usage = client.get("/api/me/usage").get_json()
    assert usage["plan"] == "free"
    assert usage["limits"]["daily_scans"] is None
    assert usage["limits"]["models"] is None


def test_unknown_plan_is_rejected(client):
    _register_admin(client)
    assert client.post("/api/me/plan", json={"plan": "platinum"}).status_code == 400
    assert client.post("/api/me/plan", json={}).status_code == 400
