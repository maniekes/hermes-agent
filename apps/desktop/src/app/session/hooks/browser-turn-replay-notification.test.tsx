import type { GatewayEvent } from '@hermes/shared'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import { HermesGateway } from '@/api/client'
import { paneMirror } from '@/app/chat/pane-mirror'
import { createSessionRpcDispatcher } from '@/app/contrib/session-rpc-dispatcher'
import { group } from '@/components/pane-shell/tree/model'
import { $layoutTree, declareDefaultTree, watchContributedPanes } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { getLatestSessionMessages } from '@/hermes'
import { en } from '@/i18n/en'
import { resetInFlightTurnJournalStateForTests } from '@/lib/inflight-turn-journal'
import {
  $notificationDiagnostics,
  clearNotificationDiagnostics,
  startNotificationDiagnostics,
  stopNotificationDiagnostics
} from '@/store/browser-notification-diagnostics'
import { reportPrimaryGatewayState, setPrimaryGateway } from '@/store/gateway'
import { __resetNativeNotifyBaselineForTests, withinNativeNotifyBaseline } from '@/store/notify-baseline'
import { $activeGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $selectedStoredSessionId,
  _resetSessionOwnerHintsForTests,
  setActiveSessionId,
  setAwaitingResponse,
  setBusy,
  setConnection,
  setMessages,
  setSelectedStoredSessionId,
  setSessions
} from '@/store/session'
import {
  $focusedRuntimeId,
  $sessionTiles,
  clearAllSessionStates,
  closeSessionTile,
  discardSessionTile,
  focusOpenSession,
  openSessionTile,
  patchSessionTile
} from '@/store/session-states'
import { makeSessionInfo } from '@/test/session-info'
import type { SessionMessage } from '@/types/hermes'

import { useMessageStream } from './use-message-stream'
import { useSubmitPrompt } from './use-prompt-actions/submit'
import { useSessionActions } from './use-session-actions'
import { useSessionStateCache } from './use-session-state-cache'

vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))
vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  ensureGatewayProfile: vi.fn().mockResolvedValue(undefined)
}))

const noop = async () => undefined
const notify = vi.fn(async () => true)
let clock = Date.now()

const privateInput = 'private-input-canary'
const privateOutput = 'private-output-canary'
const privateTitle = 'private-title-canary'
const privateAdmission = 'private-admission-id-canary'
const privateSocketUrl = 'ws://fixture.test/?session=private-url-canary'
const priorMain = 'example-other-main'

beforeAll(() => {
  const dispose = registry.register({
    id: 'workspace',
    area: 'panes',
    data: { placement: 'main', uncloseable: true },
    render: () => null,
    title: 'Chat'
  })

  watchContributedPanes()
  paneMirror({
    source: $sessionTiles,
    key: tile => tile.storedSessionId,
    prefix: 'session-tile',
    dir: () => 'center',
    minWidth: '20rem',
    title: id => id,
    render: () => null,
    close: closeSessionTile
  })()

  return dispose
})

beforeEach(() => {
  clearNotificationDiagnostics()
  clock += 10_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  __resetNativeNotifyBaselineForTests()
  localStorage.clear()
  clearAllSessionStates()
  resetInFlightTurnJournalStateForTests()
  _resetSessionOwnerHintsForTests()
  $activeGatewayProfile.set('default')
  setConnection(null)
  setMessages([])
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setBusy(false)
  setAwaitingResponse(false)
  setSessions([])
  window.document.documentElement.dataset.hermesDesktopHost = 'browser'
  vi.stubGlobal('hermesDesktop', { ...window.hermesDesktop, notify })
  notify.mockClear()
})

afterEach(() => {
  cleanup()

  for (const tile of $sessionTiles.get()) {
    discardSessionTile(tile.storedSessionId)
  }

  $layoutTree.set(null)
  clearNotificationDiagnostics()
  setPrimaryGateway(null)
  delete window.document.documentElement.dataset.hermesDesktopHost
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  __resetNativeNotifyBaselineForTests()
})

class Socket extends EventTarget {
  static OPEN = 1
  static sockets: Socket[] = []
  static respond: (request: Socket['sent'][number]) => unknown
  readyState = 0
  sent: { id: string; method: string; params: Record<string, unknown> }[] = []

  constructor() {
    super()
    Socket.sockets.push(this)
  }

  send(data: string) {
    const request = JSON.parse(data) as Socket['sent'][number]
    this.sent.push(request)

    if (request.method !== 'session.events.since' && request.id) {
      queueMicrotask(() => this.frame({ jsonrpc: '2.0', id: request.id, result: Socket.respond(request) }))
    }
  }

  close() {
    this.readyState = 3
    this.dispatchEvent(new CloseEvent('close'))
  }

  open() {
    this.readyState = 1
    this.dispatchEvent(new Event('open'))
  }

  frame(frame: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  event(event: GatewayEvent) {
    this.frame({ jsonrpc: '2.0', method: 'event', params: event })
  }
}

interface Scenario {
  name: string
  chat: 'new' | 'cold' | 'warm'
  replay?: 'pending' | 'settled'
  quiet?: boolean
  origin?: 'observer'
  foreground?: boolean
  interrupted?: boolean
  tileMismatch?: boolean
  capture?: boolean
  expected: number
}

const scenarios: Scenario[] = [
  { name: 'new chat', chat: 'new', expected: 1 },
  { name: 'cold-open existing chat', chat: 'cold', expected: 1 },
  { name: 'warm-open existing chat', chat: 'warm', expected: 1 },
  { name: 'new chat with another session replaying', chat: 'new', replay: 'pending', expected: 1 },
  { name: 'existing chat after replay settles', chat: 'warm', replay: 'settled', expected: 1 },
  { name: 'existing chat while replay is pending', chat: 'warm', replay: 'pending', expected: 1 },
  {
    name: 'existing chat within the reconnect quiet window',
    chat: 'warm',
    replay: 'pending',
    quiet: true,
    expected: 1
  },
  {
    name: 'existing chat after replay settles in the quiet window',
    chat: 'warm',
    replay: 'settled',
    quiet: true,
    expected: 1
  },
  {
    name: 'observer of a replayed turn',
    chat: 'warm',
    replay: 'pending',
    origin: 'observer',
    expected: 0
  },
  { name: 'foreground existing chat', chat: 'warm', replay: 'pending', foreground: true, expected: 0 },
  { name: 'interrupted turn during replay', chat: 'warm', replay: 'pending', interrupted: true, expected: 0 },
  { name: 'focused tile with a different main session, capture off', chat: 'cold', tileMismatch: true, expected: 0 }
]

const captureCases = scenarios
  .filter(scenario => ['new chat', 'existing chat while replay is pending',
    'observer of a replayed turn', 'foreground existing chat', 'focused tile with a different main session, capture off',
    'interrupted turn during replay'].includes(scenario.name))
  .map(scenario => ({ ...scenario, name: scenario.name.replace(', capture off', '') + ', capture on', capture: true }))

it.each([...scenarios, ...captureCases])('dispatches $expected response-ready alerts for $name', async scenario => {
  const isNew = scenario.chat === 'new'
  // The canonical gateway uses the stored ID as its runtime address.
  const sessionId = isNew ? 'example-new-chat' : 'example-existing-chat'
  const admissionId = privateAdmission

  const messages: SessionMessage[] = isNew
    ? []
    : [
        { id: 1, role: 'user', content: 'Earlier question', timestamp: 1 },
        { id: 2, role: 'assistant', content: 'Earlier answer', timestamp: 2 }
      ]

  if (!isNew) {
    setSessions([
      makeSessionInfo({ id: sessionId, title: privateTitle, profile: 'default', source: 'local',
        message_count: messages.length, is_active: true })
    ])
  }

  vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(!scenario.foreground)
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(Boolean(scenario.foreground))
  vi.mocked(getLatestSessionMessages).mockResolvedValue({ session_id: sessionId, messages })

  const queryClient = new QueryClient()
  const submission: { params?: Record<string, unknown> } = {}
  let route: string | null = isNew ? null : sessionId

  const client = new HermesGateway()
  Socket.sockets = []
  vi.stubGlobal('WebSocket', Socket)

  Socket.respond = ({ method, params }) => {
    if (method === 'prompt.submit') {
      submission.params = params

      return {
        ref: { session_id: sessionId },
        admission_id: admissionId,
        submission_id: params.submission_id,
        status: 'queued'
      }
    }

    if (['session.resume', 'session.create'].includes(method)) {
      return {
        ref: { session_id: sessionId },
        session_id: sessionId,
        stored_session_id: sessionId,
        resumed: sessionId,
        messages,
        message_count: messages.length,
        running: false,
        revision: 1,
        execution_generation: 1,
        info: { stored_session_id: sessionId, profile_name: 'default' }
      }
    }

    return {}
  }

  const hook = renderHook(() => {
    const busyRef = useRef(false)
    const creatingSessionRef = useRef(false)

    const cache = useSessionStateCache({
      activeSessionId: null,
      selectedStoredSessionId: null,
      busyRef,
      setMessages,
      setBusy,
      setAwaitingResponse
    })

    const requestGateway = createSessionRpcDispatcher({
      ...cache,
      ambientRequest: (...args) => client.request(...args)
    })

    const getRouteToken = () => route ?? 'new'
    const getRoutedStoredSessionId = () => route

    const actions = useSessionActions({
      ...cache,
      activeSessionId: null,
      selectedStoredSessionId: null,
      busyRef,
      creatingSessionRef,
      getRouteToken,
      getRoutedStoredSessionId,
      navigate: () => {
        route = sessionId
      },
      requestGateway,
      routedSessionId: null
    })

    const stream = useMessageStream({
      ...cache,
      queryClient,
      hydrateFromStoredSession: noop,
      refreshHermesConfig: noop,
      refreshSessions: noop
    })

    const submit = useSubmitPrompt({
      ...cache,
      busyRef,
      copy: en.desktop,
      createBackendSessionForSend: actions.createBackendSessionForSend,
      getRouteToken,
      getRoutedStoredSessionId,
      getRuntimeIdForStoredSession: id => cache.runtimeIdByStoredSessionIdRef.current.get(id) ?? null,
      resumeStoredSession: actions.resumeSession,
      requestGateway,
      syncAttachmentsForSubmit: async (sessionId, attachments) => ({ sessionId, attachments })
    })

    return { cache, actions, stream, submit }
  })

  setPrimaryGateway(client)
  const observed: GatewayEvent[] = []
  client.onState(reportPrimaryGatewayState)
  client.onEvent(event => {
    observed.push(event)
    hook.result.current.stream.handleGatewayEvent(event)
  })

  const connect = async () => {
    const connected = client.connect(privateSocketUrl)
    const socket = Socket.sockets.at(-1)!
    socket.open()
    socket.event({ type: 'gateway.ready', payload: { session_authority: true } })
    await connected

    return socket
  }

  const resume = () => hook.result.current.actions.resumeSession(sessionId, true)

  try {
    let socket = await connect()
    let pendingResume: Promise<void> | undefined

    if (!isNew) {
      await act(resume)
    }

    if (scenario.replay) {
      const replaySession = isNew ? 'example-previous-chat' : sessionId
      act(() => socket.event({ session_id: replaySession, type: 'session.info', seq: 1, payload: { running: false } }))
      client.invalidate()
      socket = await connect()
      await vi.waitFor(() => {
        expect(socket.sent.find(request => request.method === 'session.events.since')?.params).toMatchObject({
          session_id: replaySession,
          last_seen: 1
        })
      })

      if (!isNew) {
        await act(async () => {
          pendingResume = resume()
        })
      }
    } else if (scenario.chat === 'warm') {
      await act(resume)
    }

    const releaseReplay = async (events: GatewayEvent[] = []) => {
      await act(async () => {
        const request = socket.sent.find(item => item.method === 'session.events.since')!
        socket.frame({ id: request.id, jsonrpc: '2.0', result: { events } })
        await pendingResume
      })
    }

    if (scenario.replay === 'settled') {
      await releaseReplay()
    }

    if (!scenario.quiet) {
      clock += 5_000
    }

    if (scenario.capture) {
      startNotificationDiagnostics()
    }

    expect(withinNativeNotifyBaseline()).toBe(Boolean(scenario.quiet))

    if (scenario.origin !== 'observer') {
      await act(async () => {
        expect(await hook.result.current.submit(privateInput)).toBe(true)
      })
      expect(submission.params?.session_id).toBe(sessionId)
      expect(typeof submission.params?.submission_id).toBe('string')
    }

    expect($activeSessionId.get()).toBe(sessionId)
    expect($selectedStoredSessionId.get()).toBe(sessionId)
    expect(hook.result.current.cache.activeSessionIdRef.current).toBe(sessionId)

    if (scenario.tileMismatch) {
      act(() => {
        declareDefaultTree(group(['workspace']))
        setActiveSessionId(priorMain)
        setSelectedStoredSessionId(priorMain)
        openSessionTile(sessionId, 'center', 'workspace')
        patchSessionTile(sessionId, { runtimeId: sessionId })
        expect(focusOpenSession(sessionId)).toBe('tile')
        expect($focusedRuntimeId.get()).toBe(sessionId)
      })
    }

    const stamp = { session_id: sessionId, authority_epoch: 1, execution_generation: 2, admission_id: admissionId }

    const payload = {
      status: scenario.interrupted ? ('interrupted' as const) : ('complete' as const),
      outcome: scenario.interrupted ? 'cancelled' : 'completed',
      text: privateOutput,
      persisted_turn: {
        submission_id: String(submission.params?.submission_id ?? 'example-other-client-turn'),
        complete: true,
        row_ids: []
      }
    }

    const completion: GatewayEvent<'message.complete'> = { ...stamp, type: 'message.complete', seq: 4, payload }

    act(() => {
      socket.event({ ...stamp, type: 'message.start', seq: 3, payload: {} })
      socket.event(completion)

      if (scenario.replay === 'pending' && !isNew) {
        socket.event(completion)
      }
    })

    if (scenario.replay === 'pending') {
      if (!isNew) {
        expect(observed.some(event => event.seq === completion.seq)).toBe(false)
        expect(notify).not.toHaveBeenCalled()
      }

      // Replay contains an older, unowned completion. The real transport also
      // delivers the new buffered completion with its replay marker.
      await releaseReplay(
        isNew
          ? []
          : [
              {
                ...completion,
                seq: 2,
                execution_generation: 1,
                admission_id: 'example-past-admission',
                payload: {
                  status: 'complete',
                  text: 'Earlier answer',
                  persisted_turn: { submission_id: 'example-past-turn', complete: true, row_ids: [] }
                }
              }
            ]
      )
    }

    expect(Boolean(observed.find(event => event.seq === completion.seq)?.replayed)).toBe(
      scenario.replay === 'pending' && !isNew
    )
    expect(notify).toHaveBeenCalledTimes(scenario.expected)

    if (scenario.expected) {
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'turnDone',
          sessionId,
          focusSessionId: sessionId
        })
      )
      clock += 5_000
      act(() => socket.event({ ...completion, seq: 5 }))
      expect(observed.some(event => event.seq === 5)).toBe(true)
      expect(notify).toHaveBeenCalledOnce()
    }

    if (scenario.capture) {
      act(() => socket.event({ ...completion, seq: 6, execution_generation: 1 }))
      await act(async () => undefined)
      stopNotificationDiagnostics()
      const { report } = $notificationDiagnostics.get()
      const records = report.split('\n').slice(1).map(line => JSON.parse(line))
      expect(records).toContainEqual(expect.objectContaining({ step: 'transport', outcome: 'received' }))
      expect(records).toContainEqual(expect.objectContaining({ step: 'completion', outcome: 'handled' }))
      expect(records).toContainEqual(expect.objectContaining({ step: 'gateway', outcome: 'authority-dropped' }))
      expect(records).toContainEqual(expect.objectContaining({
        step: 'ownership', pendingBeforeConsume: scenario.origin !== 'observer'
      }))

      if (scenario.origin !== 'observer') {
        expect(records).toContainEqual(expect.objectContaining({ step: 'submission', outcome: 'tracked' }))
        expect(records).toContainEqual(expect.objectContaining({ step: 'submission', outcome: 'bound' }))
      }

      if (scenario.replay === 'pending') {
        expect(records).toContainEqual(expect.objectContaining({ step: 'transport', outcome: 'replay-held' }))
        expect(records).toContainEqual(expect.objectContaining({ step: 'transport', outcome: 'replay-stale' }))
        expect(records).toContainEqual(expect.objectContaining({ step: 'completion', outcome: 'handled', replayed: true }))
      }

      if (scenario.tileMismatch) {
        expect(records).toContainEqual(expect.objectContaining({
          step: 'notify-context', matchesMain: false, matchesVisible: true
        }))
        expect(records).toContainEqual(expect.objectContaining({
          step: 'notify-filter', outcome: 'main-session-mismatch'
        }))
      }

      if (scenario.foreground) {
        expect(records).toContainEqual(expect.objectContaining({ step: 'notify-filter', outcome: 'foreground' }))
      }

      if (scenario.expected) {
        expect(records).toContainEqual(expect.objectContaining({ step: 'bridge', outcome: 'returned-true' }))
      }

      for (const canary of [privateInput, privateOutput, privateTitle, privateAdmission, privateSocketUrl,
        sessionId, submission.params?.submission_id].filter(Boolean)) {
        expect(report).not.toContain(canary)
      }
    } else {
      expect($notificationDiagnostics.get().report).toBe('')
    }
  } finally {
    client.close()
  }
})
