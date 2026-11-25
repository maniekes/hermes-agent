import '@/i18n/pl_notifications'

// Both Settings actions that can ask for browser notification permission must
// leave the permission row showing the answer, not the snapshot it mounted with.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { I18nProvider, useI18n } from '@/i18n'
import { browserPushStatus, disableBrowserPush, enableBrowserPush, setBrowserPushPreview, testBrowserPush } from '@/lib/browser-web-push'
import { $nativeNotifyPrefs, sendTestNativeNotification, setNativeNotifyEnabled, setNativeNotifyKind } from '@/store/native-notifications'
import { notify } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import { NotificationsSettings } from './notifications-settings'

const { hostHas, readProfileDefault, writeProfileDefault } = vi.hoisted(() => ({
  hostHas: vi.fn((name: string) => name === 'browserNotifications'),
  readProfileDefault: vi.fn(),
  writeProfileDefault: vi.fn()
}))

vi.mock('@/lib/browser-web-push', () => ({
  browserPushStatus: vi.fn(),
  disableBrowserPush: vi.fn(),
  enableBrowserPush: vi.fn(),
  readProfileDefault,
  setBrowserPushPreview: vi.fn(),
  testBrowserPush: vi.fn(),
  writeProfileDefault
}))
vi.mock('@/lib/host-capabilities', () => ({ hostHas }))
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
  $connection.set(null)
  $activeGatewayProfile.set('default')
  $nativeNotifyPrefs.set({ ...$nativeNotifyPrefs.get(), enabled: true })
  hostHas.mockClear().mockImplementation(name => name === 'browserNotifications')
  readProfileDefault.mockReset().mockResolvedValue(undefined)
  writeProfileDefault.mockReset()
  vi.mocked(setNativeNotifyEnabled).mockClear()
  vi.mocked(setNativeNotifyKind).mockClear()
  vi.mocked(setBrowserPushPreview).mockReset()
  vi.mocked(browserPushStatus).mockReset().mockResolvedValue({ active: false, available: false })
  vi.mocked(disableBrowserPush).mockReset().mockResolvedValue(undefined)
  vi.mocked(enableBrowserPush).mockReset().mockResolvedValue(undefined)
  vi.mocked(testBrowserPush).mockReset().mockResolvedValue('queued')
  FakeNotification.answer = 'granted'
  FakeNotification.permission = 'default'
  FakeNotification.requestPermission.mockClear()
  vi.mocked(sendTestNativeNotification).mockReset().mockResolvedValue(true)
  vi.mocked(notify).mockClear()
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('isSecureContext', true)
})

afterEach(() => {
  cleanup()
  $connection.set(null)
  $activeGatewayProfile.set('default')
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
  await sendTest()

  expect(FakeNotification.requestPermission).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
  expect(screen.getByText(state)).toBeTruthy()
  expect(sendTestNativeNotification).toHaveBeenCalledTimes(answer === 'granted' ? 1 : 0)
  expect(testBrowserPush).not.toHaveBeenCalled()
})

async function sendTest() {
  const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Send test notification' })
  await waitFor(() => expect(button.disabled).toBe(false))
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
  expect(notify).toHaveBeenLastCalledWith({ kind: 'error', message: 'Set up background notifications on this device to send a test.' })
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

it('allows device enrollment when the legacy response-ready preference is off', async () => {
  const saved = $nativeNotifyPrefs.get()
  $nativeNotifyPrefs.set({ ...saved, kinds: { ...saved.kinds, turnDone: false } })
  vi.mocked(browserPushStatus).mockResolvedValue({ active: false, available: true, conversationPolicy: true, publicKey: 'public' })

  try {
    renderAlerts()
    const setup = await screen.findByRole<HTMLButtonElement>('button', { name: 'Set up on this device' })
    expect(setup.disabled).toBe(false)
    expect(screen.queryByRole('switch', { name: 'Response ready' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'Enable notifications' })).toBeTruthy()
  } finally {
    $nativeNotifyPrefs.set(saved)
  }
})

it('shows only server-confirmed preview consent and reads it again on an unconfirmed update', async () => {
  vi.mocked(browserPushStatus).mockResolvedValue({ active: true, available: true, preview: false })
  let confirm!: (value: boolean) => void
  vi.mocked(setBrowserPushPreview).mockReturnValueOnce(new Promise(resolve => { confirm = resolve }))
  renderAlerts()
  const privacy = await screen.findByRole('switch', { name: 'Show message previews' })
  expect(privacy.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(privacy)
  expect(setBrowserPushPreview).toHaveBeenCalledWith(null, true)
  expect(privacy.getAttribute('aria-checked')).toBe('false')
  await act(async () => confirm(true))
  expect(privacy.getAttribute('aria-checked')).toBe('true')
  vi.mocked(browserPushStatus).mockResolvedValue({ active: true, available: true, preview: true })
  vi.mocked(setBrowserPushPreview).mockRejectedValueOnce(new Error('unavailable'))
  await act(async () => { fireEvent.click(privacy) })
  expect(screen.getByRole('switch', { name: 'Show message previews' }).getAttribute('aria-checked')).toBe('true')
  expect(notify).toHaveBeenLastCalledWith({ kind: 'error', message: 'Could not confirm the message preview setting.' })
})

it('shows the named profile default with neither device enrollment nor master enabled', async () => {
  $activeGatewayProfile.set('beta')
  $nativeNotifyPrefs.set({ ...$nativeNotifyPrefs.get(), enabled: false })
  readProfileDefault.mockResolvedValueOnce({ enabled: false, revision: 1 })
    .mockResolvedValueOnce({ enabled: true, revision: 2 })
  let resolveWrite!: () => void
  writeProfileDefault.mockReturnValueOnce(new Promise<void>(resolve => { resolveWrite = resolve }))
  renderAlerts()
  const row = await screen.findByRole('switch', { name: 'Response ready default (beta)' })
  const master = screen.getByRole('switch', { name: 'Enable notifications' })
  expect(row.getAttribute('aria-checked')).toBe('false')
  expect(master.getAttribute('aria-checked')).toBe('false')
  expect(readProfileDefault).toHaveBeenCalledWith('beta')

  fireEvent.click(row)
  expect(writeProfileDefault).toHaveBeenCalledWith('beta', true, 1)
  expect(row.getAttribute('aria-checked')).toBe('false')
  await act(async () => resolveWrite())
  expect(row.getAttribute('aria-checked')).toBe('true')
  expect(master.getAttribute('aria-checked')).toBe('false')
  expect(enableBrowserPush).not.toHaveBeenCalled()
})

it('reconciles a profile conflict and ignores late focus and previous-profile reads', async () => {
  $activeGatewayProfile.set('beta')
  let finishFocus!: (value: unknown) => void
  let finishProfile!: (value: unknown) => void
  readProfileDefault.mockResolvedValueOnce({ enabled: false, revision: 1 })
    .mockReturnValueOnce(new Promise(resolve => { finishFocus = resolve }))
    .mockResolvedValueOnce({ enabled: true, revision: 2 })
    .mockReturnValueOnce(new Promise(resolve => { finishProfile = resolve }))
    .mockResolvedValueOnce({ enabled: false, revision: 0 })
  writeProfileDefault.mockRejectedValueOnce(new Error('409: conflict'))
  renderAlerts()
  const row = await screen.findByRole('switch', { name: 'Response ready default (beta)' })
  fireEvent.focus(window)
  await act(async () => { fireEvent.click(row) })
  await act(async () => finishFocus({ enabled: false, revision: 1 }))
  expect(row.getAttribute('aria-checked')).toBe('true')
  expect(writeProfileDefault).toHaveBeenCalledTimes(1)
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }))

  fireEvent.focus(window)
  await act(async () => { $activeGatewayProfile.set('alpha') })
  await act(async () => finishProfile({ enabled: true, revision: 8 }))
  expect(screen.queryByRole('switch', { name: 'Response ready default (beta)' })).toBeNull()
  expect(screen.getByRole('switch', { name: 'Response ready default (alpha)' }).getAttribute('aria-checked')).toBe('false')
})

it('shows an unavailable status after failed profile default readback', async () => {
  readProfileDefault.mockResolvedValueOnce({ enabled: false, revision: 1 })
    .mockRejectedValueOnce(new Error('unavailable'))
  writeProfileDefault.mockRejectedValueOnce(new Error('unavailable'))
  renderAlerts()
  const row = await screen.findByRole('switch', { name: 'Response ready default (default)' })
  await act(async () => { fireEvent.click(row) })
  expect(screen.queryByRole('switch', { name: 'Response ready default (default)' })).toBeNull()
  expect(screen.getByText('The profile default could not be read.')).toBeTruthy()
})

const inactive = { active: false, available: true, conversationPolicy: true, publicKey: 'public' }
const testButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send test notification' })

it.each([
  [false, inactive, 'Set up on this device', 'Turn on notifications on this device first.'],
  [true, inactive, 'Set up on this device', 'Set up background notifications on this device to send a test.'],
  [true, { ...inactive, needsRepair: true }, 'Repair', 'Repair background notifications on this device to send a test.']
] as const)('explains the unavailable test (master %s, status %o)', async (enabled, status, action, hint) => {
  $nativeNotifyPrefs.set({ ...$nativeNotifyPrefs.get(), enabled })
  vi.mocked(browserPushStatus).mockResolvedValue(status)
  renderAlerts()
  const setup = await screen.findByRole<HTMLButtonElement>('button', { name: action })
  expect(setup.disabled).toBe(!enabled)
  expect(screen.getAllByText(hint).length).toBeGreaterThan(0)
  expect(testButton().disabled).toBe(true)
  fireEvent.click(testButton())
  expect(testBrowserPush).not.toHaveBeenCalled()
  expect(sendTestNativeNotification).not.toHaveBeenCalled()
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
})

it.each([false, true])('retries only the status read with master enabled %s', async enabled => {
  $nativeNotifyPrefs.set({ ...$nativeNotifyPrefs.get(), enabled })
  vi.mocked(browserPushStatus).mockRejectedValueOnce(new Error('unreachable'))
    .mockRejectedValueOnce(new Error('still unreachable'))
    .mockResolvedValue(inactive)
  renderAlerts()
  const retry = await screen.findByRole<HTMLButtonElement>('button', { name: 'Retry status' })
  expect(testButton().disabled).toBe(true)
  expect(retry.disabled).toBe(false)
  expect(testButton().getAttribute('aria-describedby')).toBeTruthy()
  expect(screen.getByText(enabled ? 'Retry the status check before sending a test.' : 'Turn on notifications on this device first.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Repair' })).toBeNull()
  await act(async () => { fireEvent.click(retry) })
  expect(screen.getByRole('button', { name: 'Retry status' })).toBeTruthy()
  await act(async () => { fireEvent.click(retry) })
  expect(vi.mocked(browserPushStatus).mock.calls).toEqual([[null], [null, { observeOnly: true }], [null, { observeOnly: true }]])
  expect(screen.queryByRole('button', { name: 'Retry status' })).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Set up on this device' }).disabled).toBe(!enabled)
  expect(testButton().disabled).toBe(true)
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
  expect(enableBrowserPush).not.toHaveBeenCalled()
  expect(disableBrowserPush).not.toHaveBeenCalled()
  expect(testBrowserPush).not.toHaveBeenCalled()
  expect(setBrowserPushPreview).not.toHaveBeenCalled()
  expect(setNativeNotifyEnabled).not.toHaveBeenCalled()
  expect(setNativeNotifyKind).not.toHaveBeenCalled()
  expect(writeProfileDefault).not.toHaveBeenCalled()
})

it('repairs only on explicit action and reveals preview on confirmed activation', async () => {
  vi.mocked(browserPushStatus).mockResolvedValueOnce({ ...inactive, needsRepair: true })
    .mockResolvedValueOnce({ ...inactive, active: true, preview: false })
  renderAlerts()
  const repair = await screen.findByRole('button', { name: 'Repair' })
  expect(screen.getByText('Reconnect background notifications on this device.')).toBeTruthy()
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
  expect(enableBrowserPush).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(repair) })
  expect(enableBrowserPush).toHaveBeenCalledOnce()
  expect(enableBrowserPush).toHaveBeenCalledWith(null, 'public')
  expect(screen.getByRole('switch', { name: 'Show message previews' }).getAttribute('aria-checked')).toBe('false')
  expect(testButton().disabled).toBe(false)
})

it('prevents a delayed retry from an earlier push profile replacing the current status', async () => {
  let resolveRetry!: (status: Awaited<ReturnType<typeof browserPushStatus>>) => void
  vi.mocked(browserPushStatus).mockRejectedValueOnce(new Error('offline'))
    .mockReturnValueOnce(new Promise(resolve => { resolveRetry = resolve }))
    .mockResolvedValue({ ...inactive, needsRepair: true })
  renderAlerts()
  fireEvent.click(await screen.findByRole('button', { name: 'Retry status' }))
  await act(async () => {
    $connection.set({
      baseUrl: 'https://hermes.invalid', isFullscreen: false, logs: [], mode: 'local',
      nativeOverlayWidth: 0, profile: 'beta', token: '', windowButtonPosition: null,
      wsUrl: 'wss://hermes.invalid/ws'
    })
  })
  expect(browserPushStatus).toHaveBeenLastCalledWith('beta')
  expect(screen.getByRole('button', { name: 'Repair' })).toBeTruthy()
  await act(async () => resolveRetry({ ...inactive, active: true, preview: true }))
  expect(screen.getByRole('button', { name: 'Repair' })).toBeTruthy()
  expect(screen.queryByRole('switch', { name: 'Show message previews' })).toBeNull()
})

it.each(['denied', 'default'] as const)('explains missing setup permission (%s) without enrolling', async permission => {
  FakeNotification.answer = permission
  vi.mocked(browserPushStatus).mockResolvedValue(inactive)
  renderAlerts()
  const setup = await screen.findByRole('button', { name: 'Set up on this device' })
  await act(async () => { fireEvent.click(setup) })
  expect(notify).toHaveBeenLastCalledWith({
    kind: 'error',
    message: expect.stringMatching(permission === 'denied' ? /blocked in this browser/i : /until you allow/i)
  })
  expect(enableBrowserPush).not.toHaveBeenCalled()
  expect(setBrowserPushPreview).not.toHaveBeenCalled()
})

it.each(['remote', 'native'] as const)('keeps the %s test on its existing fallback and honors the device master', async surface => {
  hostHas.mockImplementation(name => surface === 'remote' && name === 'browserNotifications')
  $connection.set({
    baseUrl: 'https://hermes.invalid', connectionId: 'remote', isFullscreen: false, logs: [], mode: 'remote',
    nativeOverlayWidth: 0, token: '', windowButtonPosition: null, wsUrl: 'wss://hermes.invalid/ws'
  })
  renderAlerts()
  await sendTest()
  expect(sendTestNativeNotification).toHaveBeenCalledOnce()
  expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(surface === 'remote' ? 1 : 0)
  expect(browserPushStatus).not.toHaveBeenCalled()
  expect(testBrowserPush).not.toHaveBeenCalled()
  expect(readProfileDefault).not.toHaveBeenCalled()
  await act(async () => { $nativeNotifyPrefs.set({ ...$nativeNotifyPrefs.get(), enabled: false }) })
  expect(testButton().disabled).toBe(true)
  expect(screen.getByText('Turn on notifications on this device first.')).toBeTruthy()
})

function LocaleProbe() {
  const { locale, t } = useI18n()

  return <output>{locale} / {t.settings.notifications.completionSoundPreview}</output>
}

it.each([
  ['pl', 'pl', 'To urządzenie', 'Domyślne dla rozmów'],
  ['en', 'en', 'This device', 'Conversation defaults'],
  [undefined, 'en', 'This device', 'Conversation defaults']
] as const)('resolves notification copy from the saved language (%s) without changing preferences', async (saved, locale, device, conversations) => {
  readProfileDefault.mockResolvedValue({ enabled: false, revision: 1 })

  const configClient = {
    getConfig: vi.fn(async () => ({ display: { language: saved } })),
    saveConfig: vi.fn()
  }

  const machine = { getMachineProfile: vi.fn(async () => ({ locale: 'pl-PL' })) }
  vi.stubGlobal('hermesDesktop', machine)
  render(
    <MemoryRouter>
      <I18nProvider configClient={configClient}>
        <LocaleProbe />
        <NotificationsSettings subpage="alerts" />
      </I18nProvider>
    </MemoryRouter>
  )
  expect(await screen.findByText(`${locale} / Preview`)).toBeTruthy()
  const deviceGroup = await screen.findByRole('region', { name: device })
  const profileGroup = await screen.findByRole('region', { name: conversations })
  expect(within(deviceGroup).getByRole('switch', { name: locale === 'pl' ? 'Włącz powiadomienia' : 'Enable notifications' })).toBeTruthy()
  expect(within(profileGroup).getByText(locale === 'pl' ? /nowych i istniejących rozmów.*w tym profilu/i : /new and existing conversations.*in this profile/i)).toBeTruthy()
  expect(machine.getMachineProfile).toHaveBeenCalledTimes(saved === undefined ? 1 : 0)
  expect(configClient.saveConfig).not.toHaveBeenCalled()
  expect(setNativeNotifyEnabled).not.toHaveBeenCalled()
  expect(setNativeNotifyKind).not.toHaveBeenCalled()
  expect(writeProfileDefault).not.toHaveBeenCalled()
  expect(enableBrowserPush).not.toHaveBeenCalled()
})

it('reports an unconfirmed profile default after an accepted write and failed readback', async () => {
  readProfileDefault.mockResolvedValueOnce({ enabled: false, revision: 1 })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ enabled: true, revision: 2 })
  writeProfileDefault.mockResolvedValueOnce(undefined)
  renderAlerts()
  const name = 'Response ready default (default)'
  const row = await screen.findByRole('switch', { name })
  await act(async () => { fireEvent.click(row) })
  expect(notify).toHaveBeenLastCalledWith({ kind: 'error', message: 'Could not confirm the profile default after saving.' })
  expect(screen.queryByRole('switch', { name })).toBeNull()
  await act(async () => { fireEvent.focus(window) })
  expect(screen.getByRole('switch', { name }).getAttribute('aria-checked')).toBe('true')
  expect(writeProfileDefault).toHaveBeenCalledOnce()
})
