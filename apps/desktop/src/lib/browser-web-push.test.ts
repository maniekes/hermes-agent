import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserPushStatus, consumeBrowserPushLink, refreshExistingBrowserPushWorker } from './browser-web-push'

describe('Web Push conversation URL', () => {
  it('turns the query restored by login into the existing profile-scoped chat route', () => {
    const page = new URL('https://hermes.example/prefix/?profile=work&pushSession=old-chat')
    expect(consumeBrowserPushLink(page)?.href).toBe('https://hermes.example/prefix/?profile=work#/old-chat')
  })

  it('leaves existing routing alone and ignores external or malformed targets', () => {
    expect(consumeBrowserPushLink(new URL('https://hermes.example/?profile=work&pushSession=old-chat#/another'))).toBeUndefined()
    expect(consumeBrowserPushLink(new URL('https://hermes.example/?pushSession=https%3A%2F%2Foutside.example'))).toBeUndefined()
  })
})

describe('existing Web Push worker updates', () => {
  afterEach(() => vi.unstubAllGlobals())

  function enrolledRegistration() {
    const scope = new URL('/app/hermes-notifications/', window.location.origin).href
    const scriptURL = new URL('/app/hermes-notifications-sw.js', scope).href

    const subscription = {
      options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
      toJSON: () => ({ synthetic: true }),
      unsubscribe: vi.fn()
    }

    const registration = {
      active: { scriptURL, state: 'activated' },
      pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription), subscribe: vi.fn() },
      scope,
      unregister: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined)
    }

    const serviceWorker = { getRegistration: vi.fn().mockResolvedValue(registration), register: vi.fn() }

    vi.stubGlobal('__HERMES_AUTH_REQUIRED__', true)
    vi.stubGlobal('__HERMES_BASE_PATH__', '/app')
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('PushManager', class {})
    vi.stubGlobal('navigator', { serviceWorker })

    return { registration, serviceWorker, subscription }
  }

  it('updates a verified enrollment after status readback without changing the subscription', async () => {
    const { registration, serviceWorker, subscription } = enrolledRegistration()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ active: true, available: true, preview: true, publicKey: 'AQID' }))
      .mockResolvedValueOnce(Response.json({ active: true }))

    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('localStorage', { getItem: () => 'ab'.repeat(32) })
    expect(await browserPushStatus('beta')).toMatchObject({ active: true, needsRepair: false, preview: true })
    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce())
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(serviceWorker.register).not.toHaveBeenCalled()
    expect(registration.unregister).not.toHaveBeenCalled()
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
  })

  it('coalesces overlapping updates and allows a retry after failure', async () => {
    const { registration } = enrolledRegistration()
    let failUpdate!: (error: Error) => void
    registration.update.mockReturnValueOnce(new Promise((_, reject) => { failUpdate = reject }))

    const first = refreshExistingBrowserPushWorker()
    const second = refreshExistingBrowserPushWorker()

    await vi.waitFor(() => expect(registration.update).toHaveBeenCalledOnce())
    failUpdate(new Error('offline'))
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    await refreshExistingBrowserPushWorker()
    expect(registration.update).toHaveBeenCalledTimes(2)
  })

  it('leaves a foreign scope or script, a missing subscription and denied permission alone', async () => {
    const { registration, serviceWorker } = enrolledRegistration()
    serviceWorker.getRegistration.mockResolvedValueOnce({ ...registration, scope: window.location.origin })
      .mockResolvedValueOnce({ ...registration, active: { ...registration.active, scriptURL: '/another.js' } })
    await refreshExistingBrowserPushWorker()
    await refreshExistingBrowserPushWorker()
    registration.pushManager.getSubscription.mockResolvedValueOnce(null)
    await refreshExistingBrowserPushWorker()
    vi.stubGlobal('Notification', { permission: 'denied' })
    await refreshExistingBrowserPushWorker()

    expect(registration.update).not.toHaveBeenCalled()
    expect(serviceWorker.getRegistration).toHaveBeenCalledTimes(3)
    expect(serviceWorker.register).not.toHaveBeenCalled()
  })
})
