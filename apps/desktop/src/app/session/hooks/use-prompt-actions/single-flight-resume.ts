import { ambientOwnerConnectionId, type ProfileScope } from '@/api/client'
import type { SessionAttachment, SessionBindingOwner } from '@/api/session-attachment'
import { isBrowserHostedDesktop } from '@/lib/platform'
import type { SessionOwnerRoute } from '@/store/session-request-router'

/**
 * Single-flight guard for `session.resume`, keyed by backend connection + STORED id.
 *
 * After sleep/wake or a reconnect, many independent surfaces discover the same
 * dead runtime at once — submit recovery, slash/rewind recovery, tile resumes,
 * the route resolver — and each used to fire its own `session.resume` for the
 * same durable conversation. The gateway happily mints a runtime per call and
 * the losers become orphans for the reaper (#91276 storm).
 *
 * Module-level so EVERY call site in the window shares one in-flight promise
 * per stored id, no matter which hook instance it lives in. All participating
 * callers resolve to a `session.resume`-shaped response (an object carrying
 * `session_id`); joiners receive whatever the winning call returns.
 *
 * Only an exact route can share a Webapp request. Legacy callers outside
 * Webapp keep their existing collapse onto the ambient connection.
 */
type ResumeScope = ProfileScope | SessionOwnerRoute

function flightScope(scope?: ResumeScope): string[] | undefined {
  if (scope && typeof scope === 'object') {
    const connectionId = scope.connectionId?.trim()
    const profile = ('targetProfile' in scope ? scope.targetProfile?.trim() : undefined) || scope.profile?.trim()

    if (connectionId && profile) {
      return [connectionId, profile]
    }
  }

  return isBrowserHostedDesktop() ? undefined : [ambientOwnerConnectionId() || '']
}

interface SessionResumeFlight {
  includesMessages: boolean
  promise: Promise<unknown>
}

const _inFlightResumeByStoredSessionId = new Map<string, SessionResumeFlight>()

export function singleFlightSessionResume<T>(
  storedSessionId: string,
  run: () => Promise<T>,
  options?: { requiresMessages?: boolean; scope?: ResumeScope }
): Promise<T> {
  const scope = flightScope(options?.scope)

  if (!scope) {
    return Promise.resolve().then(run)
  }

  const flightKey = JSON.stringify([...scope, storedSessionId])
  const existing = _inFlightResumeByStoredSessionId.get(flightKey)

  if (existing && (!options?.requiresMessages || existing.includesMessages)) {
    return existing.promise as Promise<T>
  }

  // Promise.resolve().then(run) tolerates run() being synchronous, returning a
  // bare value, or throwing synchronously (test doubles and legacy callers do
  // all three) — a raw run().finally() would crash on a non-promise return.
  // A message-bearing caller cannot join an omitted-message flight. Queue one
  // follow-up behind it instead: this preserves same-session ordering while
  // still letting all later callers join the stronger queued snapshot.
  const ready = existing ? existing.promise.then(() => undefined, () => undefined) : Promise.resolve()

  const promise = ready
    .then(run)
    .finally(() => {
      if (_inFlightResumeByStoredSessionId.get(flightKey) === flight) {
        _inFlightResumeByStoredSessionId.delete(flightKey)
      }
    })

  const flight: SessionResumeFlight = {
    includesMessages: options?.requiresMessages === true,
    promise
  }

  _inFlightResumeByStoredSessionId.set(flightKey, flight)

  return promise
}

/**
 * Adopt-or-reuse cache for recovered runtimes a drift-abort walked away from.
 *
 * A recovery resume can succeed while the caller's drift check says the user
 * moved on (SessionRecoveryAborted). The freshly-minted runtime is REAL and
 * registered on the gateway; abandoning the id client-side strands it for the
 * orphan reaper AND makes the next action for the same stored session mint yet
 * another runtime. When adoption (rebinding the caller's runtime ref via
 * onRecovered/onRuntimeRecovered) is wrong — the user is elsewhere — record it
 * here so the next resume-shaped action reuses it instead of re-minting.
 */
const _recoveredRuntimeByStoredSessionId = new Map<string, string | SessionAttachment>()

function recoveryKey(storedSessionId: string, owner: SessionBindingOwner): string {
  return JSON.stringify([owner.connectionId, owner.profile, storedSessionId])
}

export function registerRecoveredRuntime(storedSessionId: string, runtimeId: string, attachment?: SessionAttachment): void {
  if (!storedSessionId || !runtimeId) {
    return
  }

  if (attachment?.runtimeId === runtimeId && attachment.isCurrent()) {
    _recoveredRuntimeByStoredSessionId.set(recoveryKey(storedSessionId, attachment), attachment)
  } else if (!isBrowserHostedDesktop()) {
    _recoveredRuntimeByStoredSessionId.set(storedSessionId, runtimeId)
  }
}

/** Take only an attachment that belongs to this exact route and live socket. */
export function takeRecoveredAttachment(storedSessionId: string, owner: SessionBindingOwner, deadRuntimeId?: string): SessionAttachment | undefined {
  const key = recoveryKey(storedSessionId, owner)
  const cached = _recoveredRuntimeByStoredSessionId.get(key)

  _recoveredRuntimeByStoredSessionId.delete(key)

  return typeof cached === 'object' && cached.runtimeId !== deadRuntimeId && cached.isCurrent() ? cached : undefined
}

/** Compatibility for callers that have no exact connection/profile, outside Webapp. */
export function takeRecoveredRuntime(storedSessionId: string, deadRuntimeId?: null | string): string | undefined {
  if (isBrowserHostedDesktop()) {
    return undefined
  }

  const cached = _recoveredRuntimeByStoredSessionId.get(storedSessionId)

  _recoveredRuntimeByStoredSessionId.delete(storedSessionId)

  return typeof cached === 'string' && cached !== deadRuntimeId ? cached : undefined
}

/** Test seam: reset all module-level single-flight/recovery state. */
export function clearSingleFlightSessionResumeState(): void {
  _inFlightResumeByStoredSessionId.clear()
  _recoveredRuntimeByStoredSessionId.clear()
}
