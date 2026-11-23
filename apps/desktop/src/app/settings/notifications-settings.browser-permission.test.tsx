// Both Settings actions that can ask for browser notification permission must
// leave the permission row showing the answer, not the snapshot it mounted with.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { sendTestNativeNotification } from '@/store/native-notifications'
import { notify } from '@/store/notifications'

import { NotificationsSettings } from './notifications-settings'

vi.mock('@/lib/host-capabilities', () => ({ hostHas: (name: string) => name === 'browserNotifications' }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn() }))
vi.mock('@/store/native-notifications', async () => {
  const { atom } = await import('nanostores')

  return {
    $nativeNotifyPrefs: atom({ enabled: true, kinds: {} }),
    NATIVE_NOTIFICATION_KINDS: [],
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
