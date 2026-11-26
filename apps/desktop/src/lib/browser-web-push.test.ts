import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserPushStatus, consumeBrowserPushLink, enableBrowserPush, readProfileDefault, refreshExistingBrowserPushWorker, writeProfileDefault } from './browser-web-push'

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

  it('distinguishes an unconfirmed subscription write from a definite profile refusal', async () => {
    const { registration, serviceWorker } = enrolledRegistration()

    serviceWorker.register.mockResolvedValue(registration)
    vi.stubGlobal('localStorage', { getItem: () => 'ab'.repeat(32) })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ detail: 'web_push_enrollment_unconfirmed' }, { status: 503 }))
      .mockRejectedValueOnce(new DOMException('', 'AbortError'))
      .mockResolvedValueOnce(Response.json({ detail: 'Selected Webapp profile is unavailable' }, { status: 503 })))

    await expect(enableBrowserPush('beta', 'AQID')).resolves.toBe('unconfirmed')
    await expect(enableBrowserPush('beta', 'AQID')).resolves.toBe('unconfirmed')
    await expect(enableBrowserPush('beta', 'AQID')).rejects.toThrow('Selected Webapp profile is unavailable')
    expect(registration.pushManager.subscribe).not.toHaveBeenCalled()
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

describe('Response ready profile default', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('addresses a single named profile through the cookie API without installation headers', async () => {
    vi.stubGlobal('__HERMES_AUTH_REQUIRED__', true)
    vi.stubGlobal('__HERMES_BASE_PATH__', '/prefix')

    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ enabled: false, revision: 3 }))
      .mockResolvedValueOnce(Response.json({ enabled: true, revision: 4 }))

    vi.stubGlobal('fetch', fetch)
    expect(await readProfileDefault('beta')).toEqual({ enabled: false, revision: 3 })
    await writeProfileDefault('beta', true, 3)

    for (const [url, options] of fetch.mock.calls) {
      expect(url.pathname).toBe('/prefix/api/webapp/web-push/profile-default')
      expect(url.searchParams.get('profile')).toBe('beta')
      expect(options.credentials).toBe('same-origin')
      expect(options.headers.has('X-Hermes-Push-Installation')).toBe(false)
    }

    expect(fetch.mock.calls[1][1]).toMatchObject({
      body: JSON.stringify({ enabled: true, expected_revision: 3 }),
      method: 'POST'
    })
  })

  it('distinguishes a legacy endpoint from an unavailable selected profile', async () => {
    vi.stubGlobal('__HERMES_AUTH_REQUIRED__', true)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 })))
    expect(await readProfileDefault('beta')).toBeUndefined()
    expect(await readProfileDefault('beta')).toBeUndefined()
    await expect(readProfileDefault('beta')).rejects.toThrow('503:')
  })
})
