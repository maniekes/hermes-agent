import type { GatewayEvent } from '@hermes/shared'
import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { atom } from 'nanostores'
import { useRef } from 'react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import { HermesGateway } from '@/api/client'
import type { ComposerScope } from '@/app/chat/composer/scope'
import { paneMirror } from '@/app/chat/pane-mirror'
import { useSessionTileActions } from '@/app/chat/session-tile-actions'
import { useSessionTileDelegate } from '@/app/contrib/hooks/use-session-tile-delegate'
import { createSessionRpcDispatcher } from '@/app/contrib/session-rpc-dispatcher'
import { group } from '@/components/pane-shell/tree/model'
import { $layoutTree, declareDefaultTree, watchContributedPanes } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { getLatestSessionMessages } from '@/hermes'
import { resetInFlightTurnJournalStateForTests } from '@/lib/inflight-turn-journal'
import { createComposerAttachmentScope } from '@/store/composer'
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
  patchSessionTile,
  sessionTileDelegate
} from '@/store/session-states'
import { makeSessionInfo } from '@/test/session-info'
import type { SessionMessage } from '@/types/hermes'

import { useMessageStream } from './use-message-stream'
import { usePromptActions } from './use-prompt-actions'
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
  rewind?: 'regenerate' | 'edit'
  tile?: boolean
  twoTurns?: boolean
  failed?: boolean
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
  { name: 'regenerate', chat: 'cold', rewind: 'regenerate', expected: 1 },
  { name: 'edit and resubmit', chat: 'cold', rewind: 'edit', expected: 1 },
  { name: 'focused chat tile with a different main session', chat: 'cold', tile: true, expected: 1 },
  { name: 'foreground chat tile', chat: 'cold', tile: true, foreground: true, expected: 0 },
  { name: 'two distinct local turns within one second', chat: 'cold', twoTurns: true, expected: 1 },
  { name: 'failed local turn', chat: 'cold', failed: true, expected: 0 }
]

it.each(scenarios)('dispatches $expected response-ready alerts for $name', async scenario => {
  const isNew = scenario.chat === 'new'
  // The canonical gateway uses the stored ID as its runtime address.
  const sessionId = isNew ? 'example-new-chat' : 'example-existing-chat'
  const mainSessionId = scenario.tile ? 'example-main-chat' : sessionId
  const admissionId = 'example-admission'
  const nextAdmissionId = 'example-second-admission'

  const messages: SessionMessage[] = isNew
    ? []
    : [
        { id: 1, role: 'user', content: 'Earlier question', timestamp: 1 },
        { id: 2, role: 'assistant', content: 'Earlier answer', timestamp: 2 }
      ]

  if (!isNew) {
    setSessions([...new Set([sessionId, mainSessionId])].map(id =>
      makeSessionInfo({ id, profile: 'default', source: 'local', message_count: messages.length, is_active: true })
    ))
  }

  vi.spyOn(window.document, 'hidden', 'get').mockReturnValue(!scenario.foreground)
  vi.spyOn(window.document, 'hasFocus').mockReturnValue(Boolean(scenario.foreground))
  vi.mocked(getLatestSessionMessages).mockImplementation(async id => ({ session_id: id, messages }))

  const queryClient = new QueryClient()
  const submission: { params?: Record<string, unknown> } = {}
  let route: string | null = isNew ? null : mainSessionId

  const client = new HermesGateway()
  Socket.sockets = []
  vi.stubGlobal('WebSocket', Socket)

  Socket.respond = ({ method, params }) => {
    if (method === 'session.mutate' && params.operation === 'rewind') {
      return { session_id: sessionId, revision: 2, status: 'applied' }
    }

    if (method === 'prompt.submit') {
      const receiptAdmissionId = submission.params ? nextAdmissionId : admissionId
      submission.params = params

      return {
        ref: { session_id: sessionId },
        admission_id: receiptAdmissionId,
        submission_id: params.submission_id,
        status: 'queued'
      }
    }

    if (['session.resume', 'session.create'].includes(method)) {
      const target = params.session_id ?? sessionId

      return {
        ref: { session_id: target },
        session_id: target,
        stored_session_id: target,
        resumed: target,
        messages,
        message_count: messages.length,
        running: false,
        revision: 1,
        execution_generation: 1,
        info: { stored_session_id: target, profile_name: 'default' }
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
        route = mainSessionId
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

    const prompts = usePromptActions({
      ...cache,
      activeSessionId: null,
      branchCurrentSession: async () => false,
      busyRef,
      createBackendSessionForSend: actions.createBackendSessionForSend,
      getRouteToken,
      getRoutedStoredSessionId,
      getRuntimeIdForStoredSession: id => cache.runtimeIdByStoredSessionIdRef.current.get(id) ?? null,
      handleSkinCommand: () => '',
      openMemoryGraph: () => undefined,
      refreshSessions: noop,
      resumeStoredSession: actions.resumeSession,
      requestGateway,
      startFreshSessionDraft: () => undefined,
      sttEnabled: false
    })

    useSessionTileDelegate({
      ...cache,
      archiveSession: actions.archiveSession,
      branchLoadedSession: actions.branchLoadedSession,
      branchStoredSession: actions.branchStoredSession,
      executeSlashCommand: prompts.executeSlashCommand,
      removeSession: actions.removeSession,
      requestGateway
    })

    const scope = useRef<ComposerScope>({
      $awaitingInput: atom(false),
      $messages: atom([]),
      attachments: createComposerAttachmentScope(),
      target: `tile:${sessionId}`
    }).current

    const tile = useSessionTileActions({ requestGateway, runtimeId: sessionId, scope, storedSessionId: sessionId })

    return { cache, actions, stream, prompts, tile }
  })

  setPrimaryGateway(client)
  const observed: GatewayEvent[] = []
  client.onState(reportPrimaryGatewayState)
  client.onEvent(event => {
    observed.push(event)
    hook.result.current.stream.handleGatewayEvent(event)
  })

  const connect = async () => {
    const connected = client.connect('ws://fixture.test')
    const socket = Socket.sockets.at(-1)!
    socket.open()
    socket.event({ type: 'gateway.ready', payload: { session_authority: true } })
    await connected

    return socket
  }

  const resume = () => hook.result.current.actions.resumeSession(mainSessionId, true)

  try {
    let socket = await connect()
    let pendingResume: Promise<void> | undefined

    if (!isNew) {
      await act(resume)
    }

    if (scenario.tile) {
      await act(async () => {
        declareDefaultTree(group(['workspace']))
        openSessionTile(sessionId, 'center', 'workspace')
        const runtimeId = await sessionTileDelegate()!.resumeTile(sessionId)
        patchSessionTile(sessionId, { runtimeId })
        expect(focusOpenSession(sessionId)).toBe('tile')
      })
      expect($focusedRuntimeId.get()).toBe(sessionId)
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

    expect(withinNativeNotifyBaseline()).toBe(Boolean(scenario.quiet))

    if (scenario.rewind) {
      const user = hook.result.current.cache.sessionStateByRuntimeIdRef.current.get(sessionId)?.messages.find(
        message => message.role === 'user'
      )

      expect(user?.rowId).toBe(1)
      await act(async () => {
        if (scenario.rewind === 'regenerate') {
          await hook.result.current.prompts.reloadFromMessage(user!.id)
        } else {
          await hook.result.current.prompts.editMessage({
            content: [{ type: 'text', text: 'Edited question' }],
            createdAt: new Date(),
            metadata: { custom: {} },
            parentId: null,
            role: 'user',
            runConfig: undefined,
            sourceId: user!.id
          })
        }
      })
      const rewind = socket.sent.find(request => request.method === 'session.mutate')
      expect(rewind?.params).toMatchObject({ operation: 'rewind', payload: { target_message_id: 1 } })
      expect(submission.params).toMatchObject({
        session_id: sessionId,
        text: scenario.rewind === 'regenerate' ? 'Earlier question' : 'Edited question',
        submission_id: expect.any(String)
      })
      expect(submission.params).not.toHaveProperty('truncate_before_row_id')
    } else if (scenario.origin !== 'observer') {
      await act(async () => {
        const sender = scenario.tile ? hook.result.current.tile : hook.result.current.prompts
        expect(await sender.submitText('Example question')).toBe(true)
      })
      expect(submission.params?.session_id).toBe(sessionId)
      expect(typeof submission.params?.submission_id).toBe('string')
    }

    expect($activeSessionId.get()).toBe(mainSessionId)
    expect($selectedStoredSessionId.get()).toBe(mainSessionId)
    expect(hook.result.current.cache.activeSessionIdRef.current).toBe(mainSessionId)

    const stamp = { session_id: sessionId, authority_epoch: 1, execution_generation: 2, admission_id: admissionId }

    const status = scenario.failed ? 'error' : scenario.interrupted ? 'interrupted' : 'complete'

    const payload = {
      status,
      text: 'Example answer',
      persisted_turn: {
        // Exercise the bound-admission fallback for an edit completion without a submission ID.
        ...(scenario.rewind === 'edit'
          ? {}
          : { submission_id: String(submission.params?.submission_id ?? 'example-other-client-turn') }),
        complete: true,
        row_ids: []
      }
    } satisfies NonNullable<GatewayEvent<'message.complete'>['payload']>

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

    if (scenario.twoTurns) {
      const firstSubmissionId = submission.params?.submission_id
      clock += 100
      await act(async () => {
        expect(await hook.result.current.prompts.submitText('Another question')).toBe(true)
      })
      const secondSubmissionId = submission.params?.submission_id
      expect(typeof secondSubmissionId).toBe('string')
      expect(secondSubmissionId).not.toBe(firstSubmissionId)
      const nextStamp = { ...stamp, execution_generation: 3, admission_id: nextAdmissionId }

      const secondCompletion: typeof completion = {
        ...completion,
        ...nextStamp,
        seq: 6,
        payload: {
          ...payload,
          persisted_turn: { ...payload.persisted_turn, submission_id: String(secondSubmissionId) }
        }
      }

      act(() => {
        socket.event({ ...nextStamp, type: 'message.start', seq: 5, payload: {} })
        socket.event(secondCompletion)
      })
      expect(observed.some(event => event.seq === 6)).toBe(true)
      expect(notify).toHaveBeenCalledTimes(2)
      expect(notify).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId, tag: firstSubmissionId }))
      expect(notify).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId, tag: secondSubmissionId }))

      clock += 5_000
      act(() => socket.event({ ...secondCompletion, seq: 7, replayed: true }))
      expect(observed.some(event => event.seq === 7)).toBe(true)
      expect(notify).toHaveBeenCalledTimes(2)

      return
    }

    if (scenario.failed) {
      // A failed completion retires ownership, even if an anomalous later frame
      // for that same turn claims success.
      act(() => socket.event({ ...completion, seq: 5, replayed: true, payload: { ...payload, status: 'complete' } }))
      expect(observed.some(event => event.seq === 5)).toBe(true)
      expect(notify).not.toHaveBeenCalled()
    }

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

  } finally {
    client.close()
  }
})
