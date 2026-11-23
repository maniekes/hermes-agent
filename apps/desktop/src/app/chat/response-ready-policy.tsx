import { LOCAL_CONNECTION_ID, randomUuid } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { hostHas } from '@/lib/host-capabilities'
import { activeGateway } from '@/store/gateway'
import { notify } from '@/store/notifications'
import { $connection, getSessionOwnerHint } from '@/store/session'
import { ambientRequestFor } from '@/store/session-gone-latch'
import { requestForOwnedSession } from '@/store/session-states'

const modes = ['inherit', 'on', 'off'] as const
type Mode = typeof modes[number]

interface Policy {
  effective: 'off' | 'on'
  mode: Mode
  revision: number
}

function policyFrom(response: unknown): Policy | undefined {
  const policy = (response as { response_ready_policy?: Policy } | undefined)?.response_ready_policy

  return policy && modes.includes(policy.mode) && Number.isSafeInteger(policy.revision) &&
    policy.effective === (policy.mode === 'on' ? 'on' : 'off') ? policy : undefined
}

type RequestPolicy = (method: string, params: Record<string, unknown>) => Promise<unknown>

export function ResponseReadyPolicyPicker({ request, sessionId }: { request: RequestPolicy; sessionId: string }) {
  const { t } = useI18n()
  const copy = t.settings.notifications.webPushPolicy
  const [policy, setPolicy] = useState<Policy>()
  const [busy, setBusy] = useState(false)
  const requestVersion = useRef({ id: 0 }).current
  const mutating = useRef(false)

  const read = useCallback(async () => policyFrom(await request('session.info', { session_id: sessionId })),
    [request, sessionId])

  const refresh = useCallback(() => {
    if (mutating.current) { return }

    const id = ++requestVersion.id
    void read().then(next => {
      if (id === requestVersion.id) { setPolicy(next) }
    }).catch(() => {})
  }, [read, requestVersion])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)

    return () => {
      requestVersion.id++
      window.removeEventListener('focus', refresh)
    }
  }, [refresh, requestVersion])

  const change = async (mode: Mode) => {
    if (!policy || mutating.current) { return }

    mutating.current = true
    const id = ++requestVersion.id
    setBusy(true)

    try {
      await request('session.mutate', {
        expected_revision: policy.revision,
        operation: 'response_ready',
        payload: { mode },
        request_id: randomUuid(),
        session_id: sessionId
      })
      const confirmed = await read()

      if (!confirmed || confirmed.mode !== mode) { throw new Error(copy.failed) }

      if (id === requestVersion.id) { setPolicy(confirmed) }
    } catch {
      if (id === requestVersion.id) { notify({ kind: 'error', message: copy.failed }) }
    } finally {
      mutating.current = false
      setBusy(false)
    }
  }

  if (!policy) { return null }

  return (
    <select aria-label={copy.title}
      className="pointer-events-auto ml-2 max-w-36 truncate rounded border border-(--ui-border) bg-(--ui-surface) px-1 text-xs"
      disabled={busy} onChange={event => void change(event.target.value as Mode)}
      onFocus={refresh} title={copy.title} value={policy.mode}>
      {modes.map(mode => <option key={mode} value={mode}>{copy[mode]}</option>)}
    </select>
  )
}

export function ConversationResponseReadyPolicy({ sessionId }: { sessionId: string }) {
  const connection = useStore($connection)

  const request = useCallback<RequestPolicy>((method, params) => {
    const gateway = activeGateway()

    if (!gateway) { return Promise.reject(new Error('Gateway unavailable')) }

    return requestForOwnedSession(sessionId, ambientRequestFor(gateway), method, params)
  }, [sessionId])

  const owner = getSessionOwnerHint(sessionId)

  if (!hostHas('browserNotifications') ||
      (connection?.connectionId && connection.connectionId !== LOCAL_CONNECTION_ID) ||
      (owner?.connectionId && owner.connectionId !== LOCAL_CONNECTION_ID)) {
    return null
  }

  return <ResponseReadyPolicyPicker key={sessionId} request={request} sessionId={sessionId} />
}
