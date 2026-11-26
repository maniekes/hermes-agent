"""Publication of a captured cron report on a profile owner's existing FIFO."""

from functools import partial
from hashlib import sha256

from gateway.session_contract import SessionActor, SessionRef
from hermes_state_runtime import RuntimeStoreError, _canonical_chain, admit_session_input, claim_session_input

_PRINCIPAL = "cron-report"
_RECEIPT = "gateway.cron_report.v1:"


def report_payload(row):
    if row is not None and row["principal_id"] == _PRINCIPAL:
        return row["payload"].get("cron_report_v1")
    return None


def _identity(report):
    return sha256(f'{report["execution_id"]}:{report["target_session_id"]}'.encode()).hexdigest()[:32]


def _receipt(conn, event_id):
    row = conn.execute("SELECT value FROM state_meta WHERE key=?", (_RECEIPT + event_id,)).fetchone()
    return row[0] if row else None


def _target(conn, authority, root, pinned):
    from gateway.owner_identity import host_owner_subject, same_owner
    from gateway.session_authorities import served_profile_name
    from hermes_state_mutation_binding import authorize_history, same_history_owner

    chain = _canonical_chain(conn, root)
    if pinned not in chain:
        raise RuntimeStoreError("not_found")
    target = chain[-1]
    owner = host_owner_subject()
    actor = SessionActor(owner, authority.profile_id, frozenset({"session:create"}), "cron-report")
    profile = served_profile_name(authority.profile_id)
    for sid in {root, pinned, target}:
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
        if row["profile_name"] not in (None, "", profile):
            raise RuntimeStoreError("profile_mismatch")
        if row["source"] in {"cron", "subagent"} or not same_history_owner(conn, root, sid):
            raise RuntimeStoreError("permission_denied")
        if not same_owner(row["user_id"], owner) and not authorize_history(conn, actor, sid):
            raise RuntimeStoreError("permission_denied")
    return target


async def admit_report(authority, report):
    from gateway.owner_identity import host_owner_subject
    from gateway.session_authorities import owner_scope, require_serving
    from gateway.session_runtime_workers import tracked_write

    event_id = _identity(report)
    with owner_scope(authority):
        require_serving(authority)
        db = authority.db
        with db._read_ctx() as conn:
            saved = _receipt(conn, event_id)
        if saved:
            return saved
        pinned = report["target_session_id"]
        root = authority.logical_owner(pinned)
        ref = SessionRef(authority.profile_id, root)
        actor = SessionActor(host_owner_subject(), authority.profile_id, frozenset({"session:submit"}), "cron-report")

        def authorize(conn):
            _target(conn, authority, root, pinned)

        try:
            with db._read_ctx() as conn:
                authorize(conn)
            authority.authorize(actor, ref, "session:submit")
            await tracked_write(authority, partial(
                admit_session_input, db, epoch=authority.epoch, principal_id=_PRINCIPAL,
                session_id=root, request_id=event_id, payload={
                    "text": report["content"],
                    "cron_report_v1": {"id": event_id, "pinned": pinned},
                }, _authorize_write=authority._admission_gate(authorize)),
                after=partial(authority._schedule_admitted, ref))
        except RuntimeStoreError as exc:
            if exc.reason in {"not_found", "permission_denied", "profile_mismatch", "session_read_only"}:
                return "undelivered"
            return "pending"
        return "pending"


def claim_report(authority, ref, row):
    from gateway.owner_identity import host_owner_subject

    descriptor = report_payload(row)
    owner = host_owner_subject()
    push = getattr(authority.runner, "web_push", None)
    candidates = push.report_installations(authority, owner) if push is not None else []
    frame = {}

    def materialize(conn, queued):
        event_id = descriptor["id"]
        try:
            target = _target(conn, authority, ref.session_id, descriptor["pinned"])
        except RuntimeStoreError as exc:
            if exc.reason not in {"not_found", "permission_denied", "profile_mismatch"}:
                raise
            status, outcome = "undelivered", "rejected"
        else:
            note = authority.db.append_completion_note(
                target, queued["admission_id"], queued["payload"]["text"], "internal_notification",
                {"cron_report": event_id}, _connection=conn)
            if push is not None:
                push.enqueue_report(conn, ref.session_id, note, event_id, owner, candidates)
            timestamp = conn.execute("SELECT timestamp FROM messages WHERE id=?", (note,)).fetchone()[0]
            frame.update(id=event_id, row_id=note, content=queued["payload"]["text"], timestamp=timestamp)
            status, outcome = "materialized", "completed"
        conn.execute("INSERT INTO state_meta(key,value) VALUES (?,?)", (_RECEIPT + event_id, status))
        conn.execute("UPDATE session_admissions SET payload_json=json_remove(payload_json,'$.text') WHERE admission_id=?",
                     (queued["admission_id"],))
        return outcome

    result = claim_session_input(
        authority.db, epoch=authority.epoch, session_id=ref.session_id,
        _guard=authority._admission_gate(), head=row["admission_id"], _complete_queued=materialize)
    if result and result["outcome"] == "completed":
        result["cron_report"] = frame
    return result
