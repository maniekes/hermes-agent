// The submitting page alone holds these IDs. Shared storage would make
// every observer of the conversation eligible to show its own alert.
const submitted = new Map<string, string | undefined>()
const MAX_TRACKED_SUBMISSIONS = 256
const clickAdmissions = new Set<string>()

// Kept only in the originating document, including after the terminal frame.
function rememberClickAdmission(id?: string): void {
  if (!id || !/^[0-9a-f]{32}$/.test(id)) { return }

  clickAdmissions.add(id)

  if (clickAdmissions.size > MAX_TRACKED_SUBMISSIONS) {
    const oldest = clickAdmissions.values().next().value

    if (oldest !== undefined) { clickAdmissions.delete(oldest) }
  }
}

export function ownsBrowserPushAdmission(id: string): boolean {
  return clickAdmissions.has(id)
}

export async function findBrowserPushAdmission(proof: string): Promise<string | undefined> {
  const encoder = new TextEncoder()
  const ids = [...clickAdmissions]

  const hashes = await Promise.all(ids.map(async id => {
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(id))

    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
  }))

  return ids[hashes.indexOf(proof)]
}

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
    rememberClickAdmission(admissionId)
  }
}

export function takeBrowserNotificationTurn(submissionId?: null | string, admissionId?: string): string | null {
  if (submissionId) {
    const bound = submitted.get(submissionId)

    if (!submitted.delete(submissionId)) { return null }

    rememberClickAdmission(bound ?? admissionId)

    return submissionId
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
