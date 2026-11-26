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
    from cron.jobs import get_job
    from hermes_time import now

    current = get_job(job["id"])
    target = current and current.get("target_session_id")
    if not target:
        return
    revision = current.get("target_session_revision")
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
