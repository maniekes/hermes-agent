"""One no-target policy action for authenticated, owned in-process admissions."""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
import json
from pathlib import Path
from threading import Lock

from agent.delegation_context import is_delegated_child_context
from gateway.web_push.conversation import MODES, change_policy, owns_policy, read_policy
from hermes_state_runtime import RuntimeStoreError, _epoch
from tools.registry import current_session_tool_scope, no_cache_check_fn, registry, session_tool_scope, tool_error

_NAME = 'response_ready_here'
_TOOLSET = 'response-ready-here'
# One stable catalog slot with no conversation data. The per-turn grant is in the callback context.
_SCOPE = str(Path(__file__).with_name('.response-ready-tool-scope'))
_grant = ContextVar('response_ready_turn_grant', default=None)
_register_lock = Lock()


@dataclass
class _Claim:
    authority: object
    ref: object
    row: dict
    active: bool = True

    def apply(self, conn, mode):
        current = conn.execute(
            """SELECT a.status, a.owner_epoch, a.generation, a.target_session_id, a.principal_id,
                      a.response_ready_control, s.runtime_generation
               FROM session_admissions a JOIN sessions s ON s.id=a.target_session_id
               WHERE a.admission_id=?""", (self.row['admission_id'],)).fetchone()
        _epoch(conn, self.row['owner_epoch'])
        if (not self.active or current is None or current['status'] != 'started'
                or current['target_session_id'] != self.ref.session_id or not current['response_ready_control']
                or current['principal_id'] != self.row['principal_id']
                or current['owner_epoch'] != self.row['owner_epoch']
                or current['generation'] != self.row['generation']
                or current['runtime_generation'] != self.row['generation']
                or not owns_policy(self.authority, self.ref, current['principal_id'])):
            raise RuntimeStoreError('permission_denied')
        if mode is None:
            return read_policy(conn, self.ref.session_id)[1]
        owner, policy = change_policy(conn, self.ref.session_id, mode)
        conn.execute("UPDATE sessions SET runtime_revision=runtime_revision+1 WHERE id=?", (owner,))
        return policy


def active_toolset(authority=None, session_id=None):
    claim = _grant.get()
    if (claim is not None and claim.active and current_session_tool_scope() == _SCOPE
            and not is_delegated_child_context()
            and (authority is None or (claim.authority is authority and claim.ref.session_id == session_id))):
        return _TOOLSET
    return None


@no_cache_check_fn
def _available():
    return active_toolset() is not None


def _invoke(args):
    claim = _grant.get()
    if active_toolset() is None:
        return tool_error('Response ready policy is unavailable in this turn.')
    mode = args.get('mode')
    if args.keys() - {'mode'} or ('mode' in args and (not isinstance(mode, str) or mode not in MODES)):
        return tool_error('Expected inherit, on or off, or no arguments to read the current policy.')
    try:
        if mode is None:
            with claim.authority.db._read_ctx() as conn:
                result = claim.apply(conn, None)
        else:
            result = claim.authority.db._execute_write(lambda conn: claim.apply(conn, mode))
    except RuntimeStoreError:
        return tool_error('The current conversation no longer authorizes this action.')
    return json.dumps(result)


def _register():
    with _register_lock:
        if registry.get_entry(_NAME, scope=_SCOPE) is None:
            registry.register(_NAME, _TOOLSET, {
                'description': 'Read or change the current conversation’s Response ready policy. '
                               'Omit mode to read it.',
                'parameters': {'type': 'object', 'additionalProperties': False,
                               'properties': {'mode': {'type': 'string', 'enum': ['inherit', 'on', 'off']}}},
            }, _invoke, check_fn=_available, scope=_SCOPE)


@contextmanager
def tool_scope(authority, ref, row):
    if (not row.get('response_ready_control') or row.get('status') != 'started'
            or row.get('target_session_id') != ref.session_id or not owns_policy(authority, ref, row.get('principal_id'))):
        yield
        return
    from gateway.session_policy import policy_for_source
    policy = policy_for_source(authority.runner, authority.sessions[ref.session_id].source)
    if policy is None or policy.editor_mcp_json:
        # An editor-side overlay keeps its existing slot and toolset.
        yield
        return
    _register()
    claim = _Claim(authority, ref, row)
    token = _grant.set(claim)
    try:
        with session_tool_scope(_SCOPE):
            yield
    finally:
        claim.active = False
        _grant.reset(token)
