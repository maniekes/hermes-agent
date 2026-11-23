import { LOCAL_CONNECTION_ID } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { enNotifications } from '@/i18n/en_notifications'
import { browserPushStatus, disableBrowserPush, enableBrowserPush, testBrowserPush, type WebPushStatus } from '@/lib/browser-web-push'
import { COMPLETION_SOUND_VARIANTS, previewCompletionSound } from '@/lib/completion-sound'
import { triggerHaptic } from '@/lib/haptics'
import { hostHas } from '@/lib/host-capabilities'
import { Bell, Play } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  $browserNotificationPermission,
  askBrowserNotificationPermission,
  refreshBrowserNotificationPermission
} from '@/store/browser-notification-permission'
import { $completionSoundVariantId, setCompletionSoundVariantId } from '@/store/completion-sound'
import { $hapticsMuted, setHapticsMuted } from '@/store/haptics'
import {
  $nativeNotifyPrefs,
  NATIVE_NOTIFICATION_KINDS,
  sendTestNativeNotification,
  setNativeNotifyEnabled,
  setNativeNotifyKind
} from '@/store/native-notifications'
import { notify } from '@/store/notifications'
import { $connection } from '@/store/session'

import { CONTROL_TEXT } from './constants'
import { ListRow, SectionHeading, SettingsContent, ToggleRow } from './primitives'
import { notificationKindSettingId, SETTING_IDS, settingElementId } from './settings-manifest'
import { useSettingDeepLink } from './use-setting-deep-link'

const CAPTION = 'text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)'

function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn(CAPTION, className)}>{children}</p>
}

async function askPermissionFromSettings(failureMessage: string) {
  try {
    return await askBrowserNotificationPermission()
  } catch {
    refreshBrowserNotificationPermission()
    notify({ kind: 'error', message: failureMessage })

    return null
  }
}

/** Webapp only: the browser's notification permission, asked from a click here
 *  or on Send test notification, never on page load. */
function BrowserPermissionRow() {
  const { t } = useI18n()
  const copy = t.settings.notifications.browserPermission
  const permission = useStore($browserNotificationPermission)

  useEffect(refreshBrowserNotificationPermission, [])

  return (
    <ListRow
      action={
        permission === 'default' ? (
          <Button
            onClick={() => void askPermissionFromSettings(copy.requestFailed)}
            size="sm"
            type="button"
            variant="outline"
          >
            {copy.allow}
          </Button>
        ) : undefined
      }
      description={copy.states[permission]}
      id={settingElementId(SETTING_IDS.notifications.browserPermission)}
      title={copy.title}
    />
  )
}

interface NotificationsSettingsProps {
  subpage?: string
}

export function NotificationsSettings({ subpage }: NotificationsSettingsProps = {}) {
  const { t } = useI18n()
  const prefs = useStore($nativeNotifyPrefs)
  const muted = useStore($hapticsMuted)
  const completionSoundVariantId = useStore($completionSoundVariantId)
  const copy = t.settings.notifications
  const pushCopy = copy.webPush ?? enNotifications.webPush
  const browser = hostHas('browserNotifications')
  const connection = useStore($connection)
  const localBrowser = browser && (!connection?.connectionId || connection.connectionId === LOCAL_CONNECTION_ID)
  const profile = connection?.profile ?? null
  const pushScope = localBrowser ? profile ?? '' : null
  const [pushState, setPushState] = useState<{ scope: null | string; status?: WebPushStatus; failed?: boolean }>({ scope: null })
  const [pushBusy, setPushBusy] = useState(false)
  const pushStatus = pushState.scope === pushScope ? pushState.status : undefined
  const pushError = pushState.scope === pushScope && pushState.failed
  const showAlerts = subpage === undefined || subpage === 'alerts'
  const showSounds = subpage === undefined || subpage === 'sounds'

  useSettingDeepLink('notifications', page => subpage === undefined || page === subpage)

  useEffect(() => {
    if (!showAlerts || !localBrowser) {
      return
    }

    let current = true
    void browserPushStatus(profile).then(
      status => { if (current) { setPushState({ scope: pushScope, status }) } },
      () => { if (current) { setPushState({ failed: true, scope: pushScope }) } }
    )

    return () => { current = false }
  }, [localBrowser, profile, pushScope, showAlerts])

  const changeResponsePreference = async (on: boolean, master: boolean) => {
    if (!on && (localBrowser || (master && browser))) {
      setPushBusy(true)

      try {
        await disableBrowserPush(master ? null : profile, master)

        if (pushStatus) {
          setPushState({ scope: pushScope, status: { ...pushStatus, active: false, needsRepair: false } })
        }
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith('404:') && !pushStatus?.available)) {
          notify({ kind: 'error', message: pushCopy.failed })

          return
        }
      } finally {
        setPushBusy(false)
      }
    }

    if (master) {
      setNativeNotifyEnabled(on)
    } else {
      setNativeNotifyKind('turnDone', on)
    }
  }

  const setupPush = async () => {
    setPushBusy(true)

    try {
      const permission = await askPermissionFromSettings(copy.browserPermission.requestFailed)

      if (permission !== 'granted') {
        return
      }

      const status = pushStatus ?? await browserPushStatus(profile)

      if (!status.available || !status.publicKey) {
        throw new Error('Web Push unavailable')
      }

      await enableBrowserPush(profile, status.publicKey)
      setPushState({ scope: pushScope, status: await browserPushStatus(profile) })
    } catch {
      notify({ kind: 'error', message: pushCopy.failed })
    } finally {
      setPushBusy(false)
    }
  }

  const runTest = async () => {
    triggerHaptic('open')

    if (localBrowser) {
      try {
        const status = pushStatus ?? await browserPushStatus(profile)

        if (status.available) {
          if (!status.active || status.needsRepair || !await testBrowserPush(profile)) {
            throw new Error('Web Push test unavailable')
          }

          notify({ kind: 'info', message: pushCopy.queued })

          return
        }
      } catch {
        notify({ kind: 'error', message: copy.testFailed })

        return
      }
    }

    if (browser) {
      const permission = await askPermissionFromSettings(copy.browserPermission.requestFailed)

      if (!permission) {
        return
      }

      if (permission !== 'granted') {
        notify({ kind: 'error', message: copy.browserPermission.states[permission] })

        return
      }
    }

    try {
      if (await sendTestNativeNotification(copy.testTitle, copy.testBody)) {
        notify({ kind: 'info', message: copy.testSent })

        return
      }
    } catch {
      // Recheck site permission below in case it changed during delivery.
      if (!browser) {
        notify({ kind: 'error', message: copy.testFailed })

        return
      }
    }

    if (!browser) {
      notify({ kind: 'error', message: copy.testUnsupported })

      return
    }

    refreshBrowserNotificationPermission()
    const permission = $browserNotificationPermission.get()
    notify({
      kind: 'error',
      message: permission === 'granted' ? copy.testFailed : copy.browserPermission.states[permission]
    })
  }

  return (
    <SettingsContent>
      {showAlerts && (
        <>
          {subpage === undefined && <SectionHeading icon={Bell} title={copy.title} />}
          <Caption className="mb-2 leading-(--conversation-caption-line-height)">{copy.intro}</Caption>

          <ToggleRow
            checked={prefs.enabled}
            description={copy.enableAllDesc}
            disabled={pushBusy}
            id={settingElementId(SETTING_IDS.notifications.enableAll)}
            label={copy.enableAll}
            onChange={on => void changeResponsePreference(on, true)}
          />

          {browser && <BrowserPermissionRow />}

          {localBrowser && (pushStatus?.available || pushError) && (
            <ListRow
              action={(!pushStatus?.active || pushStatus.needsRepair) && (
                <Button disabled={pushBusy || !prefs.enabled || (!prefs.kinds.turnDone && !pushStatus?.active)}
                  onClick={() => void setupPush()} size="sm" type="button" variant="outline">
                  {pushStatus?.active || pushError ? pushCopy.repair : pushCopy.enable}
                </Button>
              )}
              description={pushError ? pushCopy.unavailable :
                pushStatus?.active && !pushStatus.needsRepair ? pushCopy.active : pushCopy.setup}
              title={pushCopy.title}
            />
          )}

          {NATIVE_NOTIFICATION_KINDS.map(kind => (
            <ToggleRow
              checked={prefs.enabled && (prefs.kinds[kind] || (kind === 'turnDone' && pushStatus?.active === true))}
              description={copy.kinds[kind].description}
              disabled={!prefs.enabled || (kind === 'turnDone' && pushBusy)}
              id={settingElementId(notificationKindSettingId(kind))}
              key={kind}
              label={copy.kinds[kind].label}
              onChange={on => {
                if (kind === 'turnDone') {
                  void changeResponsePreference(on, false)
                } else {
                  setNativeNotifyKind(kind, on)
                }
              }}
            />
          ))}
        </>
      )}

      {showSounds && (
        <>
          <ToggleRow
            checked={muted}
            description={browser ? `${copy.muteSoundsDesc} ${pushCopy.sound}` : copy.muteSoundsDesc}
            id={settingElementId(SETTING_IDS.notifications.muteSounds)}
            label={copy.muteSoundsTitle}
            onChange={setHapticsMuted}
          />
          <ListRow
            action={
              <>
                <Select
                  onValueChange={value => {
                    const variantId = Number.parseInt(value, 10)

                    setCompletionSoundVariantId(variantId)
                    previewCompletionSound(variantId)
                    triggerHaptic('selection')
                  }}
                  value={String(completionSoundVariantId)}
                >
                  <SelectTrigger className={cn('min-w-56', CONTROL_TEXT)}>
                    <SelectValue />
                  </SelectTrigger>

                  <SelectContent>
                    {COMPLETION_SOUND_VARIANTS.map(variant => (
                      <SelectItem key={variant.id} value={String(variant.id)}>
                        {variant.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  className="gap-1.5"
                  onClick={() => {
                    previewCompletionSound()
                    triggerHaptic('crisp')
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Play className="size-3.5" />
                  {copy.completionSoundPreview}
                </Button>
              </>
            }
            description={copy.completionSoundDesc}
            id={settingElementId(SETTING_IDS.notifications.completionSound)}
            title={copy.completionSoundTitle}
          />
        </>
      )}

      {showAlerts && (
        <div className="mt-4 flex flex-col gap-2">
          <Button className="self-start" onClick={() => void runTest()} size="sm" type="button" variant="outline">
            <Bell />
            {copy.test}
          </Button>
          <Caption>{pushStatus?.active ? pushCopy.active : copy.focusedHint}</Caption>
        </div>
      )}
    </SettingsContent>
  )
}
