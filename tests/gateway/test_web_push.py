"""Canonical ledger, grant and delivery contracts for response-ready Web Push."""
import json
from pathlib import Path
import time
from types import SimpleNamespace

import pytest

from gateway.web_push import store
from gateway.web_push.delivery import WebPush, endpoint_route, installation_digest, retry_at
from hermes_state import SessionDB
from hermes_state_runtime import (
    admit_session_input, begin_runtime_epoch, claim_session_input, recover_session_inputs,
    resolve_unknown_session_input, settle_session_input,
)


@pytest.fixture
def db(tmp_path):
    database = SessionDB(tmp_path / "state.db")
    database.create_session("chat", source="test")
    assert begin_runtime_epoch(database, instance_id="first") == 1
    yield database
    database.close()


def _register(db, device="phone", owner="owner"):
    return db._execute_write(lambda conn: store.subscribe(
        conn, device, owner, "login", "key", device, b"encrypted", time.time()))


def _admit(db, device, owner="owner", request="input", epoch=1):
    return admit_session_input(
        db, epoch=epoch, principal_id="host-owner", session_id="chat", request_id=request,
        payload={"text": "hello"},
        _on_new_admission=lambda conn, admission: store.bind(conn, admission, device, owner, "login", "key"),
    )


def _complete(db, *, epoch=1, outcome="completed"):
    claim = claim_session_input(db, epoch=epoch, session_id="chat")
    return settle_session_input(
        db, epoch=epoch, admission_id=claim["admission_id"], generation=claim["generation"], outcome=outcome)


def _due(db):
    with db._read_ctx() as conn:
        return store.next_delivery(conn, time.time() + 10)


def test_bind_only_on_new_admission_and_settle_after_commit(db):
    _register(db, "phone")
    _register(db, "desktop")
    first = _admit(db, "phone")
    assert _admit(db, "desktop")["admission_id"] == first["admission_id"]
    assert _due(db) is None
    assert _complete(db)["web_push"] is True
    delivery = _due(db)
    assert delivery["device"] == "phone"
    assert delivery["session_id"] == "chat"
    assert not db._execute_write(lambda conn: store.seen(conn, delivery["id"], "desktop", "owner", "login"))
    assert not db._execute_write(lambda conn: store.seen(conn, delivery["id"], "phone", "other", "login"))
    assert db._execute_write(lambda conn: store.seen(conn, delivery["id"], "phone", "owner", "login"))
    assert _due(db) is None


def test_forged_grants_and_failed_turns_do_not_deliver(db):
    _register(db)
    _admit(db, "phone", "other", request="other-owner")
    _admit(db, "unregistered", request="forged")
    _admit(db, "phone", request="failed")
    assert "web_push" not in _complete(db)
    assert "web_push" not in _complete(db)
    assert _complete(db, outcome="failed")["web_push"] is True
    assert _due(db) is None


def test_revoke_pending_and_retire_only_exact_version(db):
    first = _register(db)
    _admit(db, "phone")
    assert _complete(db)["web_push"]
    assert not db._execute_write(lambda conn: store.revoke(conn, "phone", "other", "login"))
    assert _due(db) is not None
    assert db._execute_write(lambda conn: store.revoke(conn, "phone", "owner", "login"))
    assert _due(db) is None
    fresh = _register(db)
    assert first != fresh
    db._execute_write(lambda conn: store.retire(conn, "phone", first))
    with db._read_ctx() as conn:
        assert store.subscription(conn, "phone", "owner", "login", "key")["version"] == fresh


def test_restart_recovers_committed_outbox_but_does_not_run_unknown(db):
    _register(db)
    _admit(db, "phone", request="done")
    _admit(db, "phone", request="lost")
    done = _complete(db)
    lost = claim_session_input(db, epoch=1, session_id="chat")
    with SessionDB(Path(db.db_path)) as reopened:
        epoch = begin_runtime_epoch(reopened, instance_id="second")
        assert recover_session_inputs(reopened, epoch=epoch) == 1
        assert _due(reopened)["id"] == done["admission_id"]
        reopened._execute_write(lambda conn: store.seen(conn, done["admission_id"], "phone", "owner", "login"))
        resolved = resolve_unknown_session_input(
            reopened, epoch=epoch, admission_id=lost["admission_id"], generation=lost["generation"])
        assert resolved["outcome"] == "interrupted"
        assert _due(reopened) is None


def test_recovered_captured_success_is_enqueued(db):
    _register(db)
    _admit(db, "phone")
    claimed = claim_session_input(db, epoch=1, session_id="chat")
    db._execute_write(lambda conn: conn.execute(
        "UPDATE session_admissions SET status='unknown' WHERE admission_id=?", (claimed["admission_id"],)))
    recovered = resolve_unknown_session_input(
        db, epoch=1, admission_id=claimed["admission_id"], generation=claimed["generation"],
        _captured=("completed", {"result": {"final_response": "private"}, "usage": {}}))
    assert recovered["web_push"]
    assert _due(db)["id"] == claimed["admission_id"]


@pytest.fixture
def credentials():
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from gateway.web_push.delivery import _b64

    fixture_key = ec.derive_private_key(1, ec.SECP256R1())
    return {
        "vapid_private_key": fixture_key.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption()).decode(),
        "storage_key": _b64(bytes(32)), "contact": "mailto:web-push@example.org",
    }


@pytest.fixture
def endpoint(credentials):
    from gateway.web_push.delivery import _b64

    push = WebPush(credentials)
    return {
        "endpoint": "https://fcm.googleapis.com/wp/endpoint-for-testing",
        "expirationTime": None,
        "keys": {"p256dh": push.public_key, "auth": _b64(bytes(16))},
    }


def test_encrypted_store_retries_and_expired_provider(db, credentials, endpoint):
    requests = []
    statuses = iter((429, 410))

    def fake_send(subscription, **kwargs):
        requests.append((subscription, kwargs))
        return SimpleNamespace(status_code=next(statuses), headers={"Retry-After": "42"})

    push = WebPush(credentials, send=fake_send)
    authority = SimpleNamespace(db=db, profile_id="sample")
    device = installation_digest("a" * 64)
    assert push.register(authority, device, "owner", "login", endpoint)
    with db._read_ctx() as conn:
        saved = store.subscription(conn, device, "owner", "login", push.vapid_id)
        assert endpoint["endpoint"].encode() not in saved["sealed"]
        assert saved["endpoint"] != endpoint["endpoint"]
    binding = lambda conn, admission: store.bind(conn, admission, device, "owner", "login", push.vapid_id)
    admit_session_input(db, epoch=1, principal_id="human", session_id="chat", request_id="turn",
                        payload={"text": "private prompt"}, _on_new_admission=binding)
    assert _complete(db)["web_push"]
    db._execute_write(lambda conn: conn.execute("UPDATE web_push_outbox SET due_at=0"))
    assert push.deliver_one(authority, "sample", "login")
    assert not push.deliver_one(authority, "sample", "login")
    with db._read_ctx() as conn:
        row = conn.execute("SELECT attempts, due_at FROM web_push_outbox").fetchone()
        assert row["attempts"] == 1 and row["due_at"] >= time.time() + 40
    data = json.loads(requests[0][1]["data"])
    assert data == {"id": data["id"], "kind": "turn", "profile": "sample", "session": "chat"}
    db._execute_write(lambda conn: conn.execute("UPDATE web_push_outbox SET due_at=0"))
    assert push.deliver_one(authority, "sample", "login")
    with db._read_ctx() as conn:
        assert store.subscription(conn, device, "owner", "login", push.vapid_id) is None


@pytest.mark.parametrize("host", ["127.0.0.1", "fcm.googleapis.com.evil.example", "fcm.googleapis.com@127.0.0.1"])
def test_hostile_endpoint_is_refused(host):
    with pytest.raises(ValueError):
        endpoint_route(f"https://{host}/wp/endpoint-for-testing")


def test_retry_is_bounded():
    assert retry_at(500, "", 1, 100, 200) >= 110
    assert retry_at(None, "", 1, 100, 106) is None
    assert retry_at(429, "120", 1, 100, 200) is None
    assert retry_at(302, "", 1, 100, 200) is None


@pytest.mark.asyncio
async def test_listener_starts_and_stops_one_optional_sender(tmp_path, monkeypatch, credentials):
    import asyncio

    from gateway.run_api import GatewayDashboardMount
    from gateway.webapp_listener import WebappMount

    home = tmp_path / "home"
    path = home / "webapp" / "web-push.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(credentials), encoding="utf-8")
    path.chmod(0o600)
    started = asyncio.Event()

    async def run(push, runner, stopped, _login):
        assert runner.web_push is push
        started.set()
        await stopped.wait()

    monkeypatch.setattr(WebPush, "run", run)
    web = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(auth_required=True)))
    runner = SimpleNamespace()
    off = GatewayDashboardMount(runner, SimpleNamespace(webapp=WebappMount(tmp_path, home)))
    await off._start_web_push(web)
    assert not hasattr(runner, "web_push")
    await off.close()

    mount = GatewayDashboardMount(runner, SimpleNamespace(webapp=WebappMount(tmp_path, home, web_push=True)))
    await mount._start_web_push(web)
    await asyncio.wait_for(started.wait(), timeout=5)
    assert runner.web_push.public_key
    await mount.close()
    assert runner.web_push is None
    assert mount._push_task.done()
