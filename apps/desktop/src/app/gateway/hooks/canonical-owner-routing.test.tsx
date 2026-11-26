import { LOCAL_CONNECTION_ID } from '@hermes/shared'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { sessionAttachment } from '@/api/session-attachment'
import { renderMessageStream } from '@/app/session/hooks/use-message-stream/test-harness'
import { singleFlightSessionResume } from '@/app/session/hooks/use-prompt-actions/single-flight-resume'
import { withSessionNotFoundResume } from '@/app/session/hooks/use-prompt-actions/utils'
import * as browserPush from '@/lib/browser-web-push'
import { createClientSessionState } from '@/lib/chat-runtime'
import { activeGateway, closeSecondaryGateways, ensureGatewayForAgent, requestGatewayForAgent } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection, $gatewayState } from '@/store/session'
import { clearAllSessionStates, runtimeSessionOwner } from '@/store/session-states'

import { FakeWebSocket } from '../../../test/fake-gateway-socket'

import { takeGatewaySurvivor } from './gateway-hmr-survivor'
import { useGatewayBoot } from './use-gateway-boot'

const sharedPrimaryConn = {
  authMode: 'token' as const, baseUrl: 'http://127.0.0.1:8899', connectionId: '',
  profile: 'default', sharedPrimary: true, token: 'fixture',
  wsUrl: 'ws://127.0.0.1:8899/api/ws?native_dial=fixture&ticket=one-use'
}

const originalWebSocket = globalThis.WebSocket

function fakeDesktop() {
  return {
    getConnection: vi.fn(async () => sharedPrimaryConn),
    getGatewayWsUrl: vi.fn(async () => sharedPrimaryConn.wsUrl),
    getBootProgress: vi.fn(async () => ({ error: null, fakeMode: false, message: '', phase: 'init',
      progress: 0, retryable: false, running: true, timestamp: Date.now() })),
    onBootProgress: vi.fn(() => () => undefined), onBackendExit: vi.fn(() => () => undefined),
    onConnectionApplied: vi.fn(() => () => undefined), onPowerResume: vi.fn(() => () => undefined),
    onWindowStateChanged: vi.fn(() => () => undefined),
    revalidateConnection: vi.fn(async () => ({ ok: true, rebuilt: false })),
    profile: { get: vi.fn(async () => ({ profile: 'default' })) }
  }
}

function Harness({ handleGatewayEvent, handleServerRequest }: Pick<Parameters<typeof useGatewayBoot>[0], 'handleGatewayEvent' | 'handleServerRequest'>) {
  useGatewayBoot({ handleGatewayEvent, handleServerRequest, beforeConnectionSwitch: () => undefined,
    onConnectionReady: () => undefined, onGatewayReady: () => undefined,
    refreshHermesConfig: async () => undefined, refreshSessions: async () => undefined })

  return null
}

beforeEach(() => {
  takeGatewaySurvivor()?.gateway.close()
  closeSecondaryGateways()
  clearAllSessionStates()
  $activeGatewayProfile.set('default')
  $connection.set(null)
  vi.useFakeTimers()
  FakeWebSocket.mode = 'open'
  FakeWebSocket.instances = []
  FakeWebSocket.pingMode = 'pong'
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
  $gatewayState.set('idle')
})

afterEach(() => {
  cleanup()
  takeGatewaySurvivor()?.gateway.close()
  closeSecondaryGateways()
  clearAllSessionStates()
  $activeGatewayProfile.set('default')
  $connection.set(null)
  vi.useRealTimers()
  ;(globalThis as { WebSocket: unknown }).WebSocket = originalWebSocket
  delete (window as { hermesDesktop?: unknown }).hermesDesktop
})

async function flushAsync() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

function deliverEvent(socket: FakeWebSocket, frame: Record<string, unknown>) {
  ;(socket as unknown as { emit: (type: string, ev: unknown) => void }).emit('message', {
    data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: frame })
  })
}

test('keeps canonical alpha events and questions on alpha while beta is foreground', async () => {
    const desktop = fakeDesktop()

    const native = { ...sharedPrimaryConn, profile: 'default',
      wsUrl: 'ws://127.0.0.1:8899/api/ws?native_dial=fixture&ticket=one-use' }

    desktop.getConnection.mockResolvedValue(native)
    desktop.getGatewayWsUrl.mockResolvedValue(native.wsUrl)
    ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
    const events = vi.fn()
    const questions = vi.fn((_request: unknown) => true)
    render(<Harness handleGatewayEvent={events} handleServerRequest={questions} />)
    await flushAsync()
    const socket = FakeWebSocket.instances[0]

    const emit = (data: object) => (socket as unknown as { emit: (type: string, ev: unknown) => void })
      .emit('message', { data: JSON.stringify(data) })

    const send = vi.spyOn(socket, 'send').mockImplementation(data => {
      const frame = JSON.parse(data)
      emit({ jsonrpc: '2.0', id: frame.id, result: frame.method === 'session.resume'
        ? { session_id: 'rt-alpha', revision: 1, execution_generation: 2, replay_epoch: `${frame.params.profile}-epoch`, prompts: [] }
        : { status: 'resolved' } })
    })

    try {
      await act(async () => { await activeGateway()!.request('session.resume', { session_id: 'rt-alpha', profile: 'alpha' }) })
      await act(async () => { await activeGateway()!.request('session.resume', { session_id: 'rt-alpha', profile: 'beta' }) })
      act(() => { $activeGatewayProfile.set('beta') })
      act(() => {
        deliverEvent(socket, { session_id: 'rt-alpha', type: 'session.info', replay_epoch: 'beta-epoch', seq: 1,
          payload: { revision: 2, execution_generation: 3 } })
        deliverEvent(socket, { session_id: 'rt-alpha', type: 'session.info', replay_epoch: 'alpha-epoch', seq: 1,
          payload: { revision: 2, execution_generation: 3 } })
        deliverEvent(socket, { session_id: 'rt-alpha', type: 'approval.request', replay_epoch: 'alpha-epoch', seq: 2,
          payload: { kind: 'approval', prompt_id: 'alpha-approval', execution_generation: 3, command: 'build', choices: ['once'] } })
      })
      expect(events.mock.calls.at(-1)?.[0]).toMatchObject({ profile: 'alpha', session_id: 'rt-alpha' })
      // The connection-level gateway.ready is not part of the routing under test; every other frame is.
      expect(events.mock.calls.filter(([event]) => event.type !== 'gateway.ready').map(([event]) => event.profile)).toEqual(['beta', 'alpha', 'alpha'])
      expect(runtimeSessionOwner('rt-alpha')).toBe('alpha')
      expect(questions.mock.calls.at(-1)?.[0]).toMatchObject({ profile: 'alpha', id: 'alpha-approval' })
      const question = questions.mock.calls.at(-1)?.[0] as unknown as { respond: (answer: object) => void }
      await act(async () => { question.respond({ choice: 'once' }) })
      expect(send.mock.calls.map(([data]) => JSON.parse(data)).find(frame => frame.method === 'approval.respond')?.params.profile).toBe('alpha')
    } finally { send.mockRestore() }
  })

test.each(['profile', 'connection', 'primary during relay activation'] as const)('preserves the canonical report boundary: %s', async axis => {
  const local = { ...sharedPrimaryConn, connectionId: LOCAL_CONNECTION_ID }

  const relay = {
    ...sharedPrimaryConn,
    connectionId: 'fixture-relay',
    sharedPrimary: false,
    registryScoped: true,
    wsUrl: 'ws://127.0.0.1:8898/api/ws?native_dial=fixture&ticket=one-use'
  }

  const desktop = Object.assign(fakeDesktop(), {
    getConnectionFor: vi.fn(async () => relay),
    getGatewayWsUrlFor: vi.fn(async () => relay.wsUrl)
  })

  desktop.getConnection.mockResolvedValue(local)
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop

  const runtime = 'rt-shared'
  const stored = 'chat-shared'
  const state = createClientSessionState(stored)

  const stream = renderMessageStream(runtime, {
    activeGatewayProfile: 'alpha',
    states: new Map([[runtime, state]])
  })

  const seen = vi.spyOn(browserPush, 'acknowledgeBrowserPush').mockImplementation(() => {})
  const route = vi.fn(stream.handleEvent)
  render(<Harness handleGatewayEvent={route} handleServerRequest={() => false} />)
  await flushAsync()

  const replyToResume = (socket: FakeWebSocket, epochPrefix: string) => vi.spyOn(socket, 'send').mockImplementation(data => {
    const frame = JSON.parse(data)

    const result = frame.method === 'session.resume'
      ? { session_id: runtime, revision: 1, execution_generation: 2,
          replay_epoch: `${epochPrefix}-${frame.params.profile}`, prompts: [] }
      : { status: 'resolved' }

    ;(socket as unknown as { emit: (type: string, ev: unknown) => void }).emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })
    })
  })

  const report = (socket: FakeWebSocket, epoch: string, rowId: number, seq = 1) => {
    deliverEvent(socket, {
      session_id: runtime, type: 'session.info', replay_epoch: epoch, seq,
      payload: {
        revision: 2, execution_generation: 3, stored_session_id: stored,
        cron_report: { id: rowId.toString(16).repeat(16), row_id: rowId, content: `synthetic-row-${rowId}`, timestamp: 200 }
      }
    })
  }

  const primary = FakeWebSocket.instances[0]
  const send = replyToResume(primary, 'primary')
  let relaySend: ReturnType<typeof replyToResume> | undefined

  try {
    await act(async () => {
      const attached = await activeGateway()!.request('session.resume', { session_id: runtime, profile: 'alpha' })
      const owner = sessionAttachment(attached)

      expect(owner).toMatchObject({ connectionId: LOCAL_CONNECTION_ID, profile: 'alpha', runtimeId: runtime })
      stream.states.set(runtime, { ...state, transcriptOwner: owner })
    })

    if (axis === 'profile') {
      await act(async () => { await activeGateway()!.request('session.resume', { session_id: runtime, profile: 'beta' }) })
      act(() => { $activeGatewayProfile.set('beta') })
    }

    act(() => report(primary, 'primary-alpha', 22))
    expect(stream.state().messages.map(message => message.rowId)).toEqual([22])

    if (axis === 'profile') {
      act(() => report(primary, 'primary-beta', 23))
    } else {
      let open!: Promise<boolean>
      act(() => { open = ensureGatewayForAgent(relay.connectionId, 'alpha') })
      await flushAsync()
      expect(await open).toBe(true)
      relaySend = replyToResume(FakeWebSocket.instances[1], 'relay')
      await act(async () => {
        await requestGatewayForAgent(relay.connectionId, 'alpha', 'session.resume', { session_id: runtime, profile: 'alpha' })
      })

      if (axis === 'connection') {
        act(() => report(FakeWebSocket.instances[1], 'relay-alpha', 23))
      } else {
        act(() => report(primary, 'primary-alpha', 23, 2))
      }
    }

    const secondSource = axis === 'profile'
      ? [LOCAL_CONNECTION_ID, 'beta']
      : axis === 'connection'
        ? [relay.connectionId, 'alpha']
        : [LOCAL_CONNECTION_ID, 'alpha']

    expect(route.mock.calls.filter(([event]) => event.type === 'session.info').map(([event]) =>
      [event.connectionId, event.profile])).toEqual([[LOCAL_CONNECTION_ID, 'alpha'], secondSource])
    expect(seen).not.toHaveBeenCalled()
    expect(stream.state().messages.map(message => message.rowId))
      .toEqual(axis === 'primary during relay activation' ? [22, 23] : [22])
  } finally {
    relaySend?.mockRestore()
    send.mockRestore()
    seen.mockRestore()
  }
})

test('shares a canonical resume only when the connection and profile both match', async () => {
  const local = { ...sharedPrimaryConn, connectionId: LOCAL_CONNECTION_ID }
  const desktop = fakeDesktop()

  desktop.getConnection.mockResolvedValue(local)
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
  render(<Harness handleGatewayEvent={() => undefined} handleServerRequest={() => false} />)
  await flushAsync()

  const socket = FakeWebSocket.instances[0]
  const resumes: Array<{ id: number; profile: string }> = []

  const send = vi.spyOn(socket, 'send').mockImplementation(data => {
    const frame = JSON.parse(data)

    if (frame.method === 'session.resume') {
      resumes.push({ id: frame.id, profile: frame.params.profile })
    }
  })

  try {
    const storedId = 'stored-shared'

    const resume = (profile: string) => singleFlightSessionResume(
      storedId,
      () => activeGateway()!.request<{ session_id: string; replay_epoch: string }>('session.resume', {
        session_id: storedId, profile
      }),
      { scope: { connectionId: LOCAL_CONNECTION_ID, profile } }
    )

    const alpha = resume('alpha')
    const anotherAlpha = resume('alpha')
    const beta = resume('beta')
    await flushAsync()

    await act(async () => {
      for (const { id, profile } of resumes) {
        ;(socket as unknown as { emit: (type: string, ev: unknown) => void }).emit('message', {
          data: JSON.stringify({ jsonrpc: '2.0', id, result: {
            session_id: storedId, replay_epoch: `${profile}-epoch`, prompts: []
          } })
        })
      }
    })

    const outcomes = await Promise.all([alpha, anotherAlpha, beta])

    expect({
      requestedProfiles: resumes.map(frame => frame.profile),
      returnedEpochs: outcomes.map(result => result.replay_epoch)
    }).toEqual({
      requestedProfiles: ['alpha', 'beta'],
      returnedEpochs: ['alpha-epoch', 'alpha-epoch', 'beta-epoch']
    })
  } finally {
    send.mockRestore()
  }
})

test('404 recovery adopts a runtime only from its own profile', async () => {
  const local = { ...sharedPrimaryConn, connectionId: LOCAL_CONNECTION_ID }

  const desktop = Object.assign(fakeDesktop(), {
    getConnectionFor: vi.fn(async () => ({ ...local, sharedRemote: true }))
  })

  window.document.documentElement.dataset.hermesDesktopHost = 'browser'

  desktop.getConnection.mockResolvedValue(local)
  ;(window as { hermesDesktop?: unknown }).hermesDesktop = desktop
  render(<Harness handleGatewayEvent={() => undefined} handleServerRequest={() => false} />)
  await flushAsync()

  const socket = FakeWebSocket.instances[0]
  const storedId = 'stored-recovery'
  const recoveryRequests: Array<{ id: number; profile: string }> = []
  const adopted: Record<string, string> = {}
  const attachmentOwners: Record<string, string> = {}
  const notFound = { code: 4001, message: 'session not found' }

  const emit = (frame: Record<string, unknown>) =>
    (socket as unknown as { emit: (type: string, ev: unknown) => void }).emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', ...frame })
    })

  const send = vi.spyOn(socket, 'send').mockImplementation(data => {
    const { id, method, params } = JSON.parse(data)

    if (method === 'session.resume' && params.session_id === storedId) {
      recoveryRequests.push({ id, profile: params.profile })

      return
    }

    if (method === 'session.resume' || method === 'session.usage') {
      emit(params.session_id === `live-${params.profile}` && method === 'session.usage'
        ? { id, result: { stopped: true } }
        : { id, error: notFound })
    }
  })

  try {
    const recover = (profile: string) => {
      const requestGateway = <T,>(method: string, params?: Record<string, unknown>) =>
        activeGateway()!.request<T>(method, { ...params, profile })

      return withSessionNotFoundResume(`dead-${profile}`, storedId,
        session_id => requestGateway('session.usage', { session_id }), {
          requestGateway,
          scope: { connectionId: LOCAL_CONNECTION_ID, profile },
          resolveProfile: async () => profile,
          onRecovered: (runtime, attachment) => {
            adopted[profile] = runtime
            attachmentOwners[profile] = attachment ? `${attachment.connectionId}/${attachment.profile}` : 'missing'
          }
        })
    }

    const results = Promise.allSettled([recover('alpha'), recover('beta')])
    await flushAsync()
    await act(async () => {
      for (const { id, profile } of recoveryRequests) {
        emit({ id, result: {
          session_id: `live-${profile}`, replay_epoch: `${profile}-recovery-epoch`, prompts: []
        } })
      }
    })

    expect({
      adopted,
      attachmentOwners,
      recoveries: recoveryRequests.map(request => request.profile),
      results: (await results).map(result => result.status)
    }).toEqual({
      adopted: { alpha: 'live-alpha', beta: 'live-beta' },
      attachmentOwners: { alpha: 'local/alpha', beta: 'local/beta' },
      recoveries: ['alpha', 'beta'],
      results: ['fulfilled', 'fulfilled']
    })
  } finally {
    delete window.document.documentElement.dataset.hermesDesktopHost
    send.mockRestore()
  }
})
