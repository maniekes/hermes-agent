import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { browserApi } from '@/lib/browser-transport'
import { enableBrowserPush } from '@/lib/browser-web-push'
import { notify } from '@/store/notifications'
import { $connection } from '@/store/session'

import { NotificationsSettings } from './notifications-settings'

vi.mock('@/lib/host-capabilities', () => ({ hostHas: (name: string) => name === 'browserNotifications' }))
vi.mock(import('@/lib/browser-transport'), async original => ({
  ...await original(),
  browserBootstrap: () => ({ authRequired: true, basePath: '', privateSession: false, token: '' }),
  browserApi: vi.fn()
}))
vi.mock(import('@/lib/browser-web-push'), async original => ({
  ...await original(),
  enableBrowserPush: vi.fn(),
  testBrowserPush: vi.fn()
}))
vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))
vi.mock('@/store/native-notifications', async () => {
  const { atom } = await import('nanostores')

  return {
    $nativeNotifyPrefs: atom({ enabled: true, kinds: { turnDone: true } }),
    NATIVE_NOTIFICATION_KINDS: ['turnDone'],
    sendTestNativeNotification: vi.fn(),
    setNativeNotifyEnabled: vi.fn(),
    setNativeNotifyKind: vi.fn()
  }
})

const api = vi.mocked(browserApi)
const requestPermission = vi.fn(async () => 'granted')
const getSubscription = vi.fn()
const update = vi.fn(async () => undefined)
const register = vi.fn()
const statusPath = '/api/webapp/web-push'
const active = { available: true, active: true, publicKey: 'AQ', preview: true, conversationPolicy: true }
const inactive = { ...active, active: false }
const view = () => render(<MemoryRouter><NotificationsSettings subpage="alerts" /></MemoryRouter>)
const chooseProfile = (profile: string) => $connection.set({ profile, mode: 'local' } as never)
const sendButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send test notification' })
const switchTo = (profile: string) => act(async () => { chooseProfile(profile) })

function deferred<T>() {
  let finish!: (value: T) => void
  const promise = new Promise<T>(resolve => { finish = resolve })

  return { finish, promise }
}

beforeEach(() => {
  api.mockReset()
  vi.mocked(enableBrowserPush).mockReset().mockResolvedValue(undefined)
  vi.mocked(notify).mockClear()
  requestPermission.mockClear()
  update.mockClear()
  register.mockClear()
  getSubscription.mockReset().mockResolvedValue({
    options: { applicationServerKey: Uint8Array.of(1).buffer },
    toJSON: () => ({ endpoint: 'https://fixture.invalid/push' })
  })
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission })
  vi.stubGlobal('PushManager', class {})
  const worker = { state: 'activated', scriptURL: new URL('/hermes-notifications-sw.js', location.origin).href }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { register, getRegistration: vi.fn(async scope => ({
      scope, active: worker, pushManager: { getSubscription }, update
    })) }
  })
  localStorage.setItem('hermes:web-push-installation:', 'a'.repeat(64))
})

afterEach(() => {
  cleanup()
  $connection.set(null)
  Reflect.deleteProperty(navigator, 'serviceWorker')
  localStorage.clear()
  vi.unstubAllGlobals()
})

it('recovers status through the existing subscription without updating the worker', async () => {
  let statusGets = 0
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}

    if (req.path === statusPath && ++statusGets === 1) {throw new Error('offline fixture')}

    if (req.path === statusPath) {return active as never}

    if (req.path === statusPath + '/check') {return { active: true } as never}
    throw new Error('unexpected fixture API call')
  })
  view()
  const retry = await screen.findByRole('button', { name: 'Retry status' })
  expect(update).not.toHaveBeenCalled()
  retry.focus()
  await act(async () => { fireEvent.click(retry) })
  expect(screen.getByRole('switch', { name: 'Show message previews' })).toBeTruthy()
  expect(update).not.toHaveBeenCalled()
  expect(api.mock.calls.filter(([, req]) => !req.path.endsWith('profile-default'))
    .map(([, req]) => [req.method, req.path])).toEqual([
    ['GET', statusPath], ['GET', statusPath], ['POST', statusPath + '/check']
  ])
  expect(register).not.toHaveBeenCalled()
  expect(enableBrowserPush).not.toHaveBeenCalled()
  expect(requestPermission).not.toHaveBeenCalled()
  const status = screen.getByRole('status')
  expect(status.textContent).toMatch(/active for this profile/)
  expect(status.ownerDocument.activeElement).toBe(status)
})

it('keeps old active controls hidden on A → B → A while both new reads are pending', async () => {
  const alpha = deferred<typeof active>()
  const beta = deferred<typeof active>()
  let alphaGets = 0
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}

    if (req.path.endsWith('/check')) {return { active: true } as never}

    if (req.path === statusPath) {
      if (req.profile === 'beta') {return beta.promise as never}

      if (++alphaGets === 1) {return active as never}

      return alpha.promise as never
    }

    throw new Error('unexpected fixture API call')
  })
  chooseProfile('alpha')
  view()
  await screen.findByRole('switch', { name: 'Show message previews' })
  await waitFor(() => expect(update).toHaveBeenCalledOnce())
  await switchTo('beta')
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
  expect(sendButton().disabled).toBe(true)
  await switchTo('alpha')
  expect(alphaGets).toBe(2)
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
  expect(sendButton().disabled).toBe(true)
  await act(async () => beta.finish(active))
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
  expect(sendButton().disabled).toBe(true)
  expect(alphaGets).toBe(2)
  await act(async () => alpha.finish(inactive))
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
  expect(sendButton().disabled).toBe(true)
})

it('offers a status read after enrollment succeeds and confirmation fails', async () => {
  getSubscription.mockResolvedValue(null)
  let statusGets = 0
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}

    if (req.path === statusPath && ++statusGets === 1) {return inactive as never}
    throw new Error('readback offline')
  })
  view()
  const setup = await screen.findByRole('button', { name: 'Set up on this device' })
  await act(async () => { fireEvent.click(setup) })
  expect(enableBrowserPush).toHaveBeenCalledOnce()
  expect(statusGets).toBe(2)
  expect(notify).toHaveBeenCalledWith({ kind: 'error', message: 'Could not confirm background notification setup. Check the status before trying again.' })
  expect(screen.queryByRole('button', { name: 'Set up on this device' })).toBeNull()
  const retry = screen.getByRole('button', { name: 'Retry status' })
  getSubscription.mockResolvedValue({
    options: { applicationServerKey: Uint8Array.of(1).buffer },
    toJSON: () => ({ endpoint: 'https://fixture.invalid/push' })
  })
  api.mockImplementation(async (_boot, req) => req.path.endsWith('/check')
    ? { active: true } as never : active as never)
  await act(async () => { fireEvent.click(retry) })
  expect(screen.getByRole('switch', { name: 'Show message previews' })).toBeTruthy()
  expect(enableBrowserPush).toHaveBeenCalledOnce()
  expect(update).not.toHaveBeenCalled()
})

it('does not publish a delayed failed status after unmount or read again on focus', async () => {
  const pending = deferred<undefined>()
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}
    await pending.promise
    throw new Error('offline fixture')
  })
  const mounted = view()
  expect(api.mock.calls.some(([, req]) => req.path === statusPath)).toBe(true)
  mounted.unmount()
  const calls = api.mock.calls.length
  await act(async () => pending.finish(undefined))
  await act(async () => { fireEvent.focus(window) })
  expect(api.mock.calls).toHaveLength(calls)
  expect(notify).not.toHaveBeenCalled()
})

it('reads back the recorded preview preference without repeating the write after a 503', async () => {
  let recordedPreview = true
  const readback = deferred<typeof active>()
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}

    if (req.path === statusPath) {return recordedPreview ? active as never : readback.promise as never}

    if (req.path.endsWith('/check')) {return { active: true } as never}

    if (req.path.endsWith('/privacy')) {
      recordedPreview = false
      throw new Error('503: Generic preference recorded; an in-flight preview is still unconfirmed')
    }

    throw new Error('unexpected fixture API call')
  })
  view()
  const preview = await screen.findByRole('switch', { name: 'Show message previews' })
  expect(preview.getAttribute('aria-checked')).toBe('true')
  await act(async () => { fireEvent.click(preview) })
  expect(notify).toHaveBeenCalledWith({ kind: 'error', message: 'Could not confirm the message preview setting.' })
  expect(recordedPreview).toBe(false)
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
  await act(async () => readback.finish({ ...active, preview: false }))
  expect(screen.getByRole('switch', { name: 'Show message previews' }).getAttribute('aria-checked')).toBe('false')
  expect(api.mock.calls.filter(([, req]) => req.path.endsWith('/privacy'))).toHaveLength(1)
})


it('keeps focus on retry if another read fails and moves it to the announced status after recovery', async () => {
  let statusGets = 0
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}

    if (++statusGets <= 2) {throw new Error('offline fixture')}

    return inactive as never
  })
  getSubscription.mockResolvedValue(null)
  view()
  const retry = await screen.findByRole('button', { name: 'Retry status' })
  retry.focus()
  await act(async () => { fireEvent.click(retry) })
  expect(retry.ownerDocument.activeElement).toBe(retry)
  await act(async () => { fireEvent.click(retry) })
  const status = screen.getByRole('status')
  expect(status.textContent).toMatch(/Set up Web Push/)
  expect(status.ownerDocument.activeElement).toBe(status)
})


it('does not create an installation or send a request if the installation is missing at retry', async () => {
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}
    throw new Error('offline fixture')
  })
  view()
  const retry = await screen.findByRole('button', { name: 'Retry status' })
  const key = 'hermes:web-push-installation:'
  localStorage.removeItem(key)
  api.mockClear()
  retry.focus()
  await act(async () => { fireEvent.click(retry) })
  expect(localStorage.getItem(key)).toBeNull()
  expect(api).not.toHaveBeenCalled()
  expect(update).not.toHaveBeenCalled()
  expect(register).not.toHaveBeenCalled()
  expect(requestPermission).not.toHaveBeenCalled()
  const status = screen.getByRole('status')
  expect(status.textContent).toBe('Background notifications are unavailable on this device.')
  expect(status.ownerDocument.activeElement).toBe(status)
})

it.each([false, true])('separates Retry from Setup when a focus read overtakes it (focus moves: %s)', async movesFocus => {
  const pending = deferred<typeof inactive>()
  let reads = 0
  getSubscription.mockResolvedValue(null)
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}

    if (req.path !== statusPath) {throw new Error('unexpected request')}

    if (++reads === 1) {throw new Error('initial read unavailable')}

    if (reads === 2) {return pending.promise as never}

    return inactive as never
  })
  view()
  const retry = await screen.findByRole('button', { name: 'Retry status' })
  const master = screen.getByRole('switch', { name: 'Enable notifications' })

  retry.focus()
  fireEvent.click(retry)
  expect(reads).toBe(2)

  if (movesFocus) { master.focus() }

  await act(async () => { fireEvent.focus(window) })
  expect(reads).toBe(3)
  const setup = screen.getByRole('button', { name: 'Set up on this device' })
  const status = screen.getByRole('status')

  expect(setup).not.toBe(retry)
  expect(status.textContent).toMatch(/Set up Web Push/)
  expect(retry.ownerDocument.activeElement).toBe(movesFocus ? master : status)
  await act(async () => pending.finish(inactive))
  expect(retry.ownerDocument.activeElement).toBe(movesFocus ? master : status)

  if (!movesFocus) {
    await act(async () => { fireEvent.click(status.ownerDocument.activeElement!) })
  }

  expect(enableBrowserPush).not.toHaveBeenCalled()
})

it('offers a status check after accepted enrollment reads inactive before another setup can be started', async () => {
  getSubscription.mockResolvedValue(null)
  api.mockImplementation(async (_boot, req) => {
    if (req.path.endsWith('profile-default')) {return undefined as never}

    if (req.path === statusPath) {return inactive as never}

    throw new Error('unexpected request')
  })
  view()
  const setup = await screen.findByRole('button', { name: 'Set up on this device' })

  await act(async () => { fireEvent.click(setup) })
  expect(enableBrowserPush).toHaveBeenCalledOnce()
  expect(notify).toHaveBeenCalledWith({
    kind: 'error', message: 'Could not confirm background notification setup. Check the status before trying again.'
  })
  expect(screen.queryByRole('button', { name: 'Set up on this device' })).toBeNull()
  const retry = screen.getByRole('button', { name: 'Retry status' })

  await act(async () => { fireEvent.focus(window) })
  expect(screen.getByRole('button', { name: 'Retry status' })).toBe(retry)
  expect(screen.queryByRole('button', { name: 'Set up on this device' })).toBeNull()
  retry.focus()
  await act(async () => { fireEvent.click(retry) })

  expect(screen.getByRole('button', { name: 'Set up on this device' })).not.toBe(retry)
  expect(retry.ownerDocument.activeElement).toBe(screen.getByRole('status'))
  expect(enableBrowserPush).toHaveBeenCalledOnce()
  expect(api.mock.calls.filter(([, req]) => req.path === statusPath)).toHaveLength(4)
})
