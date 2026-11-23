"""Profile database state. The admission and settlement callers own their transactions."""
import time
from uuid import uuid4


SCHEMA = """
CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    device TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    login TEXT NOT NULL,
    vapid TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    version TEXT NOT NULL,
    material TEXT NOT NULL,
    sealed BLOB NOT NULL,
    updated_at REAL NOT NULL
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


def subscription(conn, device, owner, login, vapid):
    return conn.execute(
        """SELECT * FROM web_push_subscriptions
           WHERE device=? AND owner=? AND login=? AND vapid=?""",
        (device, owner, login, vapid)).fetchone()


def subscribe(conn, device, owner, login, vapid, endpoint, sealed, now, *, material=''):
    current = conn.execute("SELECT * FROM web_push_subscriptions WHERE device=?", (device,)).fetchone()
    if current is not None and current["owner"] != owner:
        return None
    occupied = conn.execute("SELECT device FROM web_push_subscriptions WHERE endpoint=?", (endpoint,)).fetchone()
    if occupied is not None and occupied["device"] != device:
        return None
    if current is not None:
        same = (current["login"], current["vapid"], current["endpoint"], current["material"]) == (login, vapid, endpoint, material)
        if same:
            conn.execute("UPDATE web_push_subscriptions SET sealed=?, updated_at=? WHERE device=?",
                         (sealed, now, device))
            return current["version"]
        retire(conn, device, current["version"])
    version = uuid4().hex
    conn.execute("INSERT INTO web_push_subscriptions VALUES (?,?,?,?,?,?,?,?,?)",
                 (device, owner, login, vapid, endpoint, version, material, sealed, now))
    return version


def retire(conn, device, version):
    conn.execute("DELETE FROM web_push_subscriptions WHERE device=? AND version=?", (device, version))
    # Keep admission bindings until settlement so disabling cannot switch a running turn to local delivery.
    conn.execute("UPDATE web_push_outbox SET due_at=NULL WHERE device=? AND version=? AND due_at IS NOT NULL",
                 (device, version))


def revoke(conn, device, owner, login):
    row = conn.execute("SELECT version FROM web_push_subscriptions WHERE device=? AND owner=? AND login=?",
                       (device, owner, login)).fetchone()
    if row is None:
        return False
    retire(conn, device, row["version"])
    return True


def bind(conn, admission, device, owner, login, vapid):
    row = subscription(conn, device, owner, login, vapid)
    if row is not None:
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


def test_delivery(conn, device, owner, login, vapid, now):
    row = subscription(conn, device, owner, login, vapid)
    if row is None:
        return False
    prior = conn.execute(
        "SELECT due_at FROM web_push_outbox WHERE device=? AND version=? AND session_id IS NULL AND expires_at>?",
        (device, row["version"], now),
    ).fetchone()
    if prior is not None:
        return prior["due_at"] is not None
    conn.execute("INSERT INTO web_push_outbox(id,device,version,due_at,expires_at) VALUES (?,?,?,?,?)",
                 (uuid4().hex, device, row["version"], now, now + 30))
    return True


def seen(conn, event_id, device, owner, login):
    return conn.execute(
        """UPDATE web_push_outbox SET due_at=NULL
           WHERE id=? AND device=? AND session_id IS NOT NULL AND attempts=0 AND due_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM web_push_subscriptions s
                       WHERE s.device=? AND s.version=web_push_outbox.version AND s.owner=? AND s.login=?)""",
        (event_id, device, device, owner, login)).rowcount == 1


def next_delivery(conn, now):
    return conn.execute(
        """SELECT q.*, s.sealed, s.login, s.vapid FROM web_push_outbox q
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


def still_current(conn, row):
    return conn.execute(
        """SELECT 1 FROM web_push_outbox q JOIN web_push_subscriptions s
           ON q.device=s.device AND q.version=s.version
           WHERE q.id=? AND q.version=? AND q.due_at IS NOT NULL""",
        (row["id"], row["version"])).fetchone() is not None
