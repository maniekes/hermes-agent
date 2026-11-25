import { useCallback, useEffect, useRef, useState } from 'react'

import { useI18n } from '@/i18n'
import { enNotifications } from '@/i18n/en_notifications'
import { readProfileDefault, type ResponseReadyProfileDefault, writeProfileDefault } from '@/lib/browser-web-push'
import { notify } from '@/store/notifications'

import { ListRow, ToggleRow } from './primitives'

interface ReadState {
  failed?: boolean
  value?: ResponseReadyProfileDefault
}

export function ResponseReadyProfileDefaultRow({ profile }: { profile: string }) {
  const { t } = useI18n()
  const notifications = t.settings.notifications
  const title = notifications.conversationDefaults ?? enNotifications.conversationDefaults
  const copy = notifications.webPushProfileDefault
  const label = copy.label.replace('{profile}', profile)
  const [state, setState] = useState<ReadState>({})
  const [busy, setBusy] = useState(false)
  const requests = useRef({ version: 0, writing: false }).current

  const read = useCallback(async (version: number) => {
    const next: ReadState = await readProfileDefault(profile).then(
      value => ({ value }), () => ({ failed: true })
    )

    if (requests.version === version) { setState(next) }

    return next
  }, [profile, requests])

  useEffect(() => {
    const refresh = () => {
      if (!requests.writing) { void read(++requests.version) }
    }

    refresh()
    window.addEventListener('focus', refresh)

    return () => {
      requests.version++
      window.removeEventListener('focus', refresh)
    }
  }, [read, requests])

  const change = async (enabled: boolean) => {
    if (!state.value || requests.writing) { return }

    requests.writing = true
    const version = ++requests.version
    setBusy(true)

    const saved = await writeProfileDefault(profile, enabled, state.value.revision).then(() => true, () => false)

    if (requests.version !== version) { return }

    const confirmed = await read(version)

    if (requests.version !== version) { return }

    requests.writing = false
    setBusy(false)

    if (!saved || confirmed.value?.enabled !== enabled) { notify({ kind: 'error', message: copy.failed }) }
  }

  if (!state.failed && !state.value) { return null }

  return (
    <section aria-label={title} className="mt-5 border-t border-(--ui-border) pt-3">
      <h3 className="mb-1 text-sm font-medium">{title}</h3>
      {state.value ? (
        <ToggleRow
          checked={state.value.enabled}
          description={copy.description}
          disabled={busy}
          label={label}
          onChange={enabled => void change(enabled)}
        />
      ) : <ListRow description={copy.unavailable} title={label} />}
    </section>
  )
}
