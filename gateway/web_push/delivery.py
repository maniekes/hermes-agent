"""Optional Webapp sender. Endpoint material is encrypted before entering SQLite."""
import asyncio
import base64
from email.utils import parsedate_to_datetime
import hashlib
import hmac
from http.client import HTTPSConnection
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import ssl
import stat
import time
from types import SimpleNamespace

from gateway.web_push import store

logger = logging.getLogger(__name__)
_ENDPOINT = re.compile(
    r"https://(fcm\.googleapis\.com)/(wp|fcm/send)/[A-Za-z0-9_-][A-Za-z0-9_:-]{15,2047}"
)
_INSTALLATION = re.compile(r"[a-f0-9]{64}")


def installation_digest(value):
    if not isinstance(value, str) or not _INSTALLATION.fullmatch(value):
        return None
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def endpoint_route(endpoint):
    if not isinstance(endpoint, str) or not (match := _ENDPOINT.fullmatch(endpoint)):
        raise ValueError("Unsupported Web Push endpoint")
    host = match[1]
    return host, endpoint[len("https://") + len(host):]


def _key(value, size):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{%d}" % ((size * 8 + 5) // 6), value):
        raise ValueError("Invalid Web Push key")
    raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(raw) != size or _b64(raw) != value:
        raise ValueError("Invalid Web Push key")
    return raw


def _b64(raw):
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def normalize_subscription(value):
    from cryptography.hazmat.primitives.asymmetric import ec

    if not isinstance(value, dict) or set(value) - {"endpoint", "keys", "expirationTime"}:
        raise ValueError("Invalid Web Push subscription")
    endpoint = value.get("endpoint")
    endpoint_route(endpoint)
    keys = value.get("keys")
    if not isinstance(keys, dict) or set(keys) != {"p256dh", "auth"}:
        raise ValueError("Invalid Web Push keys")
    point = _key(keys["p256dh"], 65)
    if point[0] != 4:
        raise ValueError("Invalid Web Push key")
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), point)
    _key(keys["auth"], 16)
    expires = value.get("expirationTime")
    if expires is not None and (type(expires) is not int or not time.time() * 1000 < expires < 2**53):
        raise ValueError("Expired Web Push subscription")
    return {"endpoint": endpoint, "keys": keys, "expirationTime": expires}


def _public_address(host):
    for family, _, _, _, address in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM):
        ip = ipaddress.IPv4Address(address[0])
        if ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_loopback or ip.is_link_local):
            return family, address
    raise OSError("No public Web Push address")


class _PushConnection(HTTPSConnection):
    def connect(self):
        family, address = _public_address(self.host)
        with socket.socket(family, socket.SOCK_STREAM) as raw:
            raw.settimeout(self.timeout)
            raw.connect(address)
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


class PushTransport:
    """A pywebpush session adapter with pinned DNS, normal TLS, and no redirect/proxy handling."""
    def post(self, endpoint, *, timeout, data, headers):
        host, path = endpoint_route(endpoint)
        connection = _PushConnection(host, 443, timeout=timeout, context=ssl.create_default_context())
        try:
            connection.request("POST", path, body=data, headers=headers)
            response = connection.getresponse()
            return SimpleNamespace(status_code=response.status, reason="", text="",
                                   headers={"Retry-After": response.getheader("Retry-After")})
        finally:
            connection.close()


def retry_at(status, header, attempts, now, expires):
    if status not in (None, 429) and not 500 <= status <= 599:
        return None
    delay = min(300, 5 * 2 ** min(attempts, 6))
    try:
        if header:
            requested = int(header) if header.isascii() and header.isdigit() else (
                parsedate_to_datetime(header).timestamp() - now)
            delay = max(delay, requested)
    except (ValueError, TypeError, OverflowError):
        pass
    next_at = now + delay + min(1, delay / 4) * secrets.randbelow(100) / 100
    return next_at if next_at < expires else None


def _read_credentials(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as stream:
        mode = os.fstat(stream.fileno())
        if not stat.S_ISREG(mode.st_mode) or (
            os.name == "posix" and (stat.S_IMODE(mode.st_mode) & 0o077 or mode.st_uid != os.getuid())
        ):
            raise ValueError("Web Push credentials must be private")
        raw = stream.read(8193)
        if len(raw) > 8192:
            raise ValueError("Web Push credentials are too large")
        return json.loads(raw)


class WebPush:
    def __init__(self, credentials, send=None):
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from py_vapid import Vapid
        from pywebpush import webpush

        self.signer = Vapid.from_pem(credentials["vapid_private_key"].encode("ascii"))
        self.public_key = _b64(self.signer.public_key.public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
        self.vapid_id = hashlib.sha256(self.public_key.encode()).hexdigest()
        self.contact = credentials["contact"]
        if not re.fullmatch(r"mailto:[^@\s]{1,100}@[^@\s]{1,100}", self.contact):
            raise ValueError("Invalid Web Push contact")
        self.storage_secret = _key(credentials["storage_key"], 32)
        self.cipher = AESGCM(self.storage_secret)
        self.send = send or webpush

    @classmethod
    def from_home(cls, home):
        try:
            return cls(_read_credentials(home / "webapp" / "web-push.json"))
        except (ImportError, OSError, ValueError, TypeError, KeyError, AttributeError):
            logger.warning("Webapp push unavailable: check the web-push extra and private credentials")
            return None

    def register(self, authority, device, owner, login, value):
        subscription = normalize_subscription(value)
        encoded = json.dumps(subscription, sort_keys=True, separators=(",", ":")).encode()
        fingerprint = hmac.digest(self.storage_secret, subscription["endpoint"].encode(), "sha256").hex()
        material = hmac.digest(self.storage_secret, encoded, "sha256").hex()
        nonce = secrets.token_bytes(12)
        sealed = nonce + self.cipher.encrypt(nonce, encoded, self._aad(authority, device))
        return authority.db._execute_write(lambda conn: store.subscribe(
            conn, device, owner, login, self.vapid_id, fingerprint, sealed, time.time(), material=material))

    @staticmethod
    def _aad(authority, device):
        return json.dumps([authority.profile_id, device]).encode()

    def _send(self, authority, profile, row, remaining):
        from pywebpush import WebPushException

        sealed = row["sealed"]
        subscription = normalize_subscription(json.loads(
            self.cipher.decrypt(sealed[:12], sealed[12:], self._aad(authority, row["device"]))))
        host, _ = endpoint_route(subscription["endpoint"])
        payload = json.dumps({"kind": "turn" if row["session_id"] is not None else "test",
                              "id": row["id"], "session": row["session_id"], "profile": profile})
        try:
            response = self.send(subscription, data=payload, vapid_private_key=self.signer,
                                 vapid_claims={"aud": f"https://{host}", "sub": self.contact},
                                 requests_session=PushTransport(), ttl=remaining, timeout=6)
        except WebPushException as exc:
            response = exc.response
        return (response.status_code, response.headers.get("Retry-After")) if response is not None else (None, None)

    def deliver_one(self, authority, profile, login):
        now = time.time()
        with authority.db._read_ctx() as conn:
            ready = store.next_delivery(conn, now) is not None
        if not ready:
            return False
        row = authority.db._execute_write(lambda conn: store.claim(conn, now))
        if row is None:
            return False
        if row["vapid"] != self.vapid_id or row["login"] != login:
            authority.db._execute_write(lambda conn: store.retire(conn, row["device"], row["version"]))
            return True
        with authority.db._read_ctx() as conn:
            if not store.still_current(conn, row):
                return True
        try:
            remaining = int(row["expires_at"] - time.time())
            status, retry = self._send(authority, profile, row, remaining) if remaining > 0 else (400, None)
        except OSError:
            status, retry = None, None
        except Exception:
            # Third-party exceptions can contain endpoint credentials and response bodies.
            status, retry = 400, None
            logger.warning("Web Push delivery failed to encode or complete")
        if status in (404, 410):
            authority.db._execute_write(lambda conn: store.retire(conn, row["device"], row["version"]))
        else:
            retry_time = retry_at(status, retry, row["attempts"], time.time(), row["expires_at"])
            authority.db._execute_write(lambda conn: store.finish(conn, row, retry_time))
        return True

    async def run(self, runner, stopped, current_login):
        from gateway.session_authorities import local_bots

        next_prune = 0
        while not stopped.is_set():
            busy = False
            now = time.time()
            for bot in local_bots(runner):
                if stopped.is_set():
                    break
                if bot.problem or bot.retiring:
                    continue
                try:
                    if now >= next_prune:
                        await asyncio.to_thread(bot.authority.db._execute_write, lambda conn: store.prune(conn, now))
                    busy = await asyncio.to_thread(self.deliver_one, bot.authority, bot.name, current_login()) or busy
                except Exception:
                    logger.warning("Web Push queue unavailable for this pass")
            if now >= next_prune:
                next_prune = now + 60
            try:
                await asyncio.wait_for(stopped.wait(), timeout=0.15 if busy else 1)
            except TimeoutError:
                continue
