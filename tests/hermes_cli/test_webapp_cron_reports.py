"""Conversation report publication, FIFO, and authenticated installation-specific push."""

import asyncio
import sqlite3

import pytest

from cron import conversation_reports, delivery_queue, jobs
from gateway import session_cron
from gateway.session_cron_reports import _identity
from hermes_cli.browser_credential import generation
from hermes_constants import reset_hermes_home_override, set_hermes_home_override
from hermes_state import SessionDB
from hermes_state_runtime import begin_runtime_epoch, recover_session_inputs
from tests.hermes_cli import test_webapp_push_lifecycle as fixtures
from tests.hermes_cli.test_webapp_push import PATH, _headers
from tests.hermes_cli.test_webapp_push_lifecycle import (
    DESKTOP, PHONE, _act, _due_now, _enroll, _response_ready_policy, _socket_request,
    credentials, endpoint, fixture, gated,
)


@pytest.fixture
def report_world(request, monkeypatch, tmp_path):
    home = tmp_path / "report-storage"

    def open_profile(path):
        parent = home / "profiles" / "beta" if path.name == "beta.db" else home
        parent.mkdir(parents=True, exist_ok=True)
        return SessionDB(parent / "state.db")

    monkeypatch.setattr(fixtures, "SessionDB", open_profile)
    return request.getfixturevalue("fixture")


def create_chat(world, label):
    return _socket_request(world.browser, PHONE, "session.create", {
        "request_id": label, "model": "gpt-4o-mini", "source": "gui",
    })["session_id"]


def prepare(d2_job, run_id, marker):
    conversation_reports.capture(run_id, d2_job, marker, success=True)


def ledger(run_id):
    with delivery_queue._transaction() as conn:
        return dict(conn.execute("SELECT * FROM conversation_reports WHERE execution_id=?", (run_id,)).fetchone())


def advance_pending():
    with delivery_queue._transaction() as conn:
        conn.execute("UPDATE conversation_reports SET next_at=0 WHERE status='pending'")


async def publish(world, status, run_id, *, drain=True, reconcile=True):
    authority = world.beta
    home = authority.db.db_path.parent
    scheduled = authority._schedule_admitted
    session_cron.bind_owner(authority)
    try:
        advance_pending()
        await asyncio.gather(*(asyncio.to_thread(conversation_reports.drain, home) for _ in range(2 if reconcile else 1)))
        if drain:
            loop = asyncio.get_running_loop()
            pending = [live.task for live in authority.sessions.values()
                       if live.task is not None and live.task.get_loop() is loop]
            if pending:
                await asyncio.gather(*pending)
            if reconcile:
                advance_pending()
                await asyncio.to_thread(conversation_reports.drain, home)
        assert ledger(run_id)["status"] == status
    finally:
        session_cron.unbind_owner(authority)
    assert authority._schedule_admitted == scheduled


@pytest.mark.parametrize("change", ["edit", "clear", "remove"])
def test_prepared_reports_keep_original_target_across_retry_and_config_change(
        report_world, endpoint, monkeypatch, change):
    world = report_world
    browser, authority, push = world.browser, world.beta, world.runner.web_push
    first, second = create_chat(world, "first"), create_chat(world, "second")
    _response_ready_policy(browser, first, "on")
    _response_ready_policy(browser, second, "off")
    desktop = {**endpoint, "endpoint": endpoint["endpoint"] + "-desktop"}
    default_device = {**endpoint, "endpoint": endpoint["endpoint"] + "-default"}
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    assert _enroll(browser, desktop, device=DESKTOP, profile="beta").status_code == 200
    assert _enroll(browser, default_device, profile="default").status_code == 200
    assert _act(browser, "privacy", "beta", {"preview": True}).status_code == 200
    monkeypatch.setattr("gateway.session_finite.execute_finite_admission",
                        lambda *_: pytest.fail("report attempted a model turn"))
    home = authority.db.db_path.parent
    token = set_hermes_home_override(home)
    try:
        job = jobs.create_job("Synthetic cron report", "every 1h", target_session_id=first)
        prepare(job, "first-run", "Synthetic output in first conversation")
        event_id = _identity(ledger("first-run"))
        if change == "edit":
            jobs.update_job(job["id"], {"target_session_id": second})
        elif change == "clear":
            jobs.update_job(job["id"], {"target_session_id": ""})
        else:
            assert jobs.remove_job(job["id"])
        with monkeypatch.context() as patch:
            patch.setattr(authority, "_schedule_admitted", lambda *_: None)
            asyncio.run(publish(world, "pending", "first-run", drain=False))
        authority.epoch = begin_runtime_epoch(authority.db, instance_id="simulated-restart")
        assert recover_session_inputs(authority.db, epoch=authority.epoch) == 0

        enqueue = push.enqueue_report
        rolled_back = []

        def flaky_enqueue(*args):
            enqueue(*args)
            if not rolled_back:
                rolled_back.append(True)
                raise sqlite3.OperationalError("synthetic failure after note and outbox insert")

        monkeypatch.setattr(push, "enqueue_report", flaky_enqueue)
        asyncio.run(publish(world, "pending", "first-run", reconcile=False))
        authority.epoch = begin_runtime_epoch(authority.db, instance_id="restart-after-commit")
        assert recover_session_inputs(authority.db, epoch=authority.epoch) == 0
        asyncio.run(publish(world, "materialized", "first-run"))
        assert rolled_back and ledger("first-run")["content"] == ""
        with authority.db._read_ctx() as conn:
            notes = conn.execute("SELECT session_id, content FROM messages WHERE display_kind='internal_notification'").fetchall()
            assert [tuple(row) for row in notes] == [(first, "Synthetic output in first conversation")]
            assert conn.execute("SELECT COUNT(*) FROM web_push_outbox WHERE session_id=?", (first,)).fetchone()[0] == 2
        assert _act(browser, "seen", "beta", event_id).json() == {"applied": True}
        _due_now(authority)
        assert push.deliver_one(authority, "beta", generation())
        assert not push.deliver_one(authority, "beta", generation())
        assert world.sends[0][0] == desktop
        assert world.sends[0][1]["session"] == first
        assert "preview" not in world.sends[0][1]
        # A newer explicitly configured job can use the second conversation.
        another = jobs.create_job(None, "every 1h", script="report.py", no_agent=True, target_session_id=second)
        prepare(another, "second-run", "Synthetic output with alerts off")
        asyncio.run(publish(world, "materialized", "second-run"))
        with authority.db._read_ctx() as conn:
            assert conn.execute("SELECT COUNT(*) FROM messages WHERE session_id=? AND display_kind='internal_notification'",
                                (second,)).fetchone()[0] == 1
            assert conn.execute("SELECT COUNT(*) FROM web_push_outbox WHERE session_id=?", (second,)).fetchone()[0] == 0
        assert len(world.sends) == 1
    finally:
        reset_hermes_home_override(token)


def test_missing_and_foreign_sessions_leave_explicit_undelivered_reports(report_world):
    world = report_world
    authority = world.beta
    sid = create_chat(world, "deleted-target")
    foreign = _socket_request(world.browser, PHONE, "session.create", {
        "request_id": "other-profile", "model": "gpt-4o-mini", "source": "gui",
    }, profile="default")["session_id"]
    home = authority.db.db_path.parent
    token = set_hermes_home_override(home)
    try:
        job = jobs.create_job("Synthetic cron report", "every 1h", target_session_id=sid)
        prepare(job, "deleted-run", "Report that must not be restored")
        prepare(dict(job, target_session_id=foreign), "foreign-run", "Report from a different profile")
        assert authority.db.delete_session(sid)
        asyncio.run(publish(world, "undelivered", "deleted-run"))
        assert ledger("foreign-run")["status"] == "undelivered"
        assert ledger("deleted-run")["content"] == ledger("foreign-run")["content"] == ""
        with world.default.db._read_ctx() as conn:
            assert not conn.execute("SELECT 1 FROM messages WHERE display_kind='internal_notification'").fetchone()
        assert not world.sends
    finally:
        reset_hermes_home_override(token)


def test_report_waits_for_active_fifo_then_preserves_compression_and_revocation(report_world, endpoint, monkeypatch):
    from hermes_state_runtime import admit_session_input, claim_session_input, settle_session_input

    world = report_world
    browser, authority, push = world.browser, world.beta, world.runner.web_push
    root = create_chat(world, "compression-root")
    child = "synthetic-report-tip"
    _response_ready_policy(browser, root, "on")
    assert _enroll(browser, endpoint, profile="beta").status_code == 200
    desktop = {**endpoint, "endpoint": endpoint["endpoint"] + "-desktop"}
    assert _enroll(browser, desktop, device=DESKTOP, profile="beta").status_code == 200
    assert browser.post(PATH + "/privacy", headers=_headers(DESKTOP),
                        params={"profile": "beta"}, json={"preview": True}).status_code == 200
    monkeypatch.setattr("gateway.session_finite.execute_finite_admission",
                        lambda *_: pytest.fail("report attempted a model turn"))
    ordinary = admit_session_input(authority.db, epoch=authority.epoch, principal_id="fixture-ordinary",
                                   session_id=root, request_id="ordinary-first", payload={"text": "Ordinary first"})
    started = claim_session_input(authority.db, epoch=authority.epoch, session_id=root)
    assert started["admission_id"] == ordinary["admission_id"]
    token = set_hermes_home_override(authority.db.db_path.parent)
    try:
        job = jobs.create_job("Synthetic compression report", "every 1h", target_session_id=root)
        prepare(job, "compression-run", "Synthetic completion to compressed target")
        asyncio.run(publish(world, "pending", "compression-run"))
        with authority.db._read_ctx() as conn:
            assert not conn.execute("SELECT 1 FROM web_push_outbox").fetchone()
            assert not conn.execute("SELECT 1 FROM messages WHERE display_kind='internal_notification'").fetchone()
        settle_session_input(authority.db, epoch=authority.epoch, admission_id=ordinary["admission_id"],
                             generation=started["generation"], outcome="completed")
        authority.db.publish_compression_child(parent_session_id=root, child_session_id=child, source="gui",
                                               messages=[{"role": "user", "content": "Synthetic compacted turn"}],
                                               require_compression_lease=False)
        asyncio.run(publish(world, "materialized", "compression-run"))
        with authority.db._read_ctx() as conn:
            saved = conn.execute("SELECT session_id, content FROM messages WHERE display_kind='internal_notification'").fetchall()
            assert [tuple(row) for row in saved] == [(child, "Synthetic completion to compressed target")]
        assert _act(browser, "disable", "beta").json() == {"applied": True}
        _due_now(authority)
        assert push.deliver_one(authority, "beta", generation())
        assert not push.deliver_one(authority, "beta", generation())
        assert world.sends[0][0] == desktop
        assert world.sends[0][1]["session"] == root
        assert world.sends[0][1]["preview"]["body"] == "Synthetic completion to compressed target"
    finally:
        reset_hermes_home_override(token)
