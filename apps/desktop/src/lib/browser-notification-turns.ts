// The submitting page alone holds these IDs. Shared storage would make
// every observer of the conversation eligible to show its own alert.
const submitted = new Map<string, string | undefined>()
const MAX_TRACKED_SUBMISSIONS = 256

export function trackBrowserNotificationTurn(submissionId: string): void {
  if (submitted.has(submissionId)) {
    return
  }

  submitted.set(submissionId, undefined)

  if (submitted.size > MAX_TRACKED_SUBMISSIONS) {
    const oldest = submitted.keys().next().value

    if (oldest !== undefined) {
      submitted.delete(oldest)
    }
  }
}

export function bindBrowserNotificationAdmission(submissionId: string, admissionId: string): void {
  if (submitted.has(submissionId)) {
    submitted.set(submissionId, admissionId)
  }
}

export function takeBrowserNotificationTurn(submissionId?: null | string, admissionId?: string): string | null {
  if (submissionId) {
    return submitted.delete(submissionId) ? submissionId : null
  }

  if (admissionId) {
    for (const [id, bound] of submitted) {
      if (bound === admissionId) {
        submitted.delete(id)

        return id
      }
    }
  }

  return null
}
