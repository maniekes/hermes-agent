"""D2 reviewer regressions through real Cron and Webapp boundaries."""
import asyncio
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from cron import conversation_reports as reports, delivery_queue, executions, jobs, scheduler, scheduler_authority
from gateway import session_cron
from gateway.run import _drain_restart_safe_cron_deliveries
from hermes_constants import get_hermes_home, reset_hermes_home_override, set_hermes_home_override
from tests.hermes_cli.test_webapp_cron_reports import create_chat, credentials, endpoint, fixture, gated, report_world


def _stored(home, run_id):
    token = set_hermes_home_override(home)
    try:
        with delivery_queue._transaction() as conn:
            row = conn.execute("SELECT * FROM conversation_reports WHERE execution_id=?", (run_id,)).fetchone()
            return dict(row) if row else None
    finally:
        reset_hermes_home_override(token)


async def _housekeeping(world, multiplexed, *, wake_only=None):
    runner = SimpleNamespace(config=SimpleNamespace(multiplex_profiles=multiplexed),
                             session_authorities=world.runner.session_authorities, _profile_adapters={})
    session_cron.bind_owner(world.default)
    session_cron.bind_owner(world.beta)
    try:
        await asyncio.to_thread(_drain_restart_safe_cron_deliveries, {}, asyncio.get_running_loop(), runner)
        if wake_only is not None:
            world.beta._schedule_admitted = wake_only[1]
            world.beta.wake_after_worker(wake_only[0])
        tasks = [live.task for live in world.beta.sessions.values()
                 if live.task is not None and live.task.get_loop() is asyncio.get_running_loop()]
        if tasks:
            await asyncio.gather(*tasks)
    finally:
        session_cron.unbind_owner(world.default)
        session_cron.unbind_owner(world.beta)


@pytest.mark.parametrize("multiplexed", [False, True])
def test_webapp_only_profile_report_drains_in_its_housekeeping_scope(report_world, monkeypatch, multiplexed):
    world = report_world
    home = world.beta.db.db_path.parent
    root = world.default.db.db_path.parent
    sid = create_chat(world, "housekeeping")
    token = set_hermes_home_override(home)
    try:
        job = jobs.create_job("Synthetic report", "every 1h", target_session_id=sid)
        reports.capture("worker-result", job, "Synthetic result", success=True)
    finally:
        reset_hermes_home_override(token)

    scopes = []

    async def refresh(_route, _session):
        scopes.append(get_hermes_home().resolve())

    monkeypatch.setattr(world.runner, "_refresh_agent_cache_message_count", refresh, raising=False)
    scheduled = world.beta._schedule_admitted
    monkeypatch.setattr(world.beta, "_schedule_admitted", lambda *_: None)
    token = set_hermes_home_override(root)
    try:
        asyncio.run(_housekeeping(world, multiplexed, wake_only=(sid, scheduled)))
    finally:
        reset_hermes_home_override(token)
    assert scopes == [Path(world.beta.profile_id).resolve()]
    with world.beta.db._read_ctx() as conn:
        assert conn.execute("SELECT content FROM messages WHERE display_kind='internal_notification'").fetchone()[0] == "Synthetic result"
    assert _stored(root, "worker-result") is None


@pytest.mark.parametrize("mode", ["empty", "exception", "capture_fault"])
def test_real_scheduler_tail_owns_the_terminal_report(report_world, monkeypatch, mode):
    world = report_world
    sid = create_chat(world, "tail-" + mode)
    home = world.beta.db.db_path.parent
    token = set_hermes_home_override(home)
    try:
        job = jobs.create_job("Synthetic report", "every 1h", target_session_id=sid, deliver="local")
        run_id = executions.create_execution(job["id"], source="test")["id"]
        sent = []
        monkeypatch.setattr(scheduler, "_deliver_result", lambda *a, **k: sent.append(1))

        def run(*a, **k):
            if mode == "exception":
                raise RuntimeError("SYNTHETIC PRIVATE canary")
            return True, "summary", "  " if mode == "empty" else "Synthetic result", None

        monkeypatch.setattr(scheduler, "run_job", run)
        connect = delivery_queue._connect
        with monkeypatch.context() as fault:
            if mode == "capture_fault":
                def unavailable(*args, **kwargs):
                    raise sqlite3.OperationalError("synthetic first capture fault")
                fault.setattr(delivery_queue, "_connect", unavailable)
            scheduler._run_one_job_body(dict(job, execution_id=run_id))
        if mode == "capture_fault":
            journal = scheduler_authority.journal_path(job["id"], run_id)
            assert journal.exists(), "terminal bookkeeping must preserve report ownership"
            assert delivery_queue._connect is connect
            jobs.remove_job(job["id"])
            scheduler_authority.reconcile_pending(allow_connect=False)
            scheduler_authority.reconcile_pending(allow_connect=False)
            assert not journal.exists()
            assert sent == []
        else:
            assert executions.get_execution(run_id)["status"] == "failed"
        row = _stored(home, run_id)
        assert row is not None
        assert row["content"] == ("Synthetic result" if mode == "capture_fault" else reports._FAILURE_REPORT)
        assert row["target_session_id"] == sid
    finally:
        reset_hermes_home_override(token)


def test_rejects_unbound_or_cron_targets_without_adopting(report_world):
    world = report_world
    home = world.beta.db.db_path.parent
    world.beta.db.create_session("unbound", source="desktop")
    world.beta.db.create_session("cron-session", source="cron")
    s = create_chat(world, "validated")
    token = set_hermes_home_override(home)
    try:
        for bad in ("unbound", "cron-session"):
            with pytest.raises(ValueError, match="target session"):
                jobs.create_job("Invalid", "every 1h", target_session_id=bad)
        assert jobs.create_job("Valid", "every 1h", target_session_id=s)["target_session_id"] == s
    finally:
        reset_hermes_home_override(token)


def test_sqlite_fault_backs_off_one_report_and_continues_batch(report_world, monkeypatch):
    world = report_world
    home = world.beta.db.db_path.parent
    first = create_chat(world, "fault-first")
    second = create_chat(world, "fault-second")
    token = set_hermes_home_override(home)
    try:
        for sid, label in ((first, "first"), (second, "second")):
            job = jobs.create_job("Synthetic batch report", "every 1h", target_session_id=sid)
            reports.capture(label, job, label, success=True)
    finally:
        reset_hermes_home_override(token)

    write = world.beta.db._execute_write
    failed = False

    def transient(*args, **kwargs):
        nonlocal failed
        if not failed:
            failed = True
            raise sqlite3.OperationalError("synthetic admission write refused")
        return write(*args, **kwargs)

    monkeypatch.setattr(world.beta.db, "_execute_write", transient)
    asyncio.run(_housekeeping(world, False))
    assert failed and _stored(home, "first")["next_at"] > 0
    with world.beta.db._read_ctx() as conn:
        notes = conn.execute("SELECT session_id FROM messages WHERE display_kind='internal_notification'").fetchall()
        assert [row[0] for row in notes] == [second]


@pytest.mark.parametrize("same", [True, False])
def test_local_origin_dedup_survives_first_capture_fault_without_replaying_telegram(
        report_world, endpoint, monkeypatch, same):
    from cron import scheduler_delivery
    from gateway.config import GatewayConfig, Platform, PlatformConfig
    from tests.hermes_cli.test_webapp_push_lifecycle import _enroll, _response_ready_policy

    world = report_world
    home = world.beta.db.db_path.parent
    report_target = create_chat(world, "report-target")
    local_origin = report_target if same else create_chat(world, "different-origin")
    _response_ready_policy(world.browser, report_target, "on")
    assert _enroll(world.browser, endpoint, profile="beta").status_code == 200
    sent, legacy_local = [], []
    config = GatewayConfig()
    config.platforms = {Platform.TELEGRAM: PlatformConfig(enabled=True, token="synthetic-fixture-token")}
    monkeypatch.setattr("gateway.config.load_gateway_config", lambda: config)

    def telegram(target, _content, _media):
        sent.append(target.chat_id)
        return {"success": True, "message_id": "test-receipt"}, None

    real_local = session_cron.deliver_to_local_chat

    def observe_local(home, sid, text, **kwargs):
        if kwargs.get("report") is None:
            legacy_local.append(sid)
            return None  # legacy delivery is observed at its transport boundary
        return real_local(home, sid, text, **kwargs)

    monkeypatch.setattr(scheduler_delivery, "_standalone_send", telegram)
    monkeypatch.setattr(session_cron, "deliver_to_local_chat", observe_local)
    monkeypatch.setattr(scheduler, "run_job", lambda **_: pytest.fail("recovery must not run the job again"))

    token = set_hermes_home_override(home)
    try:
        job = jobs.create_job(None, "every 1h", script="report.py", no_agent=True,
                              target_session_id=report_target, deliver="origin,telegram:-100999",
                              origin={"platform": "local", "chat_id": local_origin})
        run_id = executions.create_execution(job["id"], source="test")["id"]
        with monkeypatch.context() as fault:
            fault.setattr(scheduler, "run_job", lambda *_a, **_k: (True, "output", "Synthetic report", None))

            def unavailable(*_a, **_k):
                raise sqlite3.OperationalError("synthetic first write fault")
            fault.setattr(delivery_queue, "_connect", unavailable)
            assert scheduler._run_one_job_body(dict(job, execution_id=run_id))

        assert legacy_local == ([] if same else [local_origin])
        assert len(sent) == 1
        assert scheduler_authority.journal_path(job["id"], run_id).exists()
        jobs.remove_job(job["id"])
        scheduler_authority.reconcile_pending(allow_connect=False)
        scheduler_authority.reconcile_pending(allow_connect=False)
        assert not scheduler_authority.journal_path(job["id"], run_id).exists()
        assert len(sent) == 1

        asyncio.run(_housekeeping(world, False))
        with world.beta.db._read_ctx() as conn:
            notes = conn.execute("SELECT session_id, content FROM messages WHERE display_kind='internal_notification'").fetchall()
            outbox = conn.execute("SELECT session_id FROM web_push_outbox").fetchall()
        assert [tuple(row) for row in notes] == [(report_target, "Synthetic report")]
        assert [row[0] for row in outbox] == [report_target]
    finally:
        reset_hermes_home_override(token)
