import { createHash, webcrypto } from 'node:crypto'
import { MessageChannel } from 'node:worker_threads'

import { LOCAL_CONNECTION_ID } from '@hermes/shared'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import { paneMirror } from '@/app/chat/pane-mirror'
import { sessionRoute, syncWorkspaceRoute } from '@/app/routes'
import { group } from '@/components/pane-shell/tree/model'
import * as tree from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { bindBrowserNotificationAdmission, takeBrowserNotificationTurn, trackBrowserNotificationTurn } from '@/lib/browser-notification-turns'
import { $composerDraft, setComposerDraft } from '@/store/composer'
import { $connection, $selectedStoredSessionId } from '@/store/session'
import {
  $sessionTiles,
  closeSessionTile,
  discardSessionTile,
  openSessionTile,
  patchSessionTile
} from '@/store/session-states'

import { useDesktopIntegrations } from './use-desktop-integrations'

const originalBridge = window.hermesDesktop

beforeAll(() => {
  const dispose = registry.register({
    area: 'panes',
    data: { placement: 'main', uncloseable: true },
    id: 'workspace',
    render: () => null,
    title: 'Chat'
  })

  tree.watchContributedPanes()
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
  window.localStorage.clear()
  tree.declareDefaultTree(group(['workspace'], { active: 'workspace', id: 'main' }))
  tree.$layoutTree.set(group(['workspace'], { active: 'workspace', id: 'main' }))
  $selectedStoredSessionId.set('main-chat')
  syncWorkspaceRoute('/main-chat')
})

afterEach(() => {
  for (const tile of $sessionTiles.get()) {
    discardSessionTile(tile.storedSessionId)
  }

  $selectedStoredSessionId.set(null)
  window.hermesDesktop = originalBridge
  syncWorkspaceRoute('/')
  $connection.set(null)
  setComposerDraft('')
  window.document.documentElement.removeAttribute('data-hermes-desktop-host')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('a native click reveals the existing remote Bot tab without changing its owner or duplicating main', () => {
  let fire!: (id: string) => void
  window.hermesDesktop = {
    onFocusSession: callback => {
      fire = callback

      return () => undefined
    }
  } as Window['hermesDesktop']
  const navigate = vi.fn()
  renderHook(() =>
    useDesktopIntegrations({
      activeProfile: 'default',
      chatOpen: false,
      hasPreview: false,
      locationPathname: '/settings',
      navigate,
      profileReady: false,
      refreshSessions: vi.fn(),
      resumeLastSession: false,
      resumeExhaustedSessionId: null,
      routedSessionId: null,
      runtimeIdByStoredSessionId: { current: new Map() },
      sessions: []
    })
  )

  const scope = {
    ownerRoute: { connectionId: 'remote-writer', profile: 'writer', mode: 'remote' as const },
    workspaceMode: 'bots' as const,
    workspaceOwnerKey: 'remote-writer::writer',
    workspaceTabTitle: 'Bot Chat'
  }

  openSessionTile('bot-chat', 'center', 'workspace', undefined, scope)
  patchSessionTile('bot-chat', { runtimeId: 'bot-runtime' })
  tree.revealTreePane('workspace')
  const before = $sessionTiles.get()

  act(() => fire('bot-runtime'))

  expect(tree.isPaneVisible('session-tile:bot-chat')).toBe(true)
  expect($sessionTiles.get()).toEqual(before)
  expect($selectedStoredSessionId.get()).toBe('main-chat')
  // Close the overlay without navigating main onto the tile's conversation.
  expect(navigate).toHaveBeenCalledWith(sessionRoute('main-chat'), { replace: true })
})

it.each(['authorized', 'wrong profile', 'expired', 'not the admitting document', 'stale at activation'])(
  'handles a Web Push offer at the live renderer boundary (%s)',
  async scenario => {
    const serviceWorker = new EventTarget()
    const sourceUrl = new URL('/hermes-notifications-sw.js', window.location.origin).href

    class WorkerSource {
      scriptURL = sourceUrl
    }
    vi.stubGlobal('navigator', { serviceWorker })
    vi.stubGlobal('ServiceWorker', WorkerSource)
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('crypto', webcrypto)
    vi.stubGlobal('__HERMES_AUTH_REQUIRED__', true)
    vi.stubGlobal('__HERMES_UI_SURFACE__', 'webapp')
    window.document.documentElement.dataset.hermesDesktopHost = 'browser'
    vi.spyOn(window.document, 'visibilityState', 'get').mockReturnValue('hidden')
    window.localStorage.setItem('hermes:web-push-installation:', 'b'.repeat(64))
    Reflect.deleteProperty(window, 'hermesDesktop')
    const prior = { connectionId: LOCAL_CONNECTION_ID, profile: 'work' } as NonNullable<ReturnType<typeof $connection.get>>
    $connection.set(prior)

    const fetch = vi.fn().mockResolvedValue(scenario === 'expired'
      ? new Response(null, { status: 401 })
      : new Response(JSON.stringify({ allowed: true })))

    vi.stubGlobal('fetch', fetch)
    const navigate = vi.fn()
    const draft = 'Unsent text in another conversation'
    setComposerDraft(draft)

    const admission = (['authorized', 'wrong profile', 'expired', 'not the admitting document', 'stale at activation']
      .indexOf(scenario) + 1).toString().repeat(32)

    if (scenario !== 'not the admitting document') {
      trackBrowserNotificationTurn('notification-submit')

      if (scenario !== 'authorized') { bindBrowserNotificationAdmission('notification-submit', admission) }

      expect(takeBrowserNotificationTurn('notification-submit', admission)).toBe('notification-submit')
    }

    const { unmount } = renderHook(() =>
      useDesktopIntegrations({
        activeProfile: 'work',
        chatOpen: true,
        hasPreview: false,
        locationPathname: '/main-chat',
        navigate,
        profileReady: true,
        refreshSessions: vi.fn(),
        resumeLastSession: false,
        resumeExhaustedSessionId: null,
        routedSessionId: 'main-chat',
        runtimeIdByStoredSessionId: { current: new Map() },
        sessions: []
      })
    )

    const { port1, port2 } = new MessageChannel()
    let response: unknown
    let settled = false

    port1.on('message', (data: unknown) => { response = data })
    port1.on('close', () => { settled = true })

    try {
      act(() => serviceWorker.dispatchEvent(Object.assign(new Event('message'), {
        source: new WorkerSource(),
        ports: [port2],
        data: { type: 'hermes:prepare-push-click', deadline: Date.now() + 950, proof: createHash('sha256').update(admission).digest('hex'),
          profile: scenario === 'wrong profile' ? 'other' : 'work', session: 'old-chat' }
      })))
      const canCommit = scenario === 'authorized' || scenario === 'stale at activation'
      await vi.waitFor(() => expect(response).toEqual(canCommit ? { ready: true, id: admission } : { ready: false }), { timeout: 850 })
      expect($sessionTiles.get()).toHaveLength(0)

      if (scenario === 'stale at activation') { $connection.set({ ...prior, profile: 'other' }) }

      if (canCommit) {
        port1.postMessage({ open: true })
        await vi.waitFor(() => expect(settled).toBe(true))
      }

      if (scenario === 'authorized') {
        await vi.waitFor(() => expect(tree.isPaneVisible('session-tile:old-chat')).toBe(true))
        expect($sessionTiles.get()[0]?.ownerRoute).toEqual({ connectionId: LOCAL_CONNECTION_ID, mode: 'local', profile: 'work' })
      } else {
        expect($sessionTiles.get()).toHaveLength(0)
      }

      expect(window.history.state).toBeNull()
      expect(navigate).not.toHaveBeenCalled()
      expect($selectedStoredSessionId.get()).toBe('main-chat')
      expect($composerDraft.get()).toBe(draft)

      if (scenario === 'wrong profile' || scenario === 'not the admitting document') {
        expect(fetch).not.toHaveBeenCalled()
      } else {
        expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/api/webapp/web-push/open', search: '?profile=work' }),
          expect.objectContaining({ redirect: 'error', credentials: 'same-origin' }))
      }
    } finally {
      port1.close()
      port2.close()
      unmount()
    }
  }
)
