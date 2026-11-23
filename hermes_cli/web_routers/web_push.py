"""Authenticated Webapp registration and delivery controls."""
from functools import partial
import hmac
import json
import re

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool
from starlette.responses import JSONResponse

from gateway.session_authorities import local_bots, served_profile_name
from gateway.session_identity import authenticated_principal_digest
from gateway.web_push import store
from gateway.web_push.delivery import installation_digest
from hermes_cli import browser_credential
from hermes_cli.dashboard_auth.cookies import read_web_push_revoke_cookie, set_web_push_revoke_cookie
from hermes_cli.dashboard_auth.request_utils import cookie_origin_is_allowed
from hermes_cli.webapp_sign_in import check, cookie_gateway, sign_in_of

router = APIRouter(prefix="/api/webapp/web-push")
_DEVICE_HEADER = "x-hermes-push-installation"
_MAX_BODY = 4096


def _response(**value):
    return JSONResponse(value, headers={"Cache-Control": "no-store"})


def _device(request):
    values = request.headers.getlist(_DEVICE_HEADER)
    return installation_digest(values[0]) if len(values) == 1 else None


def _principal(session):
    return authenticated_principal_digest({
        "provider": session.provider, "user_id": session.user_id, "issuer": session.issuer,
    })


def _control_db(state):
    authority = getattr(state, "session_authority", None)
    if authority is None:
        raise HTTPException(503, "Web Push revocation could not be recorded")
    return authority.db


def _logout_proof(key, device, owner, grant):
    message = json.dumps(["web-push-logout", device, owner, grant], separators=(",", ":"))
    return hmac.digest(key.encode(), message.encode(), "sha256").hex()


def _confirm_revocation(push, device):
    if push is not None and not push.wait_for_dispatch(device):
        raise HTTPException(503, "Web Push revocation recorded; an in-flight send is still unconfirmed")


async def revoke_on_logout(request):
    state = request.app.state
    device = _device(request)
    if (getattr(state, "ui_surface", None) != "webapp" or getattr(state, "session_authority", None) is None
            or device is None
            or not request.headers.get("origin") or not cookie_origin_is_allowed(request) or not check(request)):
        return
    login = sign_in_of(request)
    key = browser_credential.current_if(login)
    proof = read_web_push_revoke_cookie(request, cookie_gateway(request))
    if key is None or proof is None or not re.fullmatch(r"[0-9a-f]{64}", proof):
        return
    from hermes_cli.dashboard_auth.middleware import peek_session

    session = await run_in_threadpool(peek_session, request)
    principal = _principal(session) if session is not None else None

    def revoke_proven_grant(conn):
        owner, grant, recorded_login = store.device_grant(conn, device)
        # The cookie proves this exact enrollment even if the access cookie is gone.
        if (owner is None or recorded_login != login or principal not in (None, owner)
                or not hmac.compare_digest(proof, _logout_proof(key, device, owner, grant))):
            return False
        return store.revoke_device(conn, device, owner, login)

    if await run_in_threadpool(_control_db(state)._execute_write, revoke_proven_grant):
        push = getattr(getattr(state, "gateway_runner", None), "web_push", None)
        await run_in_threadpool(_confirm_revocation, push, device)


def _context(request, profile):
    state = request.app.state
    if getattr(state, "ui_surface", None) != "webapp":
        raise HTTPException(404, "Web Push is unavailable")
    session = getattr(request.state, "session", None)
    login = sign_in_of(request)
    if session is None or login is None:
        raise HTTPException(401, "Webapp sign-in required")
    device = _device(request)
    if not device:
        raise HTTPException(400, "Invalid Web Push installation")
    runner = getattr(state, "gateway_runner", None)
    push = getattr(runner, "web_push", None)
    primary = getattr(state, "session_authority", None)
    bot = next((bot for bot in local_bots(runner) if not bot.problem and not bot.retiring and (
        bot.name == profile if profile else bot.authority is primary)), None)
    return push, bot.authority if bot else None, device, _principal(session), login


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

    active = await run_in_threadpool(push.active, authority, device, owner, login)
    return _response(available=True, active=active is not None, publicKey=push.public_key)


@router.post("/{action}")
async def push_action(request: Request, action: str, profile: str | None = None):
    if not request.headers.get("origin") or not cookie_origin_is_allowed(request):
        raise HTTPException(403, "Web Push requests must come from this Webapp")
    push, authority, device, owner, login = _context(request, profile)
    value = await _read_body(request)
    state = request.app.state
    if action == "disable-all" and value == {}:
        write = partial(store.revoke_device, device=device, owner=owner, login=login)
        applied = await run_in_threadpool(_control_db(state)._execute_write, write)
        if applied:
            await run_in_threadpool(_confirm_revocation, push, device)
        return _response(applied=applied)
    if action == "disable" and value == {}:
        control = _control_db(state)
        name = profile or served_profile_name(state.session_authority.profile_id)
        write = partial(store.revoke_profile, device=device, owner=owner, login=login, profile=name)
        revoked_grant = await run_in_threadpool(control._execute_write, write)
        if revoked_grant is not None:
            if authority is not None:
                retire = partial(store.revoke, device=device, owner=owner, login=login,
                                 before_profile_grant=revoked_grant)
                await run_in_threadpool(authority.db._execute_write, retire)
            await run_in_threadpool(_confirm_revocation, push, device)
        return _response(applied=revoked_grant is not None)
    if authority is None or push is None:
        raise HTTPException(404, "Web Push is unavailable")
    if action in {"subscribe", "check"}:
        try:
            operation = push.register if action == "subscribe" else push.matches
            result = await run_in_threadpool(operation, authority, device, owner, login, value)
        except ValueError:
            raise HTTPException(400, "Invalid or unsupported Web Push subscription") from None
        if action == "subscribe":
            key = browser_credential.current_if(login)
            if result is None or key is None:
                raise HTTPException(409, "Web Push subscription is assigned to another installation")
            response = _response(active=True)
            set_web_push_revoke_cookie(response, request, _logout_proof(key, device, owner, result),
                                       cookie_gateway(request))
            return response
        return _response(active=bool(result))
    if action == "test" and value == {}:
        state = await run_in_threadpool(push.test, authority, device, owner, login)
        if state == "inactive":
            raise HTTPException(409, "Web Push subscription is inactive")
        if state == "recent":
            raise HTTPException(429, "A Web Push test finished recently", headers={"Retry-After": "30"})
        return _response(applied=True)
    if action == "seen" and isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value):
        write = partial(store.seen, event_id=value, device=device, owner=owner, login=login)
        return _response(applied=await run_in_threadpool(authority.db._execute_write, write))
    raise HTTPException(400, "Invalid Web Push operation")
