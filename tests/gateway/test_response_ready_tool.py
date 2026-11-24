"""Agent policy changes cross the real tool catalog, dispatch and claimed session store."""
import asyncio
from contextvars import copy_context
import json
from dataclasses import replace
from types import SimpleNamespace

import pytest

from gateway.session_contract import SessionActor, SessionRef, Submission
from hermes_state_runtime import RuntimeStoreError, claim_session_input, settle_session_input

TOOL = "response_ready_here"
TOOLSET = "response-ready-here"


@pytest.mark.asyncio
async def test_response_ready_tool_is_current_owned_and_fenced(tmp_path, monkeypatch):
    from agent.delegation_context import delegated_child_context
    from gateway import run
    from gateway.config import GatewayConfig
    from gateway.session import SessionStore
    from gateway.session_authority import initialize_session_authority
    from gateway.session_ingress import _admission_scope, execute_admission
    from gateway.session_local import create_local_session
    from gateway.session_local_recovery import local_adapter
    from gateway.session_mutations import mutate_session
    from gateway.web_push.conversation import change_profile_default, profile_default
    from model_tools import get_tool_definitions, handle_function_call
    from tools.registry import registry, session_tool_scope

    monkeypatch.setattr(run, '_load_gateway_config', lambda: {'platform_toolsets': {'cli': []}})
    store = SessionStore(tmp_path / 'sessions', GatewayConfig())
    runner = SimpleNamespace(session_store=store, _session_db=store._db, adapters={}, _draining=False,
                             web_push=object(), _cached_agent_for=lambda _key: None)
    authority = await initialize_session_authority(runner, profile_id=str(tmp_path), instance_id='fixture')
    runner._adapter_for_source = lambda _source: local_adapter(authority)
    monkeypatch.setattr(authority, '_schedule_admitted', lambda *_: None)
    caps = frozenset({'session:create', 'session:read', 'session:submit', 'session:control'})
    owner = SessionActor('owner', str(tmp_path), caps, 'fixture')
    ref, sibling = [
        create_local_session(authority, owner, {'request_id': request_id, 'source': 'gui',
            'cwd': str(tmp_path), 'model': 'fixture', 'toolsets': []})
        for request_id in ('target', 'sibling')
    ]

    async def claim(actor, request_id):
        saved = await authority.submit(actor, Submission(request_id, ref, {'text': 'synthetic'}, 'queue'))
        row = claim_session_input(authority.db, epoch=authority.epoch, session_id=ref.session_id)
        assert saved.admission_id == row['admission_id']
        return row

    def settle(row):
        settle_session_input(authority.db, epoch=authority.epoch, admission_id=row['admission_id'],
                             generation=row['generation'], outcome='completed')

    def definitions():
        return get_tool_definitions([TOOLSET], quiet_mode=True, skip_tool_search_assembly=True)

    def invoke(**args):
        return json.loads(handle_function_call(TOOL, args, enabled_toolsets=[TOOLSET]))

    def scope(row, target=ref):
        return _admission_scope(authority, target, None, row, SimpleNamespace(), {})

    assert not definitions()
    assert 'error' in invoke(mode='on')
    row = await claim(owner, 'allowed')
    async with scope(row):
        schemas = definitions()
        assert [tool['function']['name'] for tool in schemas] == [TOOL]
        assert set(schemas[0]['function']['parameters']['properties']) == {'mode'}
        assert definitions() == schemas
        assert await asyncio.to_thread(invoke) == {'mode': 'inherit', 'default': 'off', 'effective': 'off'}
        assert 'error' in invoke(mode='on', session_id=sibling.session_id)
        assert 'error' in invoke(mode='on', profile_id='foreign', owner='foreign')
        assert 'error' in invoke(default='on')
        with authority.db._read_ctx() as conn:
            assert profile_default(conn) == {'enabled': False, 'revision': 0}
        authority.db._execute_write(lambda conn: change_profile_default(conn, True, 0))
        assert invoke() == {'mode': 'inherit', 'default': 'on', 'effective': 'on'}
        assert invoke(mode='off') == {'mode': 'off', 'default': 'on', 'effective': 'off'}
        assert invoke(mode='inherit') == {'mode': 'inherit', 'default': 'on', 'effective': 'on'}
        authority.db._execute_write(lambda conn: change_profile_default(conn, False, 1))
        assert invoke(mode='on') == {'mode': 'on', 'default': 'off', 'effective': 'on'}
        assert definitions() == schemas
        assert invoke() == {'mode': 'on', 'default': 'off', 'effective': 'on'}
        assert json.loads(handle_function_call(
            'tool_call', {'name': TOOL, 'arguments': {}}, enabled_toolsets=[TOOLSET])
        ) == {'mode': 'on', 'default': 'off', 'effective': 'on'}
        with delegated_child_context():
            assert not definitions()
            assert 'error' in invoke(mode='off')
        editor_scope = 'editor-session:existing'
        registry.register('owned_editor', 'mcp-editor', {'description': 'Synthetic editor tool'},
                          lambda _args: 'editor result', scope=editor_scope)
        try:
            with session_tool_scope(editor_scope):
                assert not definitions()
                assert 'error' in invoke(mode='off')
                assert registry.dispatch('owned_editor', {}) == 'editor result'
        finally:
            registry.deregister('owned_editor', scope=editor_scope)
        assert registry.get_entry(TOOL) is not None
        late = copy_context()
        settle(row)
        assert 'error' in invoke(mode='off')
    assert 'error' in late.run(invoke, mode='off')
    assert not definitions()
    assert 'error' in invoke(mode='off')
    assert authority.db.get_session(ref.session_id)['response_ready'] == 'on'
    assert authority.db.get_session(sibling.session_id)['response_ready'] == 'inherit'

    for actor in (replace(owner, capabilities=caps - {'session:control'}),
                  replace(owner, subject='foreign', capabilities=caps | {'session:operator'})):
        with pytest.raises(RuntimeStoreError, match='permission_denied'):
            await mutate_session(authority, actor, ref, {
                'session_id': ref.session_id, 'request_id': 'ui-denied',
                'expected_revision': authority.db.get_session(ref.session_id)['runtime_revision'],
                'operation': 'response_ready', 'payload': {'mode': 'off'},
            })
        denied = await claim(actor, 'denied-' + actor.subject)
        async with scope(denied):
            assert not definitions()
            assert 'error' in invoke(mode='off')
        settle(denied)
    wrong = replace(owner, profile_id='foreign')
    with pytest.raises(RuntimeStoreError, match='profile_mismatch'):
        await claim(wrong, 'wrong-profile')
    other = await claim(owner, 'cross-profile')
    async with scope(other, SessionRef('foreign', ref.session_id)):
        assert not definitions()
        assert 'error' in invoke(mode='off')
    settle(other)
    managed = await claim(owner, 'managed')
    from gateway import session_managed_worker
    monkeypatch.setattr(session_managed_worker, 'managed_policy', lambda *_: object())

    async def managed_dispatch(*_args):
        assert not definitions()
        assert 'error' in invoke(mode='off')
        return 'managed path'

    monkeypatch.setattr(session_managed_worker, 'admit_managed', managed_dispatch)
    assert await execute_admission(authority, ref, managed) == 'managed path'
    settle(managed)
    assert authority.db.get_session(ref.session_id)['response_ready'] == 'on'
    store._db.close()
