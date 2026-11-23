"""Authenticated Webapp registration and delivery controls."""
from functools import partial
import json
import re
import time

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from gateway.session_authorities import local_bots
from gateway.session_identity import authenticated_principal_digest
from gateway.web_push import store
from gateway.web_push.delivery import installation_digest
from hermes_cli.dashboard_auth.request_utils import cookie_origin_is_allowed
from hermes_cli.webapp_sign_in import sign_in_of

router = APIRouter(prefix="/api/webapp/web-push")
_DEVICE_HEADER = "x-hermes-push-installation"
_MAX_BODY = 4096


def _response(**value):
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


def _context(request, profile):
    state = request.app.state
    if getattr(state, "ui_surface", None) != "webapp":
        raise HTTPException(404, "Web Push is unavailable")
    session = getattr(request.state, "session", None)
    login = sign_in_of(request)
    if session is None or login is None:
        raise HTTPException(401, "Webapp sign-in required")
    device = installation_digest(request.headers.get(_DEVICE_HEADER))
    if not device or len(request.headers.getlist(_DEVICE_HEADER)) != 1:
        raise HTTPException(400, "Invalid Web Push installation")
    runner = getattr(state, "gateway_runner", None)
    push = getattr(runner, "web_push", None)
    primary = getattr(state, "session_authority", None)
    bot = next((bot for bot in local_bots(runner) if not bot.problem and not bot.retiring and (
        bot.name == profile if profile else bot.authority is primary)), None)
    owner = authenticated_principal_digest({
        "provider": session.provider, "user_id": session.user_id, "issuer": session.issuer,
    })
    return push, bot.authority if bot else None, device, owner, login


async def _read_body(request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
        raise HTTPException(415, "Expected JSON")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > _MAX_BODY:
            raise HTTPException(413, "Web Push body too large")
        data.extend(chunk)
    try:
        return json.loads(data)
    except (ValueError, RecursionError):
        raise HTTPException(400, "Invalid Web Push JSON") from None


@router.get("")
async def push_status(request: Request, profile: str | None = None):
    push, authority, device, owner, login = _context(request, profile)
    if push is None or authority is None:
        return _response(available=False, active=False)

    def active():
        with authority.db._read_ctx() as conn:
            return store.subscription(conn, device, owner, login, push.vapid_id) is not None

    return _response(available=True, active=await run_in_threadpool(active), publicKey=push.public_key)


@router.post("/{action}")
async def push_action(request: Request, action: str, profile: str | None = None):
    if not request.headers.get("origin") or not cookie_origin_is_allowed(request):
        raise HTTPException(403, "Web Push requests must come from this Webapp")
    push, authority, device, owner, login = _context(request, profile)
    if authority is None or (push is None and action not in {"disable", "disable-all"}):
        raise HTTPException(404, "Web Push is unavailable")
    value = await _read_body(request)
    if action == "subscribe":
        try:
            version = await run_in_threadpool(push.register, authority, device, owner, login, value)
        except ValueError:
            raise HTTPException(400, "Invalid or unsupported Web Push subscription") from None
        if version is None:
            raise HTTPException(409, "Web Push subscription is assigned to another installation")
        return _response(active=True)

    if action == "disable-all" and value == {}:
        runner = request.app.state.gateway_runner

        def disable_served():
            for bot in local_bots(runner):
                if not bot.problem:
                    bot.authority.db._execute_write(partial(store.revoke, device=device, owner=owner, login=login))

        await run_in_threadpool(disable_served)
        return _response(applied=True)
    if action == "disable" and value == {}:
        write = partial(store.revoke, device=device, owner=owner, login=login)
    elif action == "test" and value == {}:
        write = partial(store.test_delivery, device=device, owner=owner, login=login,
                        vapid=push.vapid_id, now=time.time())
    elif action == "seen" and isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value):
        write = partial(store.seen, event_id=value, device=device, owner=owner, login=login)
    else:
        raise HTTPException(400, "Invalid Web Push operation")
    applied = await run_in_threadpool(authority.db._execute_write, write)
    if action == "test" and not applied:
        raise HTTPException(409, "Web Push subscription is inactive")
    return _response(applied=applied)
