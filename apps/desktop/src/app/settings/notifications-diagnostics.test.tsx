import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { writeClipboardText } from '@/lib/clipboard'
import {
  clearNotificationDiagnostics,
  FRONTEND_BUILD_MARKER,
  notificationDiagnosticRecorder
} from '@/store/browser-notification-diagnostics'

import { NotificationDiagnostics } from './notification-diagnostics'

vi.mock('@/lib/clipboard', () => ({ writeClipboardText: vi.fn() }))

afterEach(() => {
  cleanup()
  clearNotificationDiagnostics()
  vi.resetAllMocks()
})

it('offers an explicit capture that survives unmount and a selectable report when copy fails', async () => {
  vi.mocked(writeClipboardText).mockRejectedValueOnce(new Error('Clipboard unavailable'))
  const settings = render(<NotificationDiagnostics />)
  expect(screen.getByText(FRONTEND_BUILD_MARKER)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Start capture' }))
  settings.unmount()
  notificationDiagnosticRecorder()?.({ step: 'bridge', outcome: 'returned-false' })
  render(<NotificationDiagnostics />)
  fireEvent.click(screen.getByRole('button', { name: 'Stop and copy report' }))

  const report = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'Notification report' })
  expect(report.readOnly).toBe(true)
  expect(report.value).toContain('"outcome":"returned-false"')
  expect(writeClipboardText).toHaveBeenCalledWith(report.value)
  expect(await screen.findByText(/select and copy/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }))
  expect(screen.queryByRole('textbox', { name: 'Notification report' })).toBeNull()
})
