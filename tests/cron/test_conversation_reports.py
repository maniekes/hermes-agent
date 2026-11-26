"""Configured report targets use the current profile's actual session database."""

import pytest

from cron import jobs
from hermes_state import SessionDB


def _configured_chat(db, label):
    """Fixtures for a durable messaging route, the real GUI receipt is exercised in Webapp tests."""
    from gateway.owner_identity import host_owner_subject

    db.create_session(label, source="telegram", user_id=host_owner_subject(),
                      chat_id="fixture-chat", session_key="agent:main:telegram:dm:fixture-chat")


def test_conversation_target_is_optional_and_profile_scoped(tmp_path, monkeypatch):
    home = tmp_path / "own"
    other_home = tmp_path / "other"
    monkeypatch.setenv("HERMES_HOME", str(home))
    own = SessionDB(home / "state.db")
    other = SessionDB(other_home / "state.db")
    try:
        _configured_chat(own, "own_chat")
        _configured_chat(other, "foreign_chat")
        with jobs.use_cron_store(home / "cron"):
            targeted = jobs.create_job("Look up changes", "every 1h", target_session_id="own_chat")
            untargeted = jobs.create_job("Check logs", "every 1h")
            assert jobs.get_job(targeted["id"])["target_session_id"] == "own_chat"
            assert "target_session_id" not in jobs.get_job(untargeted["id"])

            with pytest.raises(ValueError, match="target session"):
                jobs.update_job(targeted["id"], {"target_session_id": "foreign_chat"})
            assert jobs.get_job(targeted["id"])["target_session_id"] == "own_chat"

            cleared = jobs.update_job(targeted["id"], {"target_session_id": ""})
            assert not cleared.get("target_session_id")
            assert jobs.get_job(targeted["id"]).get("target_session_id") is None
    finally:
        own.close()
        other.close()


def test_finished_report_is_retained_independently_of_delivery(tmp_path, monkeypatch):
    import sqlite3
    from uuid import uuid4

    from cron import delivery_queue, scheduler

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    db = SessionDB(tmp_path / "state.db")
    _configured_chat(db, "own_chat")
    _configured_chat(db, "new_chat")
    db.close()
    delivery_path = tmp_path / "deliveries.db"
    monkeypatch.setattr(delivery_queue, "DELIVERY_DB", delivery_path)
    monkeypatch.setattr(scheduler, "_deliver_result", lambda *args, **kwargs: "synthetic transport refused")

    def finish(job, success, text, error=None, outcome=None):
        run_id = uuid4().hex
        run = dict(job, execution_id=run_id, _conversation_report_outcome=outcome)
        delivery = scheduler._RunDelivery(job=run, success=success, error=error)
        scheduler._save_compose_deliver(
            delivery, scheduler._FireOwnership(run), text, "synthetic run history",
            adapters=None, loop=None, verbose=False, execution_token=None)
        return run_id

    with jobs.use_cron_store(tmp_path / "cron"):
        agent = jobs.create_job("Check releases", "every 1h", deliver="local", target_session_id="own_chat")
        script = jobs.create_job(
            None, "every 1h", script="fixture.py", no_agent=True, deliver="local", target_session_id="own_chat")
        success = finish(agent, True, "Synthetic material report")
        failure = finish(script, False, "", error="PRIVATE-FAILURE-CANARY")
        silent = finish(agent, True, "[SILENT]")
        for status in ("cancelled", "interrupted", "unknown"):
            finish(agent, False, "", outcome=status)
        assert delivery_path.is_file(), "the result must be durable even without a messaging target"
        with sqlite3.connect(delivery_path) as conn:
            reports = conn.execute("SELECT execution_id, target_session_id, content, status FROM conversation_reports").fetchall()
        assert {row[0] for row in reports} == {success, failure}
        assert not any(row[0] == silent for row in reports)
        assert all(row[1] == "own_chat" and row[3] == "pending" for row in reports)
        assert any(row[0] == success and row[2] == "Synthetic material report" for row in reports)
        assert all("PRIVATE-FAILURE-CANARY" not in row[2] for row in reports)
        jobs.update_job(agent["id"], {"target_session_id": "new_chat"})
        # The run still carries its start snapshot. Capture uses the current target.
        later = finish(agent, True, "A later material result")
        with sqlite3.connect(delivery_path) as conn:
            assert conn.execute("SELECT target_session_id FROM conversation_reports WHERE execution_id=?",
                                (later,)).fetchone() == ("new_chat",)


def test_fifo_note_and_outbox_rollback_before_commit_and_recover_after_restart(tmp_path):
    import sqlite3

    from hermes_state_runtime import (
        admit_session_input, begin_runtime_epoch, claim_session_input, get_session_admission,
        settle_session_input,
    )

    path = tmp_path / "state.db"
    db = SessionDB(path)
    db.create_session("target_chat", source="desktop")
    epoch = begin_runtime_epoch(db, instance_id="first")
    user = admit_session_input(db, epoch=epoch, principal_id="owner", session_id="target_chat",
                               request_id="user", payload={"text": "Do the current work"})
    report = admit_session_input(db, epoch=epoch, principal_id="cron-report", session_id="target_chat",
                                 request_id="one-report", payload={"text": "Report marker"})
    ordinary = claim_session_input(db, epoch=epoch, session_id="target_chat")
    assert ordinary["admission_id"] == user["admission_id"]
    assert ordinary["status"] == "started"
    assert claim_session_input(db, epoch=epoch, session_id="target_chat") is None
    settle_session_input(db, epoch=epoch, admission_id=user["admission_id"],
                         generation=ordinary["generation"], outcome="completed")

    def write_note(conn, row, fail=False):
        note_id = db.append_completion_note(
            "target_chat", row["admission_id"], row["payload"]["text"], "internal_notification", {},
            _connection=conn)
        conn.execute("INSERT INTO web_push_outbox(id, device, version, session_id) VALUES (?, ?, ?, ?)",
                     ("report-event", "fixture-installation", "fixture-version", "target_chat"))
        if fail:
            raise sqlite3.OperationalError("synthetic rollback after inserts")
        assert note_id > 0
        return "completed"

    def claim_note(callback):
        return claim_session_input(db, epoch=epoch, session_id="target_chat",
                                   head=report["admission_id"], _complete_queued=callback)

    with pytest.raises(sqlite3.OperationalError, match="synthetic rollback"):
        claim_note(lambda conn, row: write_note(conn, row, fail=True))
    assert get_session_admission(db, admission_id=report["admission_id"])["status"] == "queued"
    with db._read_ctx() as conn:
        assert not conn.execute("SELECT 1 FROM messages WHERE content='Report marker'").fetchone()
        assert not conn.execute("SELECT 1 FROM web_push_outbox WHERE id='report-event'").fetchone()

    db.close()
    db = SessionDB(path)
    try:
        epoch = begin_runtime_epoch(db, instance_id="after-rollback")
        committed = claim_note(write_note)
        assert (committed["status"], committed["outcome"]) == ("terminal", "completed")
        assert claim_note(write_note) is False
    finally:
        db.close()
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM messages WHERE content='Report marker'").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM web_push_outbox WHERE id='report-event'").fetchone()[0] == 1


def test_reconciling_a_pre_d2_run_does_not_backfill_a_report(tmp_path, monkeypatch):
    import json

    from cron import conversation_reports, delivery_queue, executions, scheduler_authority
    from tests.cron.test_canonical_receipt_bookkeeping import peer

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(delivery_queue, "DELIVERY_DB", tmp_path / "deliveries.db")
    with SessionDB(tmp_path / "state.db") as db:
        _configured_chat(db, "own_chat")
    with jobs.use_cron_store(tmp_path):
        job = jobs.create_job("Check releases", "every 1h", deliver="local", target_session_id="own_chat")
        run = executions.create_execution(job["id"], source="test")["id"]
        executions.mark_execution_running(run)
        with executions._transaction() as conn:
            conn.execute("UPDATE executions SET process_id=?,pid=? WHERE id=?", ("old-owner", 999999, run))
        journal = scheduler_authority.journal_path(job["id"], run)
        journal.parent.mkdir(parents=True, exist_ok=True)
        journal.write_text(json.dumps({
            "params": {"job_id": job["id"], "request_id": run, "extra_prompt": None},
            "receipt": None,
        }))
        peer(monkeypatch, lambda method, params: {
            "status": "terminal", "job": job, "result": [True, "document", "historical answer", None]})
        scheduler_authority.reconcile_pending()
        assert executions.get_execution(run)["status"] == "completed"
        assert conversation_reports.report_statuses([run]) == {}
