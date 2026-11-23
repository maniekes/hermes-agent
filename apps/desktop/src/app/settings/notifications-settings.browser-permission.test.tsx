// Both Settings actions that can ask for browser notification permission must
// leave the permission row showing the answer, not the snapshot it mounted with.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { browserPushStatus, disableBrowserPush, enableBrowserPush, testBrowserPush } from '@/lib/browser-web-push'
import { sendTestNativeNotification, setNativeNotifyEnabled, setNativeNotifyKind } from '@/store/native-notifications'
import { notify } from '@/store/notifications'

import { NotificationsSettings } from './notifications-settings'

vi.mock('@/lib/browser-web-push', () => ({
  browserPushStatus: vi.fn(),
  disableBrowserPush: vi.fn(),
  enableBrowserPush: vi.fn(),
  testBrowserPush: vi.fn()
}))
vi.mock('@/lib/host-capabilities', () => ({ hostHas: (name: string) => name === 'browserNotifications' }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))
vi.mock('@/store/native-notifications', async () => {
  const { atom } = await import('nanostores')

  return {
    $nativeNotifyPrefs: atom({ enabled: true, kinds: { turnDone: true } }),
    NATIVE_NOTIFICATION_KINDS: ['turnDone'],
    sendTestNativeNotification: vi.fn(async () => true),
    setNativeNotifyEnabled: vi.fn(),
    setNativeNotifyKind: vi.fn()
  }
})

class FakeNotification {
  static answer: NotificationPermission = 'granted'
  static permission: NotificationPermission = 'default'
  static requestPermission = vi.fn(async () => {
    FakeNotification.permission = FakeNotification.answer

    return FakeNotification.permission
  })
}

beforeEach(() => {
  vi.mocked(browserPushStatus).mockReset().mockResolvedValue({ active: false, available: false })
  vi.mocked(disableBrowserPush).mockReset().mockResolvedValue(undefined)
  vi.mocked(enableBrowserPush).mockReset().mockResolvedValue(undefined)
  vi.mocked(testBrowserPush).mockReset().mockResolvedValue('queued')
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission.mockClear()
  vi.mocked(sendTestNativeNotification).mockReset().mockResolvedValue(true)
  vi.mocked(notify).mockClear()
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('isSecureContext', true)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderAlerts() {
  render(
    <MemoryRouter>
      <NotificationsSettings subpage="alerts" />
    </MemoryRouter>
  )
}

it.each([
  ['granted', /allowed/i],
  ['denied', /blocked/i]
] as const)('the permission row follows an answer given through Send test notification (%s)', async (answer, state) => {
  FakeNotification.answer = answer
  renderAlerts()
  expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
  })

  expect(FakeNotification.requestPermission).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  expect(screen.getByText(state)).toBeTruthy()
})

async function sendTest() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send test notification' }))
  })
}

it.each([
  ['denied', /blocked in this browser/i],
  ['unsupported', /this browser cannot show notifications/i],
  ['insecure', /needs https/i],
  ['default', /until you allow/i]
] as const)('reports %s permission without calling the notification bridge', async (state, message) => {
  FakeNotification.answer = 'default'

  if (state === 'unsupported') {
    vi.stubGlobal('Notification', undefined)
  } else if (state === 'insecure') {
    vi.stubGlobal('isSecureContext', false)
  } else {
    FakeNotification.permission = state
  }

  renderAlerts()
  await sendTest()

  expect(sendTestNativeNotification).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith({ kind: 'error', message: expect.stringMatching(message) })
})

it('reports a rejected permission request separately from a rejected send', async () => {
  FakeNotification.requestPermission.mockRejectedValueOnce(new Error('blocked request'))
  renderAlerts()
  await sendTest()
  expect(sendTestNativeNotification).not.toHaveBeenCalled()
  expect(notify).toHaveBeenLastCalledWith({ kind: 'error', message: expect.stringMatching(/could not request/i) })

  FakeNotification.answer = 'granted'
  vi.mocked(sendTestNativeNotification).mockRejectedValueOnce(new Error('worker failed'))
  await sendTest()
  expect(notify).toHaveBeenLastCalledWith({ kind: 'error', message: expect.stringMatching(/failed to send/i) })

  await sendTest()
  expect(notify).toHaveBeenLastCalledWith({ kind: 'info', message: expect.stringMatching(/test sent/i) })
})


it('enrolls only by explicit action and uses server delivery for the test', async () => {
  vi.mocked(browserPushStatus).mockResolvedValue({ active: false, available: true, publicKey: 'public' })
  FakeNotification.answer = 'granted'
  renderAlerts()
  const setup = await screen.findByRole('button', { name: 'Set up on this device' })
  expect(enableBrowserPush).not.toHaveBeenCalled()
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  vi.mocked(browserPushStatus).mockResolvedValue({ active: true, available: true, publicKey: 'public' })
  await act(async () => { fireEvent.click(setup) })
  expect(FakeNotification.requestPermission).toHaveBeenCalledOnce()
  expect(enableBrowserPush).toHaveBeenCalledWith(null, 'public')
  await sendTest()
  expect(testBrowserPush).toHaveBeenCalledWith(null)
  expect(sendTestNativeNotification).not.toHaveBeenCalled()
  expect(notify).toHaveBeenLastCalledWith({ kind: 'info', message: expect.stringMatching(/push test queued/i) })
})

it('disables server delivery from Response ready and from the main toggle', async () => {
  vi.mocked(browserPushStatus).mockResolvedValue({ active: true, available: true, publicKey: 'public' })
  renderAlerts()
  await screen.findAllByText(/Web Push is active for this profile/i)

  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Response ready' }))
  })
  expect(disableBrowserPush).toHaveBeenCalledWith(null, false)
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Enable notifications' }))
  })
  expect(disableBrowserPush).toHaveBeenCalledWith(null, true)
})


it('disables local notifications on an older backend returning POST 405', async () => {
  vi.mocked(setNativeNotifyEnabled).mockClear()
  vi.mocked(browserPushStatus).mockResolvedValue({ active: false, available: false, legacyBackend: true })
  vi.mocked(disableBrowserPush).mockRejectedValue(new Error('405: Method Not Allowed'))
  renderAlerts()
  await act(async () => {
    fireEvent.click(screen.getByRole('switch', { name: 'Enable notifications' }))
  })
  expect(setNativeNotifyEnabled).toHaveBeenCalledWith(false)
  expect(notify).not.toHaveBeenCalled()
})

it('refreshes stale enrollment when another tab has revoked it', async () => {
  vi.mocked(browserPushStatus).mockResolvedValue({ active: true, available: true, publicKey: 'public' })
  renderAlerts()
  await screen.findAllByText(/Web Push is active for this profile/i)
  vi.mocked(browserPushStatus).mockResolvedValue({ active: false, available: true, publicKey: 'public' })
  vi.mocked(testBrowserPush).mockRejectedValue(new Error('409: Web Push subscription is inactive'))
  await sendTest()
  expect(screen.queryByText(/Web Push is active for this profile/i)).toBeNull()
  expect(screen.getByRole('button', { name: 'Set up on this device' })).toBeTruthy()
  expect(sendTestNativeNotification).not.toHaveBeenCalled()
})

it('reports the test cooldown without queuing a second notification', async () => {
  vi.mocked(browserPushStatus).mockResolvedValue({ active: true, available: true, publicKey: 'public' })
  vi.mocked(testBrowserPush).mockResolvedValue('recent')
  renderAlerts()
  await screen.findAllByText(/Web Push is active for this profile/i)
  await sendTest()
  expect(notify).toHaveBeenLastCalledWith({ kind: 'info', message: expect.stringMatching(/finished recently/i) })
  expect(sendTestNativeNotification).not.toHaveBeenCalled()
})

it('does not revive active enrollment after a delayed focus refresh and successful disable', async () => {
  const active = { active: true, available: true, publicKey: 'public' }
  vi.mocked(browserPushStatus).mockResolvedValue(active)
  renderAlerts()
  await screen.findAllByText(/Web Push is active for this profile/i)
  let completeRefresh!: (status: typeof active) => void
  vi.mocked(browserPushStatus).mockReturnValueOnce(new Promise(resolve => { completeRefresh = resolve }))
  fireEvent(window, new Event('focus'))
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Response ready' })) })
  expect(screen.queryByText(/Web Push is active for this profile/i)).toBeNull()
  await act(async () => completeRefresh(active))
  expect(screen.queryByText(/Web Push is active for this profile/i)).toBeNull()
})

it('does not silently accept a profile opt-out when an existing feature returns profile unavailable', async () => {
  vi.mocked(setNativeNotifyKind).mockClear()
  vi.mocked(browserPushStatus).mockResolvedValue({ active: false, available: false })
  vi.mocked(disableBrowserPush).mockRejectedValue(new Error('404: Web Push is unavailable'))
  renderAlerts()
  await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Response ready' })) })
  expect(setNativeNotifyKind).not.toHaveBeenCalled()
  expect(notify).toHaveBeenLastCalledWith({ kind: 'error', message: expect.stringMatching(/could not be saved/i) })
})
