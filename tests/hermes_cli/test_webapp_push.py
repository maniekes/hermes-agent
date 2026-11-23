"""Use the real cookie gate and one-use Webapp ticket path without a live listener."""
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

from gateway.session_authorities import LocalBot
from gateway.web_push import store
from gateway.web_push.delivery import WebPush, installation_digest
from hermes_cli.browser_credential import generation
from hermes_cli.dashboard_auth.ws_tickets import consume_ticket
from hermes_state import SessionDB
from tests.gateway.test_web_push import credentials, endpoint
from tests.hermes_cli.test_webapp_gated_sign_out import WEBAPP, _sign_in_with_oauth, _sign_in_with_password, gated

PATH = "/api/webapp/web-push"
PHONE = "a3" * 32
DESKTOP = "b4" * 32


def _headers(installation, origin=WEBAPP):
    return {"X-Hermes-Push-Installation": installation, "Origin": origin,
            "Sec-Fetch-Site": "same-origin" if origin == WEBAPP else "cross-site"}


def test_profile_scoped_cookie_routes_and_ticket(gated, monkeypatch, tmp_path, credentials, endpoint):
    browser = gated.browser()
    server = gated.server
    with SessionDB(tmp_path / "default.db") as primary, SessionDB(tmp_path / "other.db") as other:
        default = SimpleNamespace(db=primary, profile_id="default")
        secondary = SimpleNamespace(db=other, profile_id="other")
        push = WebPush(credentials)
        runner = SimpleNamespace(session_authority=default, web_push=push)
        monkeypatch.setattr(server.app.state, "gateway_runner", runner, raising=False)
        monkeypatch.setattr(server.app.state, "session_authority", default, raising=False)
        from hermes_cli.web_routers import web_push
        monkeypatch.setattr(web_push, "local_bots", lambda runner: [
            LocalBot("default", tmp_path, default), LocalBot("other", tmp_path, secondary)])
        monkeypatch.setattr(server.app.state, "web_dist", tmp_path, raising=False)
        (tmp_path / "hermes-notifications-sw.js").write_text("// static fixture", encoding="utf-8")
        assert browser.get("/hermes-notifications-sw.js").text == "// static fixture"
        assert browser.get("/hermes-notifications-sw.js").headers["cache-control"] == "no-cache"
        assert browser.get(PATH, headers=_headers(PHONE)).status_code == 401
        logged_out = browser.get("/?profile=other&pushSession=older-chat", follow_redirects=False)
        assert logged_out.status_code == 302
        assert parse_qs(urlsplit(logged_out.headers["location"]).query)["next"] == [
            "/?profile=other&pushSession=older-chat"]
        _sign_in_with_password(browser)
        assert browser.get(PATH, headers=_headers(DESKTOP)).json()["active"] is False
        assert browser.post(PATH + "/subscribe", headers=_headers(PHONE, "https://cross.example"),
                            json=endpoint).status_code == 403
        assert browser.post(PATH + "/subscribe", headers={
            **_headers(PHONE), "Content-Type": "application/json"}, content=b"0" * 4097).status_code == 413
        bad = {**endpoint, "endpoint": "https://127.0.0.1/wp/should-not-be-contacted"}
        assert browser.post(PATH + "/subscribe", headers=_headers(PHONE), json=bad).status_code == 400
        assert browser.post(PATH + "/subscribe", headers=_headers(PHONE), json=endpoint).json() == {"active": True}
        assert browser.post(PATH + "/subscribe", headers=_headers(DESKTOP), json=endpoint).status_code == 409
        assert browser.get(PATH + "?profile=other", headers=_headers(PHONE)).json()["active"] is False
        assert browser.get(PATH, headers=_headers(PHONE)).json() == {
            "active": True, "available": True, "conversationPolicy": True, "preview": False, "publicKey": push.public_key}
        other_login = gated.browser()
        _sign_in_with_oauth(other_login)
        assert other_login.get(PATH, headers=_headers(PHONE)).json()["active"] is False
        assert other_login.post(PATH + "/disable", headers=_headers(PHONE), json={}).json() == {"applied": False}
        assert other_login.post(PATH + "/test", headers=_headers(PHONE), json={}).status_code == 409
        ticket = browser.post("/api/webapp/socket-ticket?socket=gateway", headers=_headers(PHONE))
        admitted = consume_ticket(ticket.json()["ticket"])
        assert admitted["push_device"] == installation_digest(PHONE)
        assert admitted["sign_in"] == generation()
        assert PHONE not in ticket.text and endpoint["endpoint"] not in ticket.text
        assert browser.post(PATH + "/test", headers=_headers(DESKTOP), json={}).status_code == 409
        assert browser.post(PATH + "/test", headers=_headers(PHONE), json={}).json()["applied"] is True
        assert browser.post(PATH + "/disable?profile=other", headers=_headers(PHONE), json={}).json() == {"applied": False}
        assert browser.post(PATH + "/disable-all", headers=_headers(PHONE), json={}).json() == {"applied": True}
        assert browser.get(PATH, headers=_headers(PHONE)).json()["active"] is False
        with primary._read_ctx() as conn:
            assert store.next_delivery(conn, float("inf")) is None
            assert not conn.execute("SELECT 1 FROM web_push_outbox WHERE due_at IS NOT NULL").fetchone()
