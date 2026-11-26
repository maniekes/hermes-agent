"""Configuration and durable capture of a cron conversation report."""

import json
import re
import sqlite3
from contextlib import closing

from hermes_constants import get_hermes_home


def validate_target_session(value):
    """Validate against the profile's database without creating or mounting a session."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise ValueError("Invalid cron report target session ID.")
    from gateway.session_cron_reports import checked_target
    from hermes_state import SessionDB
    from hermes_state_runtime import RuntimeStoreError

    home = get_hermes_home()
    path = home / "state.db"
    if not path.is_file():
        raise ValueError("Cron report target session is missing from this profile.")
    try:
        with SessionDB(path, read_only=True) as db:
            lineage = db.get_compression_lineage(value)
            with db._read_ctx() as conn:
                checked_target(conn, str(home.resolve()), lineage[0] if lineage else value, value)
    except RuntimeStoreError as exc:
        raise ValueError("Cron report target session is not an authorized conversation in this profile.") from exc
    return value


def set_target_session(job, target):
    if target is None:
        job.pop("target_session_id", None)
    else:
        job["target_session_id"] = target


_FAILURE_REPORT = "The scheduled job did not complete. See its run history for details."


def capture(execution_id, job, text, *, success):
    """Persist the report independently of the messaging delivery, once per run."""
    if job.get("target_session_id"):
        return _insert(execution_id, _prepared_report(job, text, success), home=None)


def _prepared_report(job, text, success):
    from agent.redact import redact_sensitive_text
    from hermes_time import now

    content = redact_sensitive_text(text.strip(), force=True, redact_url_credentials=True) if success else _FAILURE_REPORT
    return {"job_id": job["id"], "target_session_id": job["target_session_id"],
            "content": content, "created_at": now().isoformat()}


def _insert(execution_id, prepared, *, home):
    from cron.delivery_queue import _transaction

    with _transaction(home) as conn:
        conn.execute(
            """INSERT INTO conversation_reports
               (execution_id, job_id, target_session_id, content, created_at, status)
               VALUES (?, ?, ?, ?, ?, 'pending')
               ON CONFLICT(execution_id) DO NOTHING""",
            (execution_id, prepared["job_id"], prepared["target_session_id"],
             prepared["content"], prepared["created_at"]),
        )
        return conn.execute("SELECT target_session_id FROM conversation_reports WHERE execution_id=?",
                            (execution_id,)).fetchone()[0]


def stage_for_capture(execution_id, job, text, *, success):
    """Hand a safe terminal result to the existing admission journal before opening SQLite."""
    from cron.scheduler_authority import journal_path
    from utils import atomic_json_write

    journal = journal_path(job["id"], execution_id)
    try:
        record = json.loads(journal.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        record = {"params": {"job_id": job["id"], "request_id": execution_id, "extra_prompt": None},
                  "conversation_report_only": True}
    if "conversation_report_ready" not in record:
        record["conversation_report_ready"] = _prepared_report(job, text, success)
        journal.parent.mkdir(parents=True, exist_ok=True)
        atomic_json_write(journal, record, mode=0o600, fsync_dir=True)
    return journal, record


def commit_ready(journal, record):
    """Complete just the INSERT. The normal receipt or transport tail owns its own settlement."""
    from utils import atomic_json_write

    prepared = record["conversation_report_ready"]
    target = _insert(record["params"]["request_id"], prepared, home=None)
    record["conversation_report_target"] = target
    del record["conversation_report_ready"]
    if record.get("conversation_report_only"):
        journal.unlink(missing_ok=True)
    else:
        atomic_json_write(journal, record, mode=0o600, fsync_dir=True)
    return target


def same_local_target(target, chat_id):
    """Both ids must name the same stored conversation in this profile."""
    if not target:
        return False
    if target == chat_id:
        return True
    from hermes_state import SessionDB

    path = get_hermes_home() / "state.db"
    if not path.is_file():
        return False
    with SessionDB(path, read_only=True) as db:
        return chat_id in db.get_compression_lineage(target)


def drain(home):
    """Advance bounded, independent report receipts on the existing cron delivery tick."""
    from time import monotonic, time

    from cron.delivery_queue import _transaction, queue_path
    from gateway.session_cron import deliver_to_local_chat, owner_for_home

    if owner_for_home(home) is None or not queue_path(home).is_file():
        return 0
    with _transaction(home) as conn:
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
        except (OSError, RuntimeError, sqlite3.Error):
            status = "pending"
        with _transaction(home) as conn:
            if status == "pending":
                conn.execute("UPDATE conversation_reports SET next_at=? WHERE execution_id=? AND status='pending'",
                             (time() + 15, report["execution_id"]))
            else:
                conn.execute("""UPDATE conversation_reports SET status=?, content=''
                                WHERE execution_id=? AND status='pending'""", (status, report["execution_id"]))
    return processed



def report_statuses(execution_ids):
    """Read the independent note dispositions without opening a writer."""
    from cron.delivery_queue import queue_path

    path = queue_path()
    if not execution_ids or not path.is_file():
        return {}
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='conversation_reports'").fetchone():
            return {}
        placeholders = ",".join("?" for _ in execution_ids)
        return dict(conn.execute(
            f"SELECT execution_id, status FROM conversation_reports WHERE execution_id IN ({placeholders})",
            tuple(execution_ids)))
