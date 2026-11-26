"""Configuration and durable capture of a cron conversation report."""

import re
from uuid import uuid4

from hermes_constants import get_hermes_home


def validate_target_session(value):
    """Validate against the profile's database without creating or mounting a session."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise ValueError("Invalid cron report target session ID.")
    from gateway.session_authorities import served_profile_name
    from hermes_state import SessionDB

    home = get_hermes_home()
    path = home / "state.db"
    if not path.is_file():
        raise ValueError("Cron report target session is missing from this profile.")
    db = SessionDB(path, read_only=True)
    try:
        row = db.get_session(value)
    finally:
        db.close()
    if row is None or row.get("profile_name") not in (None, "", served_profile_name(home)):
        raise ValueError("Cron report target session is missing from this profile.")
    return value


def set_target_session(job, target, *, previous=None):
    """Maintain an incarnation so disabling and re-adding a target cannot revive a report."""
    if target is None:
        job.pop("target_session_id", None)
        job.pop("target_session_revision", None)
        return
    old = previous or {}
    current_revision = old.get("target_session_revision") if old.get("target_session_id") == target else None
    job["target_session_id"] = target
    job["target_session_revision"] = current_revision or uuid4().hex


_FAILURE_REPORT = "The scheduled job did not complete. See its run history for details."


def capture(execution_id, job, text, *, success):
    """Persist the report independently of the messaging delivery, once per run."""
    from agent.redact import redact_sensitive_text
    from cron.delivery_queue import _transaction
    from hermes_time import now

    target = job.get("target_session_id")
    if not target:
        return
    revision = job.get("target_session_revision")
    content = redact_sensitive_text(text.strip(), force=True, redact_url_credentials=True) if success else _FAILURE_REPORT
    with _transaction() as conn:
        conn.execute(
            """INSERT INTO conversation_reports
               (execution_id, job_id, target_session_id, target_revision, content, created_at, status)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(execution_id) DO NOTHING""",
            (execution_id, job["id"], target, revision, content if revision else "",
             now().isoformat(), "pending" if revision else "undelivered"),
        )


def drain(home):
    """Advance bounded, independent report receipts on the existing cron delivery tick."""
    from time import monotonic, time

    from cron.delivery_queue import _transaction
    from gateway.session_cron import deliver_to_local_chat

    with _transaction() as conn:
        pending = [dict(row) for row in conn.execute(
            """SELECT * FROM conversation_reports WHERE status='pending' AND next_at<=?
               ORDER BY next_at, created_at, execution_id LIMIT 16""", (time(),))]
    deadline = monotonic() + 5
    processed = 0
    for report in pending:
        if monotonic() >= deadline:
            break
        processed += 1
        try:
            status = deliver_to_local_chat(home, report["target_session_id"], report["content"], report=report)
        except (OSError, RuntimeError):
            status = "pending"
        with _transaction() as conn:
            if status == "pending":
                conn.execute("UPDATE conversation_reports SET next_at=? WHERE execution_id=? AND status='pending'",
                             (time() + 15, report["execution_id"]))
            else:
                conn.execute("""UPDATE conversation_reports SET status=?, content=''
                                WHERE execution_id=? AND status='pending'""", (status, report["execution_id"]))
    return processed



def report_statuses(execution_ids):
    """Read the independent note dispositions without opening a writer."""
    import sqlite3

    from cron.delivery_queue import queue_path

    path = queue_path()
    if not execution_ids or not path.is_file():
        return {}
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='conversation_reports'").fetchone():
            return {}
        placeholders = ",".join("?" for _ in execution_ids)
        return dict(conn.execute(
            f"SELECT execution_id, status FROM conversation_reports WHERE execution_id IN ({placeholders})",
            tuple(execution_ids)))
