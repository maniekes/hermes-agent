"""Conversation policy is separate from enrollment and admission device selection."""
import json

from gateway.config import Platform
from gateway.owner_identity import same_owner
from gateway.session_history_mount import is_history_mount
from hermes_state_local import local_conversation_ids, local_lineage_owner
from hermes_state_runtime import RuntimeStoreError

MODES = frozenset({"inherit", "on", "off"})
_PROFILE_DEFAULT_KEY = "gateway.web_push.response_ready_default.v1"


def manages_response_ready(runner):
    return getattr(runner, 'web_push_policy_enabled', False) or getattr(runner, 'web_push', None) is not None


def owns_policy(authority, ref, subject):
    if (not manages_response_ready(authority.runner) or authority.profile_id != ref.profile_id
            or authority.retiring or authority.retired):
        return False
    live = authority.sessions.get(ref.session_id)
    source = live.source if live is not None else None
    return (source is not None and source.platform == Platform.LOCAL and not is_history_mount(live)
            and bool(subject) and same_owner(source.user_id, subject))


def read_policy(conn, session_id, *, include_revision=False):
    owner = local_lineage_owner(conn, session_id)
    row = conn.execute(
        """SELECT response_ready, runtime_revision, (SELECT value FROM state_meta WHERE key=?) AS profile_default
           FROM sessions WHERE id=?""", (_PROFILE_DEFAULT_KEY, owner)).fetchone()
    if row is None:
        raise RuntimeStoreError('not_found')
    mode = row['response_ready']
    default = "on" if _decode_default(row['profile_default'])["enabled"] is True else "off"
    policy = {"mode": mode, "default": default, "effective": default if mode == "inherit" else mode}
    if include_revision:
        # The revision fences writes based on this exact policy view.
        policy["revision"] = row["runtime_revision"]
    return owner, policy


def _decode_default(value):
    return {"enabled": False, "revision": 0} if value is None else json.loads(value)


def profile_default(conn):
    row = conn.execute("SELECT value FROM state_meta WHERE key=?", (_PROFILE_DEFAULT_KEY,)).fetchone()
    return _decode_default(row[0] if row else None)


def change_profile_default(conn, enabled, expected_revision):
    current = profile_default(conn)
    if current["revision"] != expected_revision:
        raise RuntimeStoreError('revision_conflict')
    if current["enabled"] == enabled:
        return current
    updated = {"enabled": enabled, "revision": expected_revision + 1}
    conn.execute(
        """INSERT INTO state_meta(key,value) VALUES(?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value""", (_PROFILE_DEFAULT_KEY, json.dumps(updated)))
    if not enabled:
        pending = conn.execute("""SELECT DISTINCT q.session_id FROM web_push_outbox q
                                  JOIN sessions s ON s.id=q.session_id WHERE q.due_at IS NOT NULL""").fetchall()
        inherited = [(sid,) for (sid,) in pending if read_policy(conn, sid)[1]["mode"] == "inherit"]
        _cancel_pending(conn, inherited)
    return updated


def snapshot(authority, ref):
    with authority.db._read_ctx() as conn:
        return read_policy(conn, ref.session_id, include_revision=True)[1]


def turn_alert_allowed(conn, session_id):
    if session_id is None:  # The explicit test message has no conversation.
        return True
    try:
        return read_policy(conn, session_id)[1]['effective'] == 'on'
    except RuntimeStoreError:
        return False


def change_policy(conn, session_id, mode):
    if not isinstance(mode, str) or mode not in MODES:
        raise RuntimeStoreError('invalid_params')
    owner, _ = read_policy(conn, session_id)
    conn.execute("UPDATE sessions SET response_ready=? WHERE id=?", (mode, owner))
    result = read_policy(conn, session_id)
    if result[1]["effective"] == "off":
        _cancel_pending(conn, [(sid,) for sid in local_conversation_ids(conn, owner)])
    return result


def _cancel_pending(conn, segments):
    conn.executemany("UPDATE web_push_outbox SET due_at=NULL WHERE session_id=? AND due_at IS NOT NULL", segments)
