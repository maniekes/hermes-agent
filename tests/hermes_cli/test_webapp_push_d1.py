"""D1 contracts through authenticated Webapp, canonical settlement and fake provider."""
import json
import time

import pytest

from hermes_cli.browser_credential import generation
from hermes_state_runtime import (
    begin_runtime_epoch, cancel_session_input, claim_session_input, recover_session_inputs, settle_session_input,
)
from tests.hermes_cli.test_webapp_push_lifecycle import (
    DESKTOP, PHONE, _act, _due_now, _enroll, _response_ready_policy, _socket_request,
    credentials, endpoint, fixture, gated,
)

FAILURE = "The response could not be completed."
CANARY = "synthetic-private-error-canary"


def admit(fixture, monkeypatch, *, policy="on", device=PHONE, claim=True):
    browser = fixture.browser
    authority = fixture.beta
    monkeypatch.setattr(authority, "_schedule_admitted", lambda *_: None)
    sid = _socket_request(browser, PHONE, "session.create", {
        "request_id": "create", "model": "gpt-4o-mini", "source": "gui",
    })["session_id"]
    _response_ready_policy(browser, sid, policy)
    assert authority.db.set_session_title(sid, "Synthetic conversation")
    receipt = _socket_request(browser, device, "prompt.submit", {
        "session_id": sid, "submission_id": "turn", "text": "Synthetic question",
    })
    if not claim:
        return receipt, sid
    started = claim_session_input(authority.db, epoch=authority.epoch, session_id=sid)
    assert started["admission_id"] == receipt["admission_id"]
    return started, sid


def settle(authority, started, outcome, **options):
    answer = "Synthetic successful reply." if outcome == "completed" else CANARY
    result = {"final_response": answer, "messages": [{"role": "tool", "content": CANARY}]}
    if outcome == "failed":
        result.update(error=CANARY, stack=CANARY, provider_dump={"raw": CANARY})
    return settle_session_input(
        authority.db, epoch=authority.epoch, admission_id=started["admission_id"],
        generation=started["generation"], outcome=outcome, result={"result": result}, **options)


@pytest.mark.parametrize("preview", [False, True])
def test_terminal_failure_uses_only_initiating_installation_and_safe_source(fixture, endpoint, monkeypatch, preview):
    browser, authority, push = fixture.browser, fixture.beta, fixture.runner.web_push
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    desktop_endpoint = {**endpoint, "endpoint": endpoint["endpoint"] + "-desktop"}
    assert _enroll(browser, desktop_endpoint, device=DESKTOP, profile="beta").status_code == 200
    assert _act(browser, "privacy", "beta", {"preview": preview}).json() == {"preview": preview}
    started, sid = admit(fixture, monkeypatch)
    # The same admission returned to the other device never changes its originally bound recipient.
    replay = _socket_request(browser, DESKTOP, "prompt.submit", {
        "session_id": sid, "submission_id": "turn", "text": "Synthetic question",
    })
    assert replay["admission_id"] == started["admission_id"]
    assert not push.deliver_one(authority, "beta", generation())
    def fail_write(*_):
        raise RuntimeError("synthetic settlement rollback")

    with pytest.raises(RuntimeError, match="synthetic settlement rollback"):
        settle(authority, started, "failed", _terminal_write=fail_write)
    assert not push.deliver_one(authority, "beta", generation())
    assert settle(authority, started, "failed")["outcome"] == "failed"

    _due_now(authority)
    assert push.deliver_one(authority, "beta", generation())
    assert not push.deliver_one(authority, "beta", generation())
    expected = {"kind": "turn", "id": started["admission_id"], "session": sid, "profile": "beta"}
    if preview:
        expected["preview"] = {"title": "Synthetic conversation", "body": FAILURE}
    assert fixture.sends == [(endpoint, expected)]
    assert CANARY not in json.dumps(fixture.sends)


def test_only_authorized_subscribe_confirms_profile_owner_and_preserves_principal(fixture, gated, endpoint):
    from gateway.owner_identity import host_owner_subject
    from tests.hermes_cli.test_webapp_gated_sign_out import _sign_in_with_oauth
    from tests.hermes_cli.test_webapp_push import PATH, _headers

    browser, authority = fixture.browser, fixture.beta
    assert _enroll(gated.browser(), endpoint, profile="beta").status_code == 401
    assert _enroll(browser, endpoint, profile="missing").status_code == 404
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    with fixture.default.db._read_ctx() as conn:
        assert conn.execute("SELECT count(*) FROM web_push_subscriptions").fetchone()[0] == 0

    def saved():
        with authority.db._read_ctx() as conn:
            return dict(conn.execute("SELECT * FROM web_push_subscriptions").fetchone())

    initial = saved()
    assert initial.get("authority_owner") == host_owner_subject()
    assert browser.post(PATH + "/subscribe", headers=_headers(PHONE), json=endpoint,
                        params=[("profile", "missing"), ("profile", "beta")]).status_code == 400
    other = gated.browser()
    _sign_in_with_oauth(other)
    assert _enroll(other, endpoint, profile="beta").status_code == 409
    assert saved() == initial

    # Simulate a legacy row. Passive status and Retry's check are reads even after migration.
    authority.db._execute_write(lambda conn: conn.execute("UPDATE web_push_subscriptions SET authority_owner=NULL"))
    assert browser.get(PATH, headers=_headers(PHONE), params={"profile": "beta"}).json()["active"] is True
    assert _act(browser, "check", "beta", endpoint).json() == {"active": True}
    assert saved()["authority_owner"] is None

    assert _act(browser, "privacy", "beta", {"preview": True}).json()["preview"] is True
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    renewed = saved()
    assert renewed["authority_owner"] == host_owner_subject()
    assert (renewed["owner"], renewed["version"], renewed["grant"], renewed["profile_grant"]) == (
        initial["owner"], initial["version"], initial["grant"], initial["profile_grant"])
    assert renewed["preview"] == 1


@pytest.mark.parametrize("scenario", [
    "completed", "interrupted", "unknown", "cancelled", "policy-off", "inherited-off",
    "master-off", "logout", "privacy-downgrade",
])
def test_turn_end_and_current_delivery_fences(fixture, endpoint, monkeypatch, scenario):
    browser, authority, push = fixture.browser, fixture.beta, fixture.runner.web_push
    from tests.hermes_cli.test_webapp_push import _headers

    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _act(browser, "privacy", "beta", {"preview": True}).json() == {"preview": True}
    policy = {"policy-off": "off", "inherited-off": "inherit"}.get(scenario, "on")
    started, sid = admit(fixture, monkeypatch, policy=policy, claim=scenario != "cancelled")
    if scenario == "cancelled":
        assert cancel_session_input(authority.db, epoch=authority.epoch,
                                    admission_id=started["admission_id"])["outcome"] == "cancelled"
    elif scenario == "unknown":
        epoch = begin_runtime_epoch(authority.db, instance_id="synthetic-restart")
        assert recover_session_inputs(authority.db, epoch=epoch) == 1
    else:
        outcome = scenario if scenario in {"completed", "interrupted"} else "failed"
        settle(authority, started, outcome)

    if scenario == "master-off":
        assert _act(browser, "disable-all").json()["applied"] is True
    if scenario == "logout":
        assert browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    if scenario == "privacy-downgrade":
        assert _act(browser, "privacy", "beta", {"preview": False}).json()["preview"] is False

    _due_now(authority)
    push.deliver_one(authority, "beta", generation())
    assert not push.deliver_one(authority, "beta", generation())
    expected = {"kind": "turn", "id": started["admission_id"], "session": sid, "profile": "beta"}
    if scenario == "completed":
        expected["preview"] = {"title": "Synthetic conversation", "body": "Synthetic successful reply."}
    assert fixture.sends == ([(endpoint, expected)] if scenario in {"completed", "privacy-downgrade"} else [])


def test_owner_stamp_is_not_a_grant_after_profile_revocation_or_logout(fixture, endpoint):
    from gateway.web_push.delivery import installation_digest
    from tests.hermes_cli.test_webapp_push import PATH, _headers

    browser, push = fixture.browser, fixture.runner.web_push
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _enroll(browser, endpoint, profile="default").status_code == 200
    device = installation_digest(PHONE)

    def active(authority, owner):
        return push.active(authority, device, owner, generation())

    with fixture.beta.db._read_ctx() as conn:
        beta_binding = dict(conn.execute("SELECT * FROM web_push_subscriptions").fetchone())
    assert beta_binding["authority_owner"]
    assert active(fixture.beta, beta_binding["owner"])["version"] == beta_binding["version"]
    assert active(fixture.beta, "synthetic-other-login") is None
    assert _act(browser, "disable", "beta").json()["applied"] is True
    assert active(fixture.beta, beta_binding["owner"]) is None
    assert active(fixture.default, beta_binding["owner"]) is not None
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert active(fixture.beta, beta_binding["owner"])["version"] != beta_binding["version"]

    assert browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    assert browser.get(PATH, params={"profile": "beta"}, headers=_headers(PHONE)).status_code == 401
    assert active(fixture.default, beta_binding["owner"]) is None
    assert active(fixture.beta, beta_binding["owner"]) is None



def test_stale_profile_authority_cannot_claim_installation_elsewhere(fixture, gated, endpoint):
    from tests.hermes_cli.test_webapp_gated_sign_out import _sign_in_with_oauth

    authority = fixture.beta
    begin_runtime_epoch(authority.db, instance_id="synthetic-replaced-authority")
    assert _enroll(fixture.browser, endpoint, profile="beta").status_code == 503
    other = gated.browser()
    _sign_in_with_oauth(other)
    assert _enroll(other, endpoint, profile="default").status_code == 200
    with authority.db._read_ctx() as conn:
        assert conn.execute("SELECT count(*) FROM web_push_subscriptions").fetchone()[0] == 0
    with fixture.default.db._read_ctx() as conn:
        assert [row[0] for row in conn.execute("SELECT profile FROM web_push_profile_grants")] == ["default"]


def test_draining_profile_and_endpoint_conflict_do_not_claim_device(fixture, gated, endpoint, monkeypatch):
    from gateway.web_push.delivery import installation_digest
    from tests.hermes_cli.test_webapp_gated_sign_out import _sign_in_with_oauth

    browser = fixture.browser
    with monkeypatch.context() as draining:
        draining.setattr(fixture.runner, "_draining", True)
        assert _enroll(browser, endpoint, profile="beta").status_code == 503
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _enroll(browser, endpoint, device=DESKTOP, profile="beta").status_code == 409
    with fixture.default.db._read_ctx() as conn:
        assert conn.execute("SELECT count(*) FROM web_push_devices WHERE device=?",
                            (installation_digest(DESKTOP),)).fetchone()[0] == 0
    other = gated.browser()
    _sign_in_with_oauth(other)
    assert _enroll(other, endpoint, device=DESKTOP, profile="default").status_code == 200


def test_unconfirmed_cross_database_write_is_reported_and_renewal_reconciles(fixture, endpoint, monkeypatch):
    import sqlite3

    from gateway.web_push.delivery import installation_digest
    from tests.hermes_cli.test_webapp_push import PATH, _headers

    browser, control, beta = fixture.browser, fixture.default.db, fixture.beta.db
    write = control._execute_write

    def control_failure(callback, *args, **kwargs):
        def lose_confirmation(conn):
            assert callback(conn) is not None
            raise sqlite3.OperationalError("synthetic control commit failure")
        return write(lose_confirmation, *args, **kwargs)

    with monkeypatch.context() as fault:
        fault.setattr(control, "_execute_write", control_failure)
        response = _enroll(browser, endpoint, profile="beta")
    assert response.status_code == 503
    assert response.json() == {"detail": "web_push_enrollment_unconfirmed"}
    assert browser.get(PATH, headers=_headers(PHONE), params={"profile": "beta"}).json()["active"] is False
    with beta._read_ctx() as conn:
        profile_row = conn.execute("SELECT * FROM web_push_subscriptions").fetchone()
        assert profile_row["version"]
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    selected = fixture.runner.web_push.active(fixture.beta, installation_digest(PHONE), profile_row["owner"], generation())
    assert selected["version"] == profile_row["version"]


def test_revocation_ordered_after_in_flight_renewal_still_revokes(fixture, endpoint, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from gateway.web_push import store
    from tests.hermes_cli.test_webapp_push import PATH, _headers

    browser = fixture.browser
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    profile_entered, release, revoke_requested = Event(), Event(), Event()
    subscribe, write = store.subscribe, fixture.default.db._execute_write

    def pause_profile(*args, **kwargs):
        profile_entered.set()
        assert release.wait(8)
        return subscribe(*args, **kwargs)

    def observe_control(callback, *args, **kwargs):
        if getattr(callback, "func", None) is store.revoke_device:
            revoke_requested.set()
        return write(callback, *args, **kwargs)

    monkeypatch.setattr(store, "subscribe", pause_profile)
    monkeypatch.setattr(fixture.default.db, "_execute_write", observe_control)
    with ThreadPoolExecutor(max_workers=2) as workers:
        renewal = workers.submit(_enroll, browser, endpoint, profile="beta")
        try:
            assert profile_entered.wait(8)
            revoke = workers.submit(_act, browser, "disable-all")
            assert revoke_requested.wait(8)
            assert not revoke.done()
        finally:
            release.set()
        assert renewal.result(timeout=8).status_code == 200
        assert revoke.result(timeout=8).json() == {"applied": True}
    assert browser.get(PATH, headers=_headers(PHONE), params={"profile": "beta"}).json()["active"] is False


def test_failed_settlement_wire_can_be_seen_only_by_initiating_installation(fixture, endpoint, monkeypatch):
    from gateway.session_settlement_recovery import completion_payload
    from tests.hermes_cli.test_webapp_push import PATH, _headers

    browser, authority = fixture.browser, fixture.beta
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _enroll(browser, {**endpoint, "endpoint": endpoint["endpoint"] + "-desktop"},
                   device=DESKTOP, profile="beta").status_code == 200
    started, _ = admit(fixture, monkeypatch)
    terminal = settle(authority, started, "failed")
    payload = completion_payload(started, terminal, CANARY, {"result": {"error_surface": {}}})
    assert (payload["status"], payload["outcome"], payload["web_push"]) == ("error", "failed", True)
    for device, expected in ((DESKTOP, False), (PHONE, True)):
        seen = browser.post(PATH + "/seen", headers=_headers(device), params={"profile": "beta"},
                            json=started["admission_id"])
        assert seen.json() == {"applied": expected}
    _due_now(authority)
    assert not fixture.runner.web_push.deliver_one(authority, "beta", generation())
    assert fixture.sends == []


def test_preview_requires_positive_terminal_receipt_on_synthetic_inconsistent_state(fixture, endpoint, monkeypatch):
    from gateway.web_push import store

    browser, authority = fixture.browser, fixture.beta
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    started, _ = admit(fixture, monkeypatch)
    settle(authority, started, "failed")
    _due_now(authority)

    class RestoreSyntheticState(Exception):
        pass

    def probe(conn):
        delivery = store.next_delivery(conn, time.time())
        assert store.preview_source(conn, delivery)["answer"] == FAILURE
        conn.execute("DELETE FROM session_admissions WHERE admission_id=?", (started["admission_id"],))
        assert store.preview_source(conn, delivery) is None
        raise RestoreSyntheticState

    with pytest.raises(RestoreSyntheticState):
        authority.db._execute_write(probe)
