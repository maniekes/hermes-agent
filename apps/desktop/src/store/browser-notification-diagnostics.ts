// Temporary, opt-in Webapp diagnostics. Call sites supply only fixed codes and
// booleans, never a gateway payload, identifier, URL, or exception.
import { atom } from 'nanostores'

declare const __HERMES_WEBAPP_BUILD__: string
export const FRONTEND_BUILD_MARKER =
  typeof __HERMES_WEBAPP_BUILD__ === 'string' ? __HERMES_WEBAPP_BUILD__ : 'local-dev'

type Status = 'idle' | 'capturing' | 'stopped' | 'expired'
type TransportOutcome = 'received' | 'replay-held' | 'replay-stale' | 'delivered' | 'owner-held' | 'owner-unresolved'
type BridgeOutcome = 'missing' | 'attempted' | 'returned-true' | 'returned-false' | 'rejected'
type BrowserOutcome =
  | 'constructor-used' | 'constructor-rejected' | 'constructor-unavailable-worker-missing'
  | 'constructor-fallback' | 'constructor-shown' | 'constructor-show-failed' | 'constructor-timeout'
  | 'worker-registering' | 'worker-registered' | 'worker-register-failed'
  | 'worker-active' | 'worker-activation-failed' | 'worker-posted' | 'worker-post-failed'
  | 'worker-shown' | 'worker-show-failed' | 'worker-reply-timeout'

type Diagnostic =
  | { step: 'submission'; outcome: 'tracked' | 'already-tracked' | 'retained' | 'bound' | 'bind-not-pending'
      | 'receipt-no-match' | 'receipt-no-admission' | 'request-rejected' }
  | { step: 'transport'; outcome: TransportOutcome; replayed: boolean }
  | { step: 'gateway'; outcome: 'received' | 'duplicate' | 'route-dropped' | 'authority-dropped' | 'unscoped-not-live';
      replayed: boolean }
  | { step: 'completion'; outcome: 'handled' | 'no-session' | 'not-owned' | 'not-success'; replayed: boolean }
  | { step: 'ownership'; matchBy: 'submission' | 'admission' | 'none'; pendingBeforeConsume: boolean }
  | { step: 'notify-context'; enabled: boolean; responseReady: boolean; hidden: boolean; focused: boolean;
      matchesMain: boolean; matchesVisible: boolean }
  | { step: 'notify-filter'; outcome: 'preferences' | 'baseline' | 'foreground' | 'no-session' | 'main-session-mismatch'
      | 'throttled' | 'passed' }
  | { step: 'bridge'; outcome: BridgeOutcome }
  | { step: 'permission'; outcome: 'default' | 'denied' | 'granted' | 'insecure' | 'unsupported' | 'unknown' }
  | { step: 'browser'; outcome: BrowserOutcome }

export type NotificationDiagnosticRecorder = (event: Diagnostic) => void

interface ReportState {
  status: Status
  report: string
}

interface Capture {
  startedAt: number
  timer: ReturnType<typeof setTimeout>
  record: NotificationDiagnosticRecorder
  lines: { text: string; bytes: number }[]
  bytes: number
  dropped: number
}

const MAX_RECORDS = 128
const CAPTURE_MS = 5 * 60_000
// Reserve space for the fixed ASCII report header and line separators.
const MAX_RECORD_BYTES = 32 * 1024 - 256

export const $notificationDiagnostics = atom<ReportState>({ status: 'idle', report: '' })
let capture: Capture | undefined
let page: string | undefined

function finishCapture(status: 'stopped' | 'expired'): void {
  if (!capture) {
    return
  }

  const current = capture
  capture = undefined
  clearTimeout(current.timer)
  const header = JSON.stringify({ build: FRONTEND_BUILD_MARKER, page, status, dropped: current.dropped })
  $notificationDiagnostics.set({ status, report: [header, ...current.lines.map(line => line.text)].join('\n') })
  current.lines.length = 0
}

function expireIfDue(): void {
  // Timers can be delayed while the Android renderer is suspended.
  if (capture && Date.now() - capture.startedAt >= CAPTURE_MS) {
    finishCapture('expired')
  }
}

/** The returned recorder is tied to this capture, including across async delivery. */
export function notificationDiagnosticRecorder(): NotificationDiagnosticRecorder | undefined {
  expireIfDue()

  return capture?.record
}

export function startNotificationDiagnostics(): void {
  if (capture) {
    return
  }

  // Random for this page only, unrelated to any client, account or session ID.
  page ??= Math.random().toString(36).slice(2) || '0'
  const encoder = new TextEncoder()

  const current: Capture = {
    startedAt: Date.now(),
    timer: setTimeout(() => finishCapture('expired'), CAPTURE_MS),
    lines: [],
    bytes: 0,
    dropped: 0,
    record: event => {
      expireIfDue()

      if (capture !== current) {
        return
      }

      const text = JSON.stringify({ ms: Math.max(0, Date.now() - current.startedAt), ...event })
      const bytes = encoder.encode(text).length + 1

      if (bytes > MAX_RECORD_BYTES) {
        current.dropped++

        return
      }

      while (current.lines.length >= MAX_RECORDS || current.bytes + bytes > MAX_RECORD_BYTES) {
        current.bytes -= current.lines.shift()!.bytes
        current.dropped++
      }

      current.lines.push({ text, bytes })
      current.bytes += bytes
    }
  }

  capture = current
  $notificationDiagnostics.set({ status: 'capturing', report: '' })
}

export function stopNotificationDiagnostics(): void {
  expireIfDue()
  finishCapture('stopped')
}

export function clearNotificationDiagnostics(): void {
  if (capture) {
    clearTimeout(capture.timer)
    capture.lines.length = 0
    capture = undefined
  }

  $notificationDiagnostics.set({ status: 'idle', report: '' })
}
