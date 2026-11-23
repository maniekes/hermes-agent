import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  $notificationDiagnostics,
  clearNotificationDiagnostics,
  startNotificationDiagnostics,
  stopNotificationDiagnostics
} from '@/store/browser-notification-diagnostics'

import { onBrowserFocusSession, showBrowserNotification } from './browser-notifications'

const created: FakeNotification[] = []

class FakeNotification {
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn(async () => FakeNotification.permission)
  static showError = false
  onclick: (() => void) | null = null
  onerror: (() => void) | null = null
  onshow: (() => void) | null = null
  close = vi.fn()

  constructor(public title: string) {
    created.push(this)
    queueMicrotask(() => {
      if (FakeNotification.showError) {
        this.onerror?.()
      } else {
        this.onshow?.()
      }
    })
  }
}

class MobileNotification extends FakeNotification {
  constructor(title: string) {
    super(title)
    throw new TypeError('Illegal constructor')
  }
}

function workerFixture(reply: object = { ok: true }) {
  vi.stubGlobal('Notification', MobileNotification)
  const postMessage = vi.fn((_message: unknown, [port]: MessagePort[]) => port.postMessage(reply))
  const registration = { active: { postMessage, state: 'activated' } }
  const register = vi.fn(async () => registration)
  const serviceWorker = Object.assign(new EventTarget(), { register })
  vi.stubGlobal('navigator', { serviceWorker })

  return { postMessage, register, serviceWorker }
}

describe('showBrowserNotification', () => {
  beforeEach(() => {
    created.length = 0
    FakeNotification.permission = 'granted'
    FakeNotification.showError = false
    FakeNotification.requestPermission.mockClear()
    vi.stubGlobal('Notification', FakeNotification)
    vi.stubGlobal('isSecureContext', true)
  })

  afterEach(() => {
    clearNotificationDiagnostics()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['default', 'denied'] as const)('does not send or prompt if permission is %s', async permission => {
    FakeNotification.permission = permission

    expect(await showBrowserNotification({ sessionId: 's1' })).toBe(false)
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
  })

  it.each(['unsupported', 'insecure'] as const)('returns false when the context is %s', async state => {
    vi.stubGlobal(
      state === 'unsupported' ? 'Notification' : 'isSecureContext',
      state === 'unsupported' ? undefined : false
    )

    expect(await showBrowserNotification({})).toBe(false)
    expect(created).toHaveLength(0)
  })

  it('shows a notification through the worker when the constructor is unavailable on mobile', async () => {
    const { postMessage, register, serviceWorker } = workerFixture()
    const opened = vi.fn()
    const off = onBrowserFocusSession(opened)

    expect(
      await showBrowserNotification(
        { focusSessionId: 'stored-1', kind: 'turnDone', sessionId: 'rt-1', silent: true, title: 'Response ready' },
        { basePath: '/webapp', reopenProfile: 'work' }
      )
    ).toBe(true)
    const scriptURL = new URL('/webapp/hermes-notifications-sw.js', window.location.href).href
    expect(register).toHaveBeenCalledWith(scriptURL, {
      scope: new URL('/webapp/hermes-notifications/', scriptURL).href
    })
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ silent: true, tag: 'hermes:turnDone:stored-1' }),
        reopenProfile: 'work',
        reopenSessionId: 'stored-1',
        sessionId: 'stored-1',
        type: 'hermes:show-notification'
      }),
      expect.any(Array)
    )

    const click = (url: string, sessionId: unknown) => {
      const message = new Event('message')
      Object.assign(message, { data: { sessionId, type: 'hermes:focus-session' }, source: { scriptURL: url } })
      serviceWorker.dispatchEvent(message)
    }

    click(new URL('/other-sw.js', scriptURL).href, 'other')
    click(scriptURL, {})
    click(scriptURL, 'stored-1')
    off()
    click(scriptURL, 'after-unsubscribe')
    expect(opened.mock.calls).toEqual([['stored-1']])
  })

  it('propagates worker registration and display errors', async () => {
    const { register, postMessage } = workerFixture({ ok: false, error: 'NotAllowedError' })
    register.mockRejectedValueOnce(new Error('registration failed'))

    await expect(showBrowserNotification({})).rejects.toThrow('registration failed')
    expect(postMessage).not.toHaveBeenCalled()
    await expect(showBrowserNotification({})).rejects.toThrow('NotAllowedError')
    expect(postMessage).toHaveBeenCalledOnce()
  })

  it('reports permission, successful worker delivery and failure codes without leaking the inputs', async () => {
    const canary = 'private-notification-diagnostic-canary'
    const { register } = workerFixture()
    const payload = { body: canary, title: canary, focusSessionId: canary, tag: canary }
    startNotificationDiagnostics()
    FakeNotification.permission = 'denied'
    expect(await showBrowserNotification(payload)).toBe(false)
    FakeNotification.permission = 'granted'
    expect(await showBrowserNotification(payload)).toBe(true)
    register.mockRejectedValueOnce(new Error(canary))
    await expect(showBrowserNotification(payload)).rejects.toThrow(canary)
    workerFixture({ ok: false, error: canary })
    await expect(showBrowserNotification(payload)).rejects.toThrow(canary)
    stopNotificationDiagnostics()

    const { report } = $notificationDiagnostics.get()
    const outcomes = report.split('\n').slice(1).map(line => JSON.parse(line).outcome)
    expect(outcomes).toEqual([
      'denied',
      'granted', 'constructor-fallback', 'worker-registering', 'worker-registered',
      'worker-active', 'worker-posted', 'worker-shown',
      'granted', 'constructor-fallback', 'worker-registering', 'worker-register-failed',
      'granted', 'constructor-fallback', 'worker-registering', 'worker-registered',
      'worker-active', 'worker-posted', 'worker-show-failed'
    ])
    expect(report).not.toContain(canary)
    expect(report).not.toContain(window.location.origin)
  })

  it('propagates desktop delivery errors without retrying via the worker', async () => {
    FakeNotification.showError = true
    const register = vi.fn()
    vi.stubGlobal('navigator', { serviceWorker: { register } })

    await expect(showBrowserNotification({})).rejects.toThrow('failed to show')
    expect(register).not.toHaveBeenCalled()
  })

  it('opens the notified session through the desktop constructor when clicked', async () => {
    const opened = vi.fn()
    const off = onBrowserFocusSession(opened)
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined)

    expect(
      await showBrowserNotification({
        focusSessionId: 'stored-1',
        kind: 'approval',
        sessionId: 'rt-1',
        title: 'Approval needed'
      })
    ).toBe(true)
    created[0].onclick?.()

    expect(focus).toHaveBeenCalled()
    expect(created[0].close).toHaveBeenCalled()
    expect(opened.mock.calls).toEqual([['stored-1']])
    off()
  })
})
