import { notificationDiagnosticRecorder } from '@/store/browser-notification-diagnostics'

// The submitting page alone holds these IDs. Shared storage would make
// every observer of the conversation eligible to show its own alert.
const submitted = new Map<string, string | undefined>()
const MAX_TRACKED_SUBMISSIONS = 256

export function trackBrowserNotificationTurn(submissionId: string): void {
  const record = notificationDiagnosticRecorder()

  if (submitted.has(submissionId)) {
    record?.({ step: 'submission', outcome: 'already-tracked' })

    return
  }

  submitted.set(submissionId, undefined)
  record?.({ step: 'submission', outcome: 'tracked' })

  if (submitted.size > MAX_TRACKED_SUBMISSIONS) {
    const oldest = submitted.keys().next().value

    if (oldest !== undefined) {
      submitted.delete(oldest)
    }
  }
}

export function bindBrowserNotificationAdmission(submissionId: string, admissionId: string): void {
  const record = notificationDiagnosticRecorder()

  if (submitted.has(submissionId)) {
    submitted.set(submissionId, admissionId)
    record?.({ step: 'submission', outcome: 'bound' })
  } else {
    record?.({ step: 'submission', outcome: 'bind-not-pending' })
  }
}

export function takeBrowserNotificationTurn(submissionId?: null | string, admissionId?: string): boolean {
  const record = notificationDiagnosticRecorder()

  if (submissionId) {
    record?.({ step: 'ownership', matchBy: 'submission', pendingBeforeConsume: submitted.has(submissionId) })

    return submitted.delete(submissionId)
  }

  if (admissionId) {
    for (const [id, bound] of submitted) {
      if (bound === admissionId) {
        record?.({ step: 'ownership', matchBy: 'admission', pendingBeforeConsume: true })

        return submitted.delete(id)
      }
    }
  }

  record?.({ step: 'ownership', matchBy: admissionId ? 'admission' : 'none', pendingBeforeConsume: false })

  return false
}
