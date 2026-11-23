"""Profile database state. The admission and settlement callers own their transactions."""
import time
from uuid import uuid4


SCHEMA = """
-- The serving gateway's primary database owns the installation grant.
CREATE TABLE IF NOT EXISTS web_push_devices (
    device TEXT PRIMARY KEY,
    owner TEXT,
    generation INTEGER NOT NULL,
    login TEXT
);
CREATE TABLE IF NOT EXISTS web_push_profile_grants (
    device TEXT NOT NULL,
    profile TEXT NOT NULL,
    generation INTEGER NOT NULL,
    PRIMARY KEY (device, profile)
);
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    device TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    login TEXT NOT NULL,
    vapid TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    material TEXT NOT NULL,
    sealed BLOB NOT NULL,
    updated_at REAL NOT NULL,
    grant INTEGER NOT NULL DEFAULT 0,
    profile_grant INTEGER NOT NULL DEFAULT 0,
    preview INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS web_push_outbox (
    id TEXT PRIMARY KEY,
    device TEXT NOT NULL,
    version TEXT NOT NULL,
    session_id TEXT,
    due_at REAL,
    expires_at REAL,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS web_push_outbox_due ON web_push_outbox(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS web_push_outbox_device ON web_push_outbox(device, version);
"""
GRACE_SECONDS = 3
TTL_SECONDS = 3600
PREVIEW_TITLE_SOURCE_LIMIT = 4096
PREVIEW_ANSWER_SOURCE_LIMIT = 16384


def device_grant(conn, device):
    row = conn.execute("SELECT owner, generation, login FROM web_push_devices WHERE device=?", (device,)).fetchone()
    return tuple(row) if row is not None else (None, 0, None)


def enroll_device(conn, device, owner, login, profile):
    current, grant, recorded_login = device_grant(conn, device)
    # A different owner may take over only after a known login generation has ended.
    if current not in (None, owner) and recorded_login in (None, login):
        return None
    if current is not None and recorded_login != login:
        grant += 1
    conn.execute("""INSERT INTO web_push_devices (device,owner,generation,login) VALUES (?,?,?,?)
                    ON CONFLICT(device) DO UPDATE SET
                    owner=excluded.owner, generation=excluded.generation, login=excluded.login""",
                 (device, owner, grant, login))
    conn.execute("INSERT OR IGNORE INTO web_push_profile_grants VALUES (?,?,0)", (device, profile))
    return grant, profile_grant(conn, device, profile)


def revoke_device(conn, device, owner, login):
    current, grant, recorded_login = device_grant(conn, device)
    if current is not None and (current != owner or recorded_login not in (None, login)):
        return False
    conn.execute("""INSERT INTO web_push_devices (device,owner,generation) VALUES (?,NULL,?)
                    ON CONFLICT(device) DO UPDATE SET owner=NULL, generation=excluded.generation, login=NULL""",
                 (device, grant + 1))
    local = conn.execute(
        "SELECT version FROM web_push_subscriptions WHERE device=? AND owner=? AND grant<=?",
        (device, owner, grant)).fetchone()
    if local is not None:
        retire(conn, device, local["version"])
    return True


def profile_grant(conn, device, profile):
    row = conn.execute("SELECT generation FROM web_push_profile_grants WHERE device=? AND profile=?",
                       (device, profile)).fetchone()
    return row["generation"] if row is not None else 0


def revoke_profile(conn, device, owner, login, profile):
    # The profile database can be unavailable; the dispatcher still checks this fence on return.
    current, _, recorded_login = device_grant(conn, device)
    if (current, recorded_login) != (owner, login):
        return None
    row = conn.execute("""UPDATE web_push_profile_grants SET generation=generation+1
                          WHERE device=? AND profile=? RETURNING generation""", (device, profile)).fetchone()
    return row["generation"] if row is not None else None


def subscription(conn, device, owner, login, vapid, grant=0):
    return conn.execute(
        """SELECT * FROM web_push_subscriptions
           WHERE device=? AND owner=? AND login=? AND vapid=? AND grant=?""",
        (device, owner, login, vapid, grant)).fetchone()


def set_preview(conn, row, preview):
    saved = conn.execute("""UPDATE web_push_subscriptions SET preview=?
                            WHERE device=? AND version=? RETURNING preview""",
                         (preview, row["device"], row["version"])).fetchone()
    return bool(saved["preview"]) if saved is not None else None


def subscribe(conn, device, owner, login, vapid, endpoint, sealed, now, *, material='', grant=0, profile_grant=0):
    current = conn.execute("SELECT * FROM web_push_subscriptions WHERE device=?", (device,)).fetchone()
    if current is not None and ((current["grant"], current["profile_grant"]) > (grant, profile_grant) or (
        current["grant"] == grant and current["owner"] != owner
    )):
        return None
    occupied = conn.execute("SELECT device FROM web_push_subscriptions WHERE endpoint=?", (endpoint,)).fetchone()
    if occupied is not None and occupied["device"] != device:
        return None
    if current is not None:
        same = (current["login"], current["vapid"], current["endpoint"], current["material"],
                current["grant"], current["profile_grant"]) == (login, vapid, endpoint, material, grant, profile_grant)
        if same:
            conn.execute("UPDATE web_push_subscriptions SET sealed=?, updated_at=? WHERE device=?",
                         (sealed, now, device))
            return current["version"]
        retire(conn, device, current["version"])
    version = uuid4().hex
    conn.execute("""INSERT INTO web_push_subscriptions
                    (device,owner,login,vapid,endpoint,version,material,sealed,updated_at,grant,profile_grant)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                 (device, owner, login, vapid, endpoint, version, material, sealed, now, grant, profile_grant))
    return version


def retire(conn, device, version):
    conn.execute("DELETE FROM web_push_subscriptions WHERE device=? AND version=?", (device, version))
    # Keep admission bindings until settlement so disabling cannot switch a running turn to local delivery.
    conn.execute("UPDATE web_push_outbox SET due_at=NULL WHERE device=? AND version=? AND due_at IS NOT NULL",
                 (device, version))


def revoke(conn, device, owner, login, *, before_profile_grant):
    row = conn.execute("""SELECT version FROM web_push_subscriptions
                          WHERE device=? AND owner=? AND login=? AND profile_grant<?""",
                       (device, owner, login, before_profile_grant)).fetchone()
    if row is None:
        return False
    retire(conn, device, row["version"])
    return True


def bind(conn, admission, device, owner, login, vapid, *, grant=0, version=None):
    row = subscription(conn, device, owner, login, vapid, grant)
    if row is not None and (version is None or row["version"] == version):
        conn.execute("INSERT INTO web_push_outbox(id,device,version) VALUES (?,?,?)",
                     (admission, device, row["version"]))


def annotate(conn, row):
    if row is not None and conn.execute("SELECT 1 FROM web_push_outbox WHERE id=?",
                                        (row["admission_id"],)).fetchone():
        row["web_push"] = True
    return row


def settled(conn, row, outcome):
    if outcome != "completed":
        return
    now = time.time()
    conn.execute(
        """UPDATE web_push_outbox SET session_id=?, due_at=?, expires_at=?
           WHERE id=? AND expires_at IS NULL AND EXISTS (
               SELECT 1 FROM web_push_subscriptions s
               WHERE s.device=web_push_outbox.device AND s.version=web_push_outbox.version)""",
        (row["target_session_id"], now + GRACE_SECONDS, now + TTL_SECONDS, row["admission_id"]))


def test_delivery(conn, device, owner, login, vapid, now, *, grant=0, version=None):
    row = subscription(conn, device, owner, login, vapid, grant)
    if row is None or (version is not None and row["version"] != version):
        return "inactive"
    prior = conn.execute(
        "SELECT due_at FROM web_push_outbox WHERE device=? AND version=? AND session_id IS NULL AND expires_at>?",
        (device, row["version"], now),
    ).fetchone()
    if prior is not None:
        return "queued" if prior["due_at"] is not None else "recent"
    conn.execute("INSERT INTO web_push_outbox(id,device,version,due_at,expires_at) VALUES (?,?,?,?,?)",
                 (uuid4().hex, device, row["version"], now, now + 30))
    return "queued"


def seen(conn, event_id, device, owner, login):
    return conn.execute(
        """UPDATE web_push_outbox SET due_at=NULL
           WHERE id=? AND device=? AND session_id IS NOT NULL AND attempts=0 AND due_at>?
           AND EXISTS (SELECT 1 FROM web_push_subscriptions s
                       WHERE s.device=? AND s.version=web_push_outbox.version AND s.owner=? AND s.login=?)""",
        (event_id, device, time.time(), device, owner, login)).rowcount == 1


def next_delivery(conn, now):
    return conn.execute(
        """SELECT q.*, s.sealed, s.login, s.vapid, s.owner, s.grant, s.profile_grant FROM web_push_outbox q
           JOIN web_push_subscriptions s ON s.device=q.device AND s.version=q.version
           WHERE q.due_at<=? AND q.expires_at>? ORDER BY q.due_at LIMIT 1""", (now, now)).fetchone()


def claim(conn, now):
    row = next_delivery(conn, now)
    if row is not None:
        conn.execute("UPDATE web_push_outbox SET attempts=attempts+1, due_at=? WHERE id=?",
                     (now + 90, row["id"]))
    return row


def finish(conn, row, retry_at):
    conn.execute(
        """UPDATE web_push_outbox SET due_at=? WHERE id=? AND version=? AND due_at IS NOT NULL""",
        (retry_at, row["id"], row["version"]))


def prune(conn, now):
    conn.execute(
        """DELETE FROM web_push_outbox WHERE expires_at<=? OR
           (expires_at IS NULL AND NOT EXISTS (
               SELECT 1 FROM session_admissions a WHERE a.admission_id=web_push_outbox.id
               AND a.status IN ('queued','started','unknown')))""", (now,))


def dispatch_preview(conn, row):
    current = conn.execute(
        """SELECT s.preview FROM web_push_outbox q JOIN web_push_subscriptions s
           ON q.device=s.device AND q.version=s.version
           WHERE q.id=? AND q.version=? AND q.due_at IS NOT NULL""",
        (row["id"], row["version"])).fetchone()
    return bool(current["preview"]) if current is not None else None


def preview_source(conn, row):
    from hermes_state_terminal import RESULT_PREFIX

    # Read only the exact settlement's final response. Never fall back to recent messages.
    return conn.execute(
        """SELECT substr(s.title, 1, ?) AS title,
                  substr(json_extract(r.value, '$.result.final_response'), 1, ?) AS answer
           FROM sessions s JOIN state_meta r ON r.key=?
           WHERE s.id=? AND CASE WHEN json_valid(r.value) THEN json_type(r.value, '$.result.final_response') END='text'""",
        (PREVIEW_TITLE_SOURCE_LIMIT + 1, PREVIEW_ANSWER_SOURCE_LIMIT + 1,
         RESULT_PREFIX + row["id"], row["session_id"])).fetchone()
