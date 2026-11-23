"""Regression coverage for Webapp Web Push enrollment and delivery."""
import json
import time
from types import SimpleNamespace

import pytest

from gateway.session_authorities import LocalBot, SessionAuthorities
from gateway.session_authority import SessionAuthority
from gateway.web_push import store
from gateway.web_push.delivery import WebPush, installation_digest
from hermes_cli.browser_credential import generation
from hermes_state import SessionDB
from hermes_state_runtime import begin_runtime_epoch
from tests.gateway.test_web_push import _admit, _complete, _register, credentials, db, endpoint
from tests.hermes_cli.test_webapp_gated_sign_out import _sign_in_with_oauth, _sign_in_with_password, gated, sign_out
from tests.hermes_cli.test_webapp_push import DESKTOP, PATH, PHONE, _headers


@pytest.fixture
def fixture(gated, monkeypatch, tmp_path, credentials):
    state = gated.server.app.state
    sends = []

    def send(subscription, **kwargs):
        sends.append((subscription, json.loads(kwargs["data"])))
        return SimpleNamespace(status_code=201, headers={})

    home = tmp_path / ".hermes"
    beta = home / "profiles" / "beta"
    beta.mkdir(parents=True)
    (beta / "config.yaml").write_text("{}")
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    token = set_hermes_home_override(tmp_path / "store-home")
    try:
        session_store = SessionStore(tmp_path / "store-home" / "sessions", GatewayConfig())
    finally:
        reset_hermes_home_override(token)
    registry = SessionAuthorities(home, multiplexed=True)
    runner = SimpleNamespace(web_push=WebPush(credentials, send=send), session_authorities=registry,
                             session_store=session_store, _draining=False, adapters={}, _cached_agent_for=lambda _route: None)
    with SessionDB(tmp_path / "default.db") as db, SessionDB(tmp_path / "beta.db") as profile_db:
        runner.web_push.control_db = db
        authorities = {}
        for name, path, ledger in (("default", home, db), ("beta", beta, profile_db)):
            owner = SessionAuthority(runner, profile_id=str(path), instance_id="review", db=ledger,
                                     epoch=begin_runtime_epoch(ledger, instance_id="review"))
            registry.add(path, owner, name=name)
            authorities[name] = owner
        from gateway.session_local_recovery import local_adapter
        runner._adapter_for_source = lambda source: local_adapter(authorities.get(source.profile, authorities["default"]))
        runner.session_authority = authorities["default"]
        monkeypatch.setattr(state, "gateway_runner", runner, raising=False)
        monkeypatch.setattr(state, "session_authority", runner.session_authority, raising=False)
        browser = gated.browser()
        _sign_in_with_password(browser)
        yield SimpleNamespace(browser=browser, runner=runner, default=authorities["default"],
                              beta=authorities["beta"], sends=sends)


def _enroll(browser, endpoint, device=PHONE, profile=None):
    return browser.post(PATH + "/subscribe", headers=_headers(device), json=endpoint,
                        params={"profile": profile} if profile else {})


def _act(browser, action, profile=None, body=None):
    return browser.post(PATH + "/" + action, headers=_headers(PHONE), json={} if body is None else body,
                        params={"profile": profile} if profile else {})


def _due_now(authority):
    authority.db._execute_write(lambda conn: conn.execute(
        "UPDATE web_push_outbox SET due_at=0 WHERE due_at IS NOT NULL"))


def test_logout_revokes_and_same_installation_can_enroll_as_new_owner(fixture, gated, endpoint):
    browser, authority, push = fixture.browser, fixture.default, fixture.runner.web_push
    assert _enroll(browser, endpoint).status_code == 200
    another_browser = gated.browser()
    _sign_in_with_password(another_browser)
    other_endpoint = {**endpoint, "endpoint": endpoint["endpoint"] + "-other-device"}
    assert _enroll(another_browser, other_endpoint, device=DESKTOP).status_code == 200
    assert _act(browser, "test").json() == {"applied": True}
    assert browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    assert browser.get(PATH, headers=_headers(PHONE)).status_code == 401
    push.deliver_one(authority, "default", generation())
    assert fixture.sends == []
    _sign_in_with_oauth(browser)
    assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is False
    assert _enroll(browser, endpoint).status_code == 200
    assert another_browser.get(PATH, headers=_headers(DESKTOP)).json()["active"] is True


def test_access_cookie_expiry_and_same_owner_relogin_preserve_enrollment(fixture, endpoint):
    browser = fixture.browser
    assert _enroll(browser, endpoint).status_code == 200
    for cookie in list(browser.cookies.jar):
        if "hermes_session_at" in cookie.name:
            browser.cookies.jar.clear(cookie.domain, cookie.path, cookie.name)
    _sign_in_with_password(browser)
    assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is True


def test_subscription_material_must_match_and_unreadable_storage_retires_grant(fixture, endpoint):
    browser, authority, push = fixture.browser, fixture.default, fixture.runner.web_push
    assert _enroll(browser, endpoint).status_code == 200
    assert _act(browser, "check", body=endpoint).json() == {"active": True}
    renewed = {**endpoint, "endpoint": endpoint["endpoint"] + "-renewed"}
    assert _act(browser, "check", body=renewed).json() == {"active": False}
    assert _act(browser, "test").status_code == 200
    authority.db._execute_write(lambda conn: conn.execute("UPDATE web_push_subscriptions SET sealed=X'00'"))
    assert push.deliver_one(authority, "default", generation())
    assert fixture.sends == []
    assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is False
    assert _act(browser, "test").status_code == 409
    assert _enroll(browser, renewed).status_code == 200
    assert _act(browser, "check", body=renewed).json() == {"active": True}


def test_storage_key_rotation_requires_repair(fixture, endpoint, credentials):
    browser = fixture.browser
    assert _enroll(browser, endpoint).status_code == 200
    from gateway.web_push.delivery import _b64
    fixture.runner.web_push = WebPush({**credentials, "storage_key": _b64(bytes([88] * 32))},
                                      send=fixture.runner.web_push.send, control_db=fixture.default.db)
    assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is False
    assert _act(browser, "test").status_code == 409
    assert fixture.sends == []
    assert _enroll(browser, endpoint).status_code == 200
    assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is True


def test_disable_all_revokes_offline_profile_with_pending_entry(fixture, endpoint, monkeypatch, tmp_path):
    from hermes_cli.web_routers import web_push
    browser, authority, push = fixture.browser, fixture.beta, fixture.runner.web_push
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _act(browser, "test", profile="beta").json() == {"applied": True}
    with monkeypatch.context() as patch:
        patch.setattr(web_push, "local_bots", lambda runner: [LocalBot("default", tmp_path, fixture.default)])
        assert _act(browser, "disable-all").json() == {"applied": True}
    assert browser.get(PATH, params={"profile": "beta"}, headers=_headers(PHONE)).json()["active"] is False
    push.deliver_one(authority, "beta", generation())
    assert fixture.sends == []


def test_seen_cannot_cancel_after_grace(db):
    _register(db)
    _admit(db, "phone")
    row = _complete(db)
    now = time.time()
    db._execute_write(lambda conn: conn.execute("UPDATE web_push_outbox SET due_at=?", (now - 60,)))
    assert not db._execute_write(lambda conn: store.seen(conn, row["admission_id"], "phone", "owner", "login"))


def test_actual_webpush_codec_and_http_response_sequence(fixture, endpoint, credentials, monkeypatch):
    from gateway.web_push import delivery

    http = []
    responses = iter((429, 503, 201))
    class Connection:
        def __init__(self, host, port, **kwargs):
            assert (host, port) == ("fcm.googleapis.com", 443)
            assert kwargs["context"].check_hostname
        def request(self, method, path, body, headers):
            http.append((method, path, body, headers))
        def getresponse(self):
            status = next(responses)
            return SimpleNamespace(status=status, getheader=lambda name: "11" if status == 429 else None)
        def close(self):
            pass

    monkeypatch.setattr(delivery, "_PushConnection", Connection)
    browser, authority = fixture.browser, fixture.default
    fixture.runner.web_push = push = WebPush(credentials)
    assert _enroll(browser, endpoint).status_code == 200
    assert _act(browser, "test").status_code == 200
    for count in range(1, 4):
        _due_now(authority)
        assert push.deliver_one(authority, "default", generation())
        assert len(http) == count
        assert not push.deliver_one(authority, "default", generation())
    method, path, ciphertext, headers = http[0]
    assert (method, path) == ("POST", "/wp/endpoint-for-testing")
    assert b"test" not in ciphertext and headers["content-encoding"] == "aes128gcm"
    assert headers["authorization"].startswith("vapid ")
    assert _act(browser, "test").status_code == 429


def _socket_request(browser, device, method, params, profile="beta"):
    minted = browser.post("/api/webapp/socket-ticket", headers=_headers(device),
                          params={"socket": "gateway", "profile": profile})
    assert minted.status_code == 200, minted.text
    origin = str(browser.base_url).rstrip("/")
    socket_origin = origin.replace("http", "ws", 1)
    with browser.websocket_connect(f"{socket_origin}/api/ws?native_dial=browser&profile={profile}",
                                   headers={"origin": origin},
                                   subprotocols=["hermes-gateway-v1",
                                                 "hermes-gateway-ticket." + minted.json()["ticket"]]) as ws:
        if method == "prompt.submit":
            ws.send_json({"jsonrpc": "2.0", "id": "resume", "method": "session.resume",
                          "params": {"session_id": params["session_id"]}})
            for _ in range(20):
                response = ws.receive_json()
                if response.get("id") == "resume":
                    assert "result" in response, response
                    break
            else:
                pytest.fail("Resume reply missing")
        ws.send_json({"jsonrpc": "2.0", "id": "review", "method": method, "params": params})
        for _ in range(10):
            response = ws.receive_json()
            if response.get("id") == "review":
                assert "result" in response, response
                return response["result"]
        pytest.fail("RPC reply missing")


def test_real_socket_first_admission_survives_disconnect_and_other_device_retry(fixture, endpoint, monkeypatch):
    from hermes_state_runtime import claim_session_input, settle_session_input

    browser, authority = fixture.browser, fixture.beta
    monkeypatch.setattr(authority, "_schedule_admitted", lambda *_: None)
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    desktop_endpoint = {**endpoint, "endpoint": endpoint["endpoint"] + "-desktop"}
    assert _enroll(browser, desktop_endpoint, device=DESKTOP, profile="beta").status_code == 200
    created = _socket_request(browser, PHONE, "session.create", {"request_id": "webpush-review-create", "model": "gpt-4o-mini", "source": "gui"})
    sid = created["session_id"]
    prompt = {"session_id": sid, "submission_id": "webpush-review-submit", "text": "test response"}
    first = _socket_request(browser, PHONE, "prompt.submit", prompt)
    retry = _socket_request(browser, DESKTOP, "prompt.submit", prompt)
    assert retry["admission_id"] == first["admission_id"]
    claimed = claim_session_input(authority.db, epoch=authority.epoch, session_id=sid)
    settled = settle_session_input(authority.db, epoch=authority.epoch, admission_id=claimed["admission_id"],
                                   generation=claimed["generation"], outcome="completed")
    assert settled["web_push"]
    assert browser.post(PATH + "/seen", headers=_headers(DESKTOP),
                        params={"profile": "beta"}, json=first["admission_id"]).json() == {"applied": False}
    _due_now(authority)
    assert fixture.runner.web_push.deliver_one(authority, "beta", generation())
    assert fixture.sends == [(endpoint, {"kind": "turn", "id": first["admission_id"],
                                         "session": sid, "profile": "beta"})]

    pending = _socket_request(browser, PHONE, "prompt.submit", {**prompt, "submission_id": "disabled-while-pending"})
    assert _act(browser, "disable", profile="beta").json() == {"applied": True}
    claimed = claim_session_input(authority.db, epoch=authority.epoch, session_id=sid)
    assert claimed["admission_id"] == pending["admission_id"]
    canceled_push = settle_session_input(authority.db, epoch=authority.epoch,
                                         admission_id=claimed["admission_id"],
                                         generation=claimed["generation"], outcome="completed")
    assert canceled_push["web_push"]
    _due_now(authority)
    assert not fixture.runner.web_push.deliver_one(authority, "beta", generation())
    assert len(fixture.sends) == 1


def test_disable_serializes_with_in_progress_transport(fixture, endpoint, credentials, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from gateway.web_push import delivery

    transport_entered, allow_post = Event(), Event()
    posted = []

    class Connection:
        def __init__(self, *args, **kwargs):
            transport_entered.set()
            assert allow_post.wait(5)
        def request(self, *args, **kwargs):
            posted.append(True)
        def getresponse(self):
            return SimpleNamespace(status=201, getheader=lambda name: None)
        def close(self):
            pass

    monkeypatch.setattr(delivery, "_PushConnection", Connection)
    browser, authority = fixture.browser, fixture.default
    fixture.runner.web_push = push = WebPush(credentials)
    assert _enroll(browser, endpoint).status_code == 200
    assert _act(browser, "test").status_code == 200
    with ThreadPoolExecutor(max_workers=2) as executor:
        delivering = executor.submit(push.deliver_one, authority, "default", generation())
        try:
            assert transport_entered.wait(5)
            disabling = executor.submit(_act, browser, "disable")
            # The handler durably revokes before waiting for the in-flight sender.
            from tests.waiting import wait_until
            wait_until(lambda: browser.get(PATH, headers=_headers(PHONE)).json()["active"] is False, timeout=4)
            assert not disabling.done()
        finally:
            allow_post.set()
        assert delivering.result(timeout=5)
        assert disabling.result(timeout=5).json() == {"applied": True}
    assert posted == [True]


def test_revocation_timeout_reports_uncertainty_and_keeps_future_sends_disabled(fixture, endpoint, monkeypatch):
    browser, authority, push = fixture.browser, fixture.default, fixture.runner.web_push
    assert _enroll(browser, endpoint).status_code == 200
    assert _act(browser, "test").status_code == 200
    monkeypatch.setattr(push, "wait_for_dispatch", lambda device: False)
    response = _act(browser, "disable-all")
    assert response.status_code == 503
    assert "unconfirmed" in response.json()["detail"]
    assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is False
    assert not push.deliver_one(authority, "default", generation())
    assert fixture.sends == []


def test_expired_access_cookie_explicit_logout_revokes_its_pending_delivery(fixture, endpoint):
    browser, authority, push = fixture.browser, fixture.default, fixture.runner.web_push
    assert _enroll(browser, endpoint).status_code == 200
    assert _act(browser, "test").status_code == 200
    for cookie in list(browser.cookies.jar):
        if "hermes_session_at" in cookie.name:
            browser.cookies.jar.clear(cookie.domain, cookie.path, cookie.name)
    assert browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    push.deliver_one(authority, "default", generation())
    assert fixture.sends == []
    _sign_in_with_oauth(browser)
    assert _enroll(browser, endpoint).status_code == 200


def test_repeated_old_logout_cannot_revoke_new_owner(fixture, gated, endpoint):
    browser, authority, push = fixture.browser, fixture.default, fixture.runner.web_push
    assert _enroll(browser, endpoint).status_code == 200
    old_browser = gated.browser()
    old_browser.cookies.update(browser.cookies)
    assert browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    _sign_in_with_oauth(browser)
    assert _enroll(browser, endpoint).status_code == 200
    assert _act(browser, "test").status_code == 200
    assert old_browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    active = browser.get(PATH, headers=_headers(PHONE)).json()["active"]
    push.deliver_one(authority, "default", generation())
    assert (active, len(fixture.sends)) == (True, 1)


def test_global_signout_allows_new_owner_to_enroll_on_same_installation(fixture, gated, sign_out, endpoint):
    browser, authority, push = fixture.browser, fixture.default, fixture.runner.web_push
    assert _enroll(browser, endpoint).status_code == 200
    assert _act(browser, "test").status_code == 200
    next_owner = gated.browser()
    _sign_in_with_oauth(next_owner)
    assert _enroll(next_owner, endpoint).status_code == 409
    sign_out()
    push.deliver_one(authority, "default", generation())
    assert fixture.sends == []
    _sign_in_with_oauth(next_owner)
    assert next_owner.get(PATH, headers=_headers(PHONE)).json()["active"] is False
    assert _enroll(next_owner, endpoint).status_code == 200


def test_hidden_profile_disable_does_not_leave_queued_delivery_alive(
        fixture, endpoint, credentials, monkeypatch, tmp_path):
    from hermes_cli.web_routers import web_push

    browser, beta, push = fixture.browser, fixture.beta, fixture.runner.web_push
    for profile in ("beta", "default"):
        assert _enroll(browser, endpoint, profile=profile).status_code == 200
        assert _act(browser, "test", profile=profile).status_code == 200
    with monkeypatch.context() as patch:
        patch.setattr(web_push, "local_bots", lambda runner: [LocalBot("default", tmp_path, fixture.default)])
        status = browser.get(PATH, headers=_headers(PHONE), params={"profile": "beta"})
        assert status.json() == {"available": False, "active": False}
        disabled = _act(browser, "disable", profile="beta")
    assert disabled.json() == {"applied": True}
    with SessionDB(fixture.default.db.db_path) as control, SessionDB(beta.db.db_path) as ledger:
        restarted = WebPush(credentials, send=push.send, control_db=control)
        authority = SimpleNamespace(profile_id=beta.profile_id, db=ledger)
        restarted.deliver_one(authority, "beta", generation())
        restarted.deliver_one(fixture.default, "default", generation())
    assert [data["profile"] for _, data in fixture.sends] == ["default"]
    assert _enroll(browser, endpoint, profile="beta").status_code == 200


def test_logout_and_retry_finish_while_existing_send_is_in_flight(fixture, gated, endpoint, credentials, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    from gateway.web_push import delivery

    browser, authority = fixture.browser, fixture.default
    entered, release = Event(), Event()
    posted = []

    class Connection:
        def __init__(self, *_args, **_kwargs):
            entered.set()
            assert release.wait(15)

        def request(self, *_args, **_kwargs):
            posted.append(True)

        def getresponse(self):
            return SimpleNamespace(status=503, getheader=lambda name: None)

        def close(self):
            pass

    def logout(client):
        return client.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False)

    monkeypatch.setattr(delivery, "_PushConnection", Connection)
    fixture.runner.web_push = push = WebPush(credentials, control_db=authority.db)
    for profile in ("default", "beta"):
        assert _enroll(browser, endpoint, profile=profile).status_code == 200
        assert _act(browser, "test", profile=profile).status_code == 200
    old_cookies = dict(browser.cookies)
    replay = gated.browser()
    replay.cookies.update(old_cookies)
    with ThreadPoolExecutor(max_workers=2) as pool:
        sending = pool.submit(push.deliver_one, authority, "default", generation())
        try:
            assert entered.wait(4)
            first = pool.submit(logout, browser).result(timeout=4)
            assert (first.status_code, first.headers["location"]) == (302, "/login")
            assert browser.get(PATH, headers=_headers(PHONE)).status_code == 401
            assert pool.submit(logout, replay).result(timeout=4).status_code == 302
            assert not sending.done() and posted == []
        finally:
            release.set()
        assert sending.result(timeout=5)

    # The retryable failure cannot schedule another attempt, and the other profile's queue is fenced.
    _due_now(authority)
    assert not push.deliver_one(authority, "default", generation())
    assert push.deliver_one(fixture.beta, "beta", generation())
    assert posted == [True]

    _sign_in_with_oauth(browser)
    assert _enroll(browser, endpoint).status_code == 200
    replay.cookies.update(old_cookies)
    assert logout(replay).status_code == 302
    assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is True
