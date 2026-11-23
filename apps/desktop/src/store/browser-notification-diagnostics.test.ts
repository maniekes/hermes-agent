import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  $notificationDiagnostics,
  clearNotificationDiagnostics,
  FRONTEND_BUILD_MARKER,
  notificationDiagnosticRecorder,
  startNotificationDiagnostics,
  stopNotificationDiagnostics
} from './browser-notification-diagnostics'

beforeEach(() => {
  vi.useFakeTimers()
  clearNotificationDiagnostics()
})

afterEach(() => {
  clearNotificationDiagnostics()
  vi.useRealTimers()
})

it('records only during an explicit capture and exports frontend and page identity with relative time', () => {
  expect(notificationDiagnosticRecorder()).toBeUndefined()
  expect($notificationDiagnostics.get()).toEqual({ status: 'idle', report: '' })

  startNotificationDiagnostics()
  const record = notificationDiagnosticRecorder()!
  vi.advanceTimersByTime(12)
  record({ step: 'transport', outcome: 'received', replayed: false })
  stopNotificationDiagnostics()
  record({ step: 'bridge', outcome: 'attempted' })
  const { status, report } = $notificationDiagnostics.get()
  expect(status).toBe('stopped')
  expect(report).toContain(FRONTEND_BUILD_MARKER)
  expect(report).toMatch(/"page":"[a-z0-9-]+"/)
  expect(report).toContain('"ms":12')
  expect(report).toContain('"outcome":"received"')
  expect(report).not.toContain('"outcome":"attempted"')
})

it('bounds the report, expires automatically and discards it on clear or reload', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem')
  const fetch = vi.spyOn(window, 'fetch')
  startNotificationDiagnostics()
  const record = notificationDiagnosticRecorder()!

  for (let i = 0; i < 200; i++) {
    record({ step: 'notify-context', enabled: true, responseReady: true, hidden: false, focused: true,
      matchesMain: true, matchesVisible: true })
  }

  vi.advanceTimersByTime(300_000)
  const { status, report } = $notificationDiagnostics.get()
  expect(status).toBe('expired')
  expect(report.split('\n')).toHaveLength(129)
  expect(new TextEncoder().encode(report).length).toBeLessThanOrEqual(32 * 1024)
  expect(report).toContain('"dropped":72')
  expect(notificationDiagnosticRecorder()).toBeUndefined()

  vi.resetModules()
  const reloaded = await import('./browser-notification-diagnostics')
  expect(reloaded.$notificationDiagnostics.get()).toEqual({ status: 'idle', report: '' })
  clearNotificationDiagnostics()
  expect($notificationDiagnostics.get().report).toBe('')
  expect(storage).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('does not let asynchronous work from a previous capture enter the next report', () => {
  startNotificationDiagnostics()
  const old = notificationDiagnosticRecorder()!
  clearNotificationDiagnostics()
  startNotificationDiagnostics()
  old({ step: 'bridge', outcome: 'attempted' })
  stopNotificationDiagnostics()
  expect($notificationDiagnostics.get().report).not.toContain('"step":"bridge"')
})


it('rejects events past the deadline even when background timers have not run', () => {
  startNotificationDiagnostics()
  const record = notificationDiagnosticRecorder()!
  vi.setSystemTime(Date.now() + 300_000)
  record({ step: 'bridge', outcome: 'attempted' })
  const { status, report } = $notificationDiagnostics.get()
  expect(status).toBe('expired')
  expect(report).not.toContain('"step":"bridge"')
})
