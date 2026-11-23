"""Conversation policy is separate from enrollment and admission device selection."""
from gateway.config import Platform
from gateway.owner_identity import same_owner
from gateway.session_history_mount import is_history_mount
from hermes_state_local import local_conversation_ids, local_lineage_owner
from hermes_state_runtime import RuntimeStoreError

MODES = frozenset({"inherit", "on", "off"})


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


def read_policy(conn, session_id):
    owner = local_lineage_owner(conn, session_id)
    row = conn.execute("SELECT response_ready FROM sessions WHERE id=?", (owner,)).fetchone()
    if row is None:
        raise RuntimeStoreError('not_found')
    mode = row['response_ready']
    return owner, {"mode": mode, "effective": "on" if mode == "on" else "off"}


def snapshot(authority, ref):
    with authority.db._read_ctx() as conn:
        owner, policy = read_policy(conn, ref.session_id)
        revision = conn.execute("SELECT runtime_revision FROM sessions WHERE id=?", (owner,)).fetchone()[0]
        return {**policy, "revision": revision}


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
    if mode != "on":
        conn.executemany("UPDATE web_push_outbox SET due_at=NULL WHERE session_id=? AND due_at IS NOT NULL",
                         [(sid,) for sid in local_conversation_ids(conn, owner)])
    return read_policy(conn, session_id)
