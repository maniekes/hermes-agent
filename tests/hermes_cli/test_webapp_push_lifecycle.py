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


def _socket_request(browser, device, method, params, profile="beta", *, expect_error=None):
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
                if expect_error is not None:
                    assert response.get("error", {}).get("message") == expect_error, response
                    return response["error"]
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
    _response_ready_policy(browser, sid, "on")
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


def _preview_turn(fixture, monkeypatch, answer, *, title=None, profile="beta", request_id="preview-turn"):
    from hermes_state_runtime import claim_session_input, settle_session_input

    browser = fixture.browser
    authority = getattr(fixture, profile)
    monkeypatch.setattr(authority, "_schedule_admitted", lambda *_: None)
    created = _socket_request(browser, PHONE, "session.create",
                              {"request_id": request_id + "-create", "model": "gpt-4o-mini", "source": "gui"}, profile)
    sid = created["session_id"]
    _response_ready_policy(browser, sid, "on", profile=profile)
    if title is not None:
        assert authority.db.set_session_title(sid, title)
    receipt = _socket_request(browser, PHONE, "prompt.submit",
                              {"session_id": sid, "submission_id": request_id, "text": "synthetic prompt"}, profile)
    started = claim_session_input(authority.db, epoch=authority.epoch, session_id=sid)
    settle_session_input(
        authority.db, epoch=authority.epoch, admission_id=receipt["admission_id"],
        generation=started["generation"], outcome="completed",
        result={"result": {"final_response": answer, "messages": [
            {"role": "assistant", "content": "synthetic private progress", "tool_calls": []},
            {"role": "tool", "content": "synthetic private tool output"},
            {"role": "assistant", "content": answer},
        ]}},
    )
    _due_now(authority)
    return sid, receipt["admission_id"]


def test_preview_requires_explicit_scoped_consent_and_stays_generic_after_reenrollment(
        fixture, gated, endpoint, monkeypatch):
    browser, push = fixture.browser, fixture.runner.web_push
    for profile in ("default", "beta"):
        assert _enroll(browser, endpoint, profile=profile).status_code == 200
    assert browser.get(PATH, headers=_headers(PHONE), params={"profile": "beta"}).json().get("preview") is False
    sid, admission = _preview_turn(fixture, monkeypatch, "synthetic private answer", title="synthetic private title")
    assert push.deliver_one(fixture.beta, "beta", generation())
    assert fixture.sends[-1][1] == {"kind": "turn", "id": admission, "session": sid, "profile": "beta"}

    assert _act(browser, "privacy", "beta", {"preview": 1}).status_code == 400
    foreign = gated.browser()
    _sign_in_with_oauth(foreign)
    assert _act(foreign, "privacy", "beta", {"preview": True}).status_code == 409
    assert browser.post(PATH + "/privacy", headers=_headers(DESKTOP),
                        params={"profile": "beta"}, json={"preview": True}).status_code == 409
    assert browser.post(PATH + "/privacy", headers=_headers(PHONE, "https://cross.example"),
                        params={"profile": "beta"}, json={"preview": True}).status_code == 403
    assert _act(browser, "privacy", "beta", {"preview": True}).json() == {"preview": True}
    assert browser.get(PATH, headers=_headers(PHONE)).json()["preview"] is False
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert browser.get(PATH, headers=_headers(PHONE), params={"profile": "beta"}).json()["preview"] is True
    assert browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    assert _enroll(foreign, endpoint, profile="beta").status_code == 200
    assert foreign.get(PATH, headers=_headers(PHONE), params={"profile": "beta"}).json()["preview"] is False


def test_preview_reads_only_canonical_answer_and_retry_uses_current_privacy(fixture, endpoint, monkeypatch):
    browser, push = fixture.browser, fixture.runner.web_push
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _act(browser, "privacy", "beta", {"preview": True}).status_code == 200
    sent = []

    def send(_subscription, **kwargs):
        sent.append(kwargs["data"])
        return SimpleNamespace(status_code=503 if len(sent) == 1 else 201, headers={})

    monkeypatch.setattr(push, "send", send)
    title = "🧪" * 90
    answer = ("<think>secret reasoning</think> **Gotowe** [czytaj](https://example.test/private) "
              "![secret photo](file:///tmp/album.jpg) <img src='/tmp/another.jpg'>\n\n"
              "~~~python\nsynthetic_code()\n~~~\n\nMEDIA:/tmp/attachment.png\n\n" + "🧪" * 300)
    sid, admission = _preview_turn(fixture, monkeypatch, answer, title=title)
    assert push.deliver_one(fixture.beta, "beta", generation())
    payload = json.loads(sent[0])
    assert payload["preview"]["title"] == title[:79] + "…"
    assert payload["preview"]["body"] == ("Gotowe czytaj " + "🧪" * 300)[:239] + "…"
    assert len(sent[0].encode("utf-8")) < 2000
    assert _act(browser, "privacy", "beta", {"preview": False}).json() == {"preview": False}
    _due_now(fixture.beta)
    assert push.deliver_one(fixture.beta, "beta", generation())
    assert json.loads(sent[1]) == {"kind": "turn", "id": admission, "session": sid, "profile": "beta"}


@pytest.mark.parametrize(("answer", "preview"), [
    ("Wynik", {"body": "Wynik"}),
    ("Wynik ~~stary~~ <think>hidden <think>nested</think> still hidden</think>", {"body": "Wynik stary"}),
    ("Wynik <reasoning>unterminated private section", {"body": "Wynik"}),
    ("   ", None),
])
def test_preview_handles_missing_title_or_empty_canonical_answer(fixture, endpoint, monkeypatch, answer, preview):
    browser = fixture.browser
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _act(browser, "privacy", "beta", {"preview": True}).status_code == 200
    _preview_turn(fixture, monkeypatch, answer)
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert fixture.sends[-1][1].get("preview") == preview


def test_existing_enrollment_migrates_private_and_generic_cancels_queued_preview(fixture, endpoint, monkeypatch):
    browser, push = fixture.browser, fixture.runner.web_push
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    authority = fixture.beta
    authority.db._execute_write(lambda conn: conn.execute("ALTER TABLE web_push_subscriptions DROP COLUMN preview"))
    with SessionDB(authority.db.db_path):
        pass
    status = browser.get(PATH, headers=_headers(PHONE), params={"profile": "beta"})
    assert status.json()["active"] is True and status.json()["preview"] is False
    assert _act(browser, "privacy", "beta", {"preview": True}).status_code == 200
    _preview_turn(fixture, monkeypatch, "synthetic queued answer", title="synthetic queued title")
    assert _act(browser, "privacy", "beta", {"preview": False}).status_code == 200
    assert push.deliver_one(authority, "beta", generation())
    assert "preview" not in fixture.sends[-1][1]


def _response_ready_policy(browser, sid, mode=None, *, profile="beta"):
    info = _socket_request(browser, PHONE, "session.info", {"session_id": sid}, profile)
    current = info["response_ready_policy"]
    if mode is None:
        return current
    result = _socket_request(browser, PHONE, "session.mutate", {
        "session_id": sid, "request_id": "response-ready-" + str(current["revision"]),
        "expected_revision": current["revision"], "operation": "response_ready", "payload": {"mode": mode},
    }, profile)
    return result["response_ready_policy"]


def test_conversation_policy_defaults_off_and_on_uses_only_an_existing_admission_target(
        fixture, endpoint, monkeypatch):
    from hermes_state_runtime import claim_session_input, settle_session_input

    browser, beta, push = fixture.browser, fixture.beta, fixture.runner.web_push
    monkeypatch.setattr(beta, "_schedule_admitted", lambda *_: None)
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    sid = _socket_request(browser, PHONE, "session.create",
                          {"request_id": "policy-target", "model": "gpt-4o-mini", "source": "gui"})["session_id"]
    assert _response_ready_policy(browser, sid)["mode"] == "inherit"
    assert _response_ready_policy(browser, sid)["effective"] == "off"

    def submit(device, request):
        return _socket_request(browser, device, "prompt.submit",
                               {"session_id": sid, "submission_id": request, "text": "synthetic"})["admission_id"]

    def settle(admission, started=None):
        started = started or claim_session_input(beta.db, epoch=beta.epoch, session_id=sid)
        assert started["admission_id"] == admission
        settle_session_input(beta.db, epoch=beta.epoch, admission_id=admission,
                             generation=started["generation"], outcome="completed")
        _due_now(beta)

    settle(submit(PHONE, "off"))
    assert not push.deliver_one(beta, "beta", generation())
    no_target = submit(DESKTOP, "no-target")
    assert _response_ready_policy(browser, sid, "on")["effective"] == "on"
    settle(no_target)
    assert not push.deliver_one(beta, "beta", generation())

    assert _response_ready_policy(browser, sid, "off")["effective"] == "off"
    original = submit(PHONE, "original")
    started = claim_session_input(beta.db, epoch=beta.epoch, session_id=sid)
    assert _response_ready_policy(browser, sid, "on")["effective"] == "on"
    assert submit(DESKTOP, "original") == original
    settle(original, started)
    assert push.deliver_one(beta, "beta", generation())
    assert fixture.sends == [(endpoint, {"kind": "turn", "id": original, "session": sid, "profile": "beta"})]

    queued = submit(PHONE, "cancel-pending")
    settle(queued)
    _response_ready_policy(browser, sid, "off")
    _response_ready_policy(browser, sid, "on")
    assert not push.deliver_one(beta, "beta", generation())
    assert len(fixture.sends) == 1

    attempts = []
    monkeypatch.setattr(push, "send", lambda *_args, **_kwargs: (
        attempts.append(True) or SimpleNamespace(status_code=503, headers={})))
    settle(submit(PHONE, "cancel-retry"))
    assert push.deliver_one(beta, "beta", generation())
    _response_ready_policy(browser, sid, "inherit")
    assert _response_ready_policy(browser, sid)["effective"] == "off"
    _response_ready_policy(browser, sid, "on")
    _due_now(beta)
    assert not push.deliver_one(beta, "beta", generation())
    assert attempts == [True]
    assert _act(browser, "disable-all", "beta").json() == {"applied": True}
    settle(submit(PHONE, "master-disabled"))
    assert not push.deliver_one(beta, "beta", generation())


def test_profile_response_ready_default_is_shared_revisioned_and_isolated(fixture, gated, monkeypatch):
    path = PATH + "/profile-default"
    browser = fixture.browser
    origin = {"Origin": str(browser.base_url).rstrip("/")}
    other = gated.browser()
    _sign_in_with_password(other)

    def get(client, profile):
        return client.get(path, params={"profile": profile})

    def set_default(client, profile, enabled, revision, headers=origin):
        return client.post(path, headers=headers, params={"profile": profile},
                           json={"enabled": enabled, "expected_revision": revision})

    def create(client, name, profile):
        return _socket_request(client, PHONE, "session.create",
                               {"request_id": name, "model": "gpt-4o-mini", "source": "gui"}, profile)["session_id"]

    assert get(browser, "beta").json() == {"enabled": False, "revision": 0}
    assert get(browser, "default").json() == {"enabled": False, "revision": 0}
    assert get(browser, "absent").status_code == 503
    assert browser.get(path).status_code == 422
    assert browser.get(path, params=[("profile", "beta"), ("profile", "default")]).status_code == 400
    assert set_default(gated.browser(), "beta", True, 0).status_code == 401
    assert set_default(browser, "beta", True, 0, {"Origin": "https://other.example"}).status_code == 403
    assert set_default(browser, "beta", True, 0, {}).status_code == 403
    with monkeypatch.context() as expired:
        expired.setattr(fixture.beta, "epoch", fixture.beta.epoch - 1)
        assert set_default(browser, "beta", True, 0).status_code == 503
    assert get(browser, "beta").json() == {"enabled": False, "revision": 0}
    inherited = create(browser, "existing-inherit", "beta")
    explicit_on = create(browser, "explicit-on", "beta")
    explicit_off = create(browser, "explicit-off", "beta")
    _response_ready_policy(browser, explicit_on, "on")
    _response_ready_policy(browser, explicit_off, "off")

    def assert_policy(client, sid, mode, default, effective):
        policy = _response_ready_policy(client, sid)
        assert (policy["mode"], policy["default"], policy["effective"]) == (mode, default, effective)

    assert_policy(browser, inherited, "inherit", "off", "off")
    assert set_default(browser, "beta", True, 0).json() == {"enabled": True, "revision": 1}
    assert get(other, "beta").json() == {"enabled": True, "revision": 1}
    assert get(other, "default").json() == {"enabled": False, "revision": 0}
    assert set_default(other, "beta", False, 0).status_code == 409
    assert set_default(browser, "absent", False, 0).status_code == 503
    assert_policy(other, inherited, "inherit", "on", "on")
    fresh = create(other, "new-inherit", "beta")
    assert_policy(browser, fresh, "inherit", "on", "on")
    assert_policy(browser, explicit_on, "on", "on", "on")
    assert_policy(browser, explicit_off, "off", "on", "off")
    _response_ready_policy(browser, explicit_off, "inherit")
    assert_policy(browser, explicit_off, "inherit", "on", "on")
    assert set_default(other, "beta", False, 1).json() == {"enabled": False, "revision": 2}
    assert_policy(browser, inherited, "inherit", "off", "off")
    assert_policy(browser, explicit_on, "on", "off", "on")
    with SessionDB(fixture.beta.db.db_path) as reopened:
        from gateway.web_push.conversation import read_policy

        with reopened._read_ctx() as conn:
            assert read_policy(conn, fresh)[1] == {"mode": "inherit", "default": "off", "effective": "off"}


def test_profile_default_cancels_only_inherited_queue_and_retry(fixture, endpoint, monkeypatch):
    from hermes_state_runtime import claim_session_input, settle_session_input

    browser, beta, push = fixture.browser, fixture.beta, fixture.runner.web_push
    monkeypatch.setattr(beta, "_schedule_admitted", lambda *_: None)
    assert _enroll(browser, endpoint, profile="beta").status_code == 200

    def default(enabled, revision):
        return _act(browser, "profile-default", "beta", {"enabled": enabled, "expected_revision": revision})

    def create(key):
        return _socket_request(browser, PHONE, "session.create", {
            "request_id": key, "model": "gpt-4o-mini", "source": "gui",
        })["session_id"]

    def accept(sid, request, device=PHONE):
        result = _socket_request(browser, device, "prompt.submit", {
            "session_id": sid, "text": "synthetic", "submission_id": request,
        })
        row = claim_session_input(beta.db, epoch=beta.epoch, session_id=sid)
        assert row["admission_id"] == result["admission_id"]

        return row

    def complete(row):
        settle_session_input(beta.db, epoch=beta.epoch, admission_id=row["admission_id"],
                             generation=row["generation"], outcome="completed")
        _due_now(beta)
        return row["admission_id"]

    def settle(sid, request, device=PHONE):
        return complete(accept(sid, request, device))

    inherited, explicit = create("queue-inherit"), create("queue-explicit")
    active_without_target = accept(inherited, "no-recipient", DESKTOP)
    assert default(True, 0).status_code == 200
    complete(active_without_target)
    assert not push.deliver_one(beta, "beta", generation())

    attempts = []
    send = push.send
    monkeypatch.setattr(push, "send", lambda *_args, **_kwargs: (
        attempts.append(True) or SimpleNamespace(status_code=503, headers={})))
    retry = settle(inherited, "retry-inherited")
    assert push.deliver_one(beta, "beta", generation())
    assert len(attempts) == 1
    monkeypatch.setattr(push, "send", send)

    _response_ready_policy(browser, inherited, "on")
    queued = settle(inherited, "switch-to-inherit")
    _response_ready_policy(browser, inherited, "inherit")
    with beta.db._read_ctx() as conn:
        assert conn.execute("SELECT due_at FROM web_push_outbox WHERE id=?", (queued,)).fetchone()[0] is not None
    _response_ready_policy(browser, explicit, "on")
    kept = settle(explicit, "keep-explicit")
    assert default(False, 1).status_code == 200
    with beta.db._read_ctx() as conn:
        rows = {row["id"]: row["due_at"] for row in conn.execute(
            "SELECT id,due_at FROM web_push_outbox WHERE id IN (?,?,?)", (retry, queued, kept))}
    assert rows[retry] is rows[queued] is None
    assert rows[kept] is not None
    active_with_target = accept(inherited, "already-started-with-original-target")
    assert default(True, 2).status_code == 200
    _due_now(beta)
    assert push.deliver_one(beta, "beta", generation())
    assert not push.deliver_one(beta, "beta", generation())
    assert [payload["id"] for _, payload in fixture.sends] == [kept]
    active = complete(active_with_target)
    assert push.deliver_one(beta, "beta", generation())
    assert fixture.sends[-1][1]["id"] == active

    _response_ready_policy(browser, explicit, "inherit")
    preserved = settle(explicit, "inherit-on")
    assert push.deliver_one(beta, "beta", generation())
    assert fixture.sends[-1][1]["id"] == preserved
    assert _act(browser, "disable-all", "beta").json() == {"applied": True}
    settle(inherited, "device-off")
    assert not push.deliver_one(beta, "beta", generation())
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    settle(inherited, "logout-with-inherited-on")
    assert browser.post("/auth/logout", headers=_headers(PHONE), follow_redirects=False).status_code == 302
    push.deliver_one(beta, "beta", generation())
    assert [payload["id"] for _, payload in fixture.sends] == [kept, active, preserved]


def test_profile_default_resolves_compressed_outbox_segments_through_their_roots(
        fixture, endpoint, monkeypatch):
    from hermes_state_local import local_lineage_owner
    from hermes_state_runtime import admit_session_input, claim_session_input, settle_session_input

    browser, beta, push = fixture.browser, fixture.beta, fixture.runner.web_push
    monkeypatch.setattr(beta, "_schedule_admitted", lambda *_: None)
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _act(browser, "profile-default", "beta", {"enabled": True, "expected_revision": 0}).status_code == 200
    device = installation_digest(PHONE)
    login = generation()
    with beta.db._read_ctx() as conn:
        owner = conn.execute("SELECT owner FROM web_push_subscriptions WHERE device=?", (device,)).fetchone()[0]
    bind = push.binding(beta, device, owner, login)
    assert bind is not None

    def complete_compressed(mode):
        root = _socket_request(browser, PHONE, "session.create", {
            "request_id": "compressed-" + mode, "model": "gpt-4o-mini", "source": "gui",
        })["session_id"]
        if mode == "on":
            _response_ready_policy(browser, root, mode)
        child = "synthetic-tip-" + mode
        beta.db.publish_compression_child(parent_session_id=root, child_session_id=child, source="gui",
                                          messages=[{"role": "user", "content": "synthetic"}],
                                          require_compression_lease=False)
        with beta.db._read_ctx() as conn:
            assert local_lineage_owner(conn, child) == root
        assert beta.db.get_session(child)["response_ready"] == "inherit"
        admitted = admit_session_input(beta.db, epoch=beta.epoch, principal_id=owner, session_id=child,
                                       request_id="post-compression", payload={"text": "synthetic"},
                                       _on_new_admission=bind)
        started = claim_session_input(beta.db, epoch=beta.epoch, session_id=child)
        assert started["admission_id"] == admitted["admission_id"]
        settle_session_input(beta.db, epoch=beta.epoch, admission_id=admitted["admission_id"],
                             generation=started["generation"], outcome="completed")
        return admitted["admission_id"]

    inherited, explicit = complete_compressed("inherit"), complete_compressed("on")
    assert _act(browser, "profile-default", "beta", {"enabled": False, "expected_revision": 1}).status_code == 200
    _due_now(beta)
    assert push.deliver_one(beta, "beta", login)
    assert not push.deliver_one(beta, "beta", login)
    assert [payload["id"] for _, payload in fixture.sends] == [explicit]
    with beta.db._read_ctx() as conn:
        assert conn.execute("SELECT due_at FROM web_push_outbox WHERE id=?",
                            (inherited,)).fetchone()[0] is None


def test_session_info_pairs_response_ready_policy_with_its_revision(fixture, gated, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from gateway.web_push import conversation

    reader = fixture.browser
    writer = gated.browser()
    _sign_in_with_password(writer)
    sid = _socket_request(reader, PHONE, "session.create", {
        "request_id": "policy-snapshot", "model": "gpt-4o-mini", "source": "gui",
    })["session_id"]
    initial = _response_ready_policy(reader, sid)
    assert (initial["mode"], initial["default"], initial["effective"]) == ("inherit", "off", "off")

    sampled, release = Event(), Event()
    read_policy = conversation.read_policy

    def pause_after_policy_read(conn, session_id, **options):
        value = read_policy(conn, session_id, **options)
        if session_id == sid and not sampled.is_set():
            sampled.set()
            assert release.wait(8)
        return value

    monkeypatch.setattr(conversation, "read_policy", pause_after_policy_read)
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(_response_ready_policy, reader, sid)
        try:
            assert sampled.wait(5)
            assert _act(writer, "profile-default", "beta", {"enabled": True, "expected_revision": 0}).status_code == 200
            _response_ready_policy(writer, sid, "on")
            current = _response_ready_policy(writer, sid)
            assert (current["mode"], current["default"], current["effective"]) == ("on", "on", "on")
            assert current["revision"] > initial["revision"]
        finally:
            release.set()
        observed = pending.result(timeout=5)

    assert observed == initial
    _socket_request(reader, PHONE, "session.mutate", {
        "session_id": sid, "request_id": "write-from-stale-snapshot",
        "expected_revision": observed["revision"], "operation": "response_ready", "payload": {"mode": "off"},
    }, expect_error="revision_conflict")
    assert _response_ready_policy(reader, sid) == current


def test_warm_click_authorizes_only_the_delivered_session_and_current_enrollment(fixture, endpoint, monkeypatch):
    assert _enroll(fixture.browser, endpoint, profile="beta").status_code == 200
    sid, admission = _preview_turn(fixture, monkeypatch, "Synthetic completed turn")
    target = {"id": admission, "session": sid}
    assert _act(fixture.browser, "open", "beta", target).json() == {"allowed": False}
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    assert _act(fixture.browser, "open", "beta", target).json() == {"allowed": True}
    assert _act(fixture.browser, "open", "beta", {**target, "session": "wrong"}).json() == {"allowed": False}
    assert _act(fixture.browser, "open", "default", target).json() == {"allowed": False}
    assert fixture.browser.post(PATH + "/open", headers=_headers(DESKTOP), json=target,
                                params={"profile": "beta"}).json() == {"allowed": False}
    assert _act(fixture.browser, "disable", "beta").json() == {"applied": True}
    assert _act(fixture.browser, "open", "beta", target).json() == {"allowed": False}



def test_warm_click_sign_in_failure_leaves_the_cold_post_login_target(fixture, gated, endpoint, monkeypatch, tmp_path):
    from urllib.parse import parse_qs, urlsplit

    from tests.hermes_cli.test_webapp_gated_sign_out import PASSWORD, USER

    assert _enroll(fixture.browser, endpoint, profile="beta").status_code == 200
    sid, admission = _preview_turn(fixture, monkeypatch, "Synthetic completed turn")
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())
    target = {"id": admission, "session": sid}
    cold_link = "/?profile=beta&pushSession=" + sid
    (tmp_path / "index.html").write_text("<html><head></head><body>Synthetic app</body></html>")
    monkeypatch.setattr(gated.server.app.state, "web_dist", tmp_path, raising=False)
    signed_out = gated.browser()
    assert _act(signed_out, "open", "beta", target).status_code == 401
    redirected = signed_out.get(cold_link, follow_redirects=False)
    assert redirected.status_code == 302
    login = urlsplit(redirected.headers["location"])
    assert login.path == "/login" and parse_qs(login.query) == {"next": [cold_link]}
    login_response = signed_out.post("/auth/password-login", json={
        "provider": "basic", "username": USER, "password": PASSWORD, "next": cold_link,
    })
    assert login_response.json() == {"ok": True, "next": cold_link}
    assert signed_out.get(cold_link, follow_redirects=False).status_code == 200

    foreign = gated.browser()
    _sign_in_with_oauth(foreign)
    assert _act(foreign, "open", "beta", target).json() == {"allowed": False}
    csrf = fixture.browser.post(PATH + "/open", params={"profile": "beta"}, json=target,
                                headers=_headers(PHONE, "https://different.invalid"))
    assert csrf.status_code == 403


def test_warm_click_checks_subscription_version_at_target_lookup(fixture, endpoint, monkeypatch):
    assert _enroll(fixture.browser, endpoint, profile="beta").status_code == 200
    sid, admission = _preview_turn(fixture, monkeypatch, "Synthetic completed turn")
    assert fixture.runner.web_push.deliver_one(fixture.beta, "beta", generation())

    read_target = store.click_target

    def replace_enrollment(conn, row, event_id, session_id, now):
        fixture.beta.db._execute_write(lambda writer: store.retire(writer, row["device"], row["version"]))
        return read_target(conn, row, event_id, session_id, now)

    # Change the profile's subscription after the first read, without a direct
    # global grant change (unavailable material/re-enrollment can do this).
    monkeypatch.setattr(store, "click_target", replace_enrollment)
    target = {"id": admission, "session": sid}
    assert _act(fixture.browser, "open", "beta", target).json() == {"allowed": False}
