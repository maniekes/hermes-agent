import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n'
import { writeClipboardText } from '@/lib/clipboard'
import {
  $notificationDiagnostics,
  clearNotificationDiagnostics,
  FRONTEND_BUILD_MARKER,
  startNotificationDiagnostics,
  stopNotificationDiagnostics
} from '@/store/browser-notification-diagnostics'

export function NotificationDiagnostics() {
  const { t } = useI18n()
  const copy = t.settings.notifications.diagnostics
  const { status, report } = useStore($notificationDiagnostics)
  const [copyStatus, setCopyStatus] = useState<'copied' | 'copyFailed' | null>(null)

  const stopAndCopy = async () => {
    stopNotificationDiagnostics()
    const text = $notificationDiagnostics.get().report

    try {
      await writeClipboardText(text)

      if ($notificationDiagnostics.get().report === text) {
        setCopyStatus('copied')
      }
    } catch {
      if ($notificationDiagnostics.get().report === text) {
        setCopyStatus('copyFailed')
      }
    }
  }

  return (
    <section aria-label={copy.title} className="mt-4 flex flex-col gap-2 border-t border-(--ui-stroke-secondary) pt-4">
      <h3 className="font-medium">{copy.title}</h3>
      <p className="text-sm text-(--ui-text-tertiary)">{copy.intro}</p>
      <p className="text-sm text-(--ui-text-tertiary)">{copy.frontendBuild} <code>{FRONTEND_BUILD_MARKER}</code></p>
      <div className="flex flex-wrap gap-2">
        {status === 'idle' && (
          <Button onClick={startNotificationDiagnostics} size="sm" type="button" variant="outline">
            {copy.start}
          </Button>
        )}
        {status !== 'idle' && (
          <>
            <Button onClick={() => void stopAndCopy()} size="sm" type="button" variant="outline">
              {status === 'capturing' ? copy.stopAndCopy : copy.copyReport}
            </Button>
            <Button
              onClick={() => {
                clearNotificationDiagnostics()
                setCopyStatus(null)
              }}
              size="sm"
              type="button"
              variant="outline"
            >
              {copy.clear}
            </Button>
          </>
        )}
      </div>
      {status !== 'idle' && (
        <p className="text-sm text-(--ui-text-tertiary)" role="status">
          {copyStatus ? copy[copyStatus] : copy[status]}
        </p>
      )}
      {report && <Textarea aria-label={copy.report} className="min-h-24 w-full select-text font-mono" readOnly value={report} />}
    </section>
  )
}
