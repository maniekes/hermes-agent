"""Conversation policy is separate from enrollment and admission device selection."""
from gateway.config import Platform
from gateway.owner_identity import same_owner
from gateway.session_history_mount import is_history_mount
from hermes_state_local import local_lineage_owner
from hermes_state_runtime import RuntimeStoreError

MODES = frozenset({"inherit", "on", "off"})


def owns_policy(authority, ref, subject):
    if (getattr(authority.runner, 'web_push', None) is None or authority.profile_id != ref.profile_id
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


def change_policy(conn, session_id, mode):
    if not isinstance(mode, str) or mode not in MODES:
        raise RuntimeStoreError('invalid_params')
    owner, _ = read_policy(conn, session_id)
    conn.execute("UPDATE sessions SET response_ready=? WHERE id=?", (mode, owner))
    return read_policy(conn, session_id)
