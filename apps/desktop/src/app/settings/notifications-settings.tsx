import { LOCAL_CONNECTION_ID } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { enNotifications } from '@/i18n/en_notifications'
import { browserPushStatus, disableBrowserPush, enableBrowserPush, setBrowserPushPreview, testBrowserPush, type WebPushStatus } from '@/lib/browser-web-push'
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
import { $activeGatewayProfile, normalizeProfileKey } from '@/store/profile'
import { $connection } from '@/store/session'

import { CONTROL_TEXT } from './constants'
import { ListRow, SectionHeading, SettingsContent, ToggleRow } from './primitives'
import { ResponseReadyProfileDefaultRow } from './response-ready-profile-default'
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
  const activeProfile = useStore($activeGatewayProfile)
  const defaultProfile = normalizeProfileKey(profile ?? activeProfile)
  const pushScope = localBrowser ? profile ?? '' : null
  const [pushState, setPushState] = useState<{ scope: null | string; status?: WebPushStatus; failed?: boolean }>({ scope: null })
  const [pushBusy, setPushBusy] = useState(false)
  const pushReads = useRef({ version: 0 })
  const pushStatus = pushState.scope === pushScope ? pushState.status : undefined
  const pushError = pushState.scope === pushScope && pushState.failed
  const showAlerts = subpage === undefined || subpage === 'alerts'
  const showSounds = subpage === undefined || subpage === 'sounds'

  useSettingDeepLink('notifications', page => subpage === undefined || page === subpage)

  // eslint-disable-next-line no-restricted-syntax -- This effect owns a request token for the mounted profile.
  useEffect(() => {
    if (!showAlerts || !localBrowser) {
      return
    }

    let current = true
    const reads = { version: 0 }
    pushReads.current = reads

    const refresh = () => {
      const version = ++reads.version

      void browserPushStatus(profile).then(
        status => { if (current && version === reads.version) { setPushState({ scope: pushScope, status }) } },
        () => { if (current && version === reads.version) { setPushState({ failed: true, scope: pushScope }) } }
      )
    }

    refresh()
    window.addEventListener('focus', refresh)

    return () => {
      current = false
      window.removeEventListener('focus', refresh)
    }
  }, [localBrowser, profile, pushScope, showAlerts])

  const changeResponsePreference = async (on: boolean, master: boolean) => {
    if (!on && (localBrowser || (master && browser))) {
      const reads = pushReads.current
      reads.version++
      setPushBusy(true)

      try {
        await disableBrowserPush(master ? null : profile, master)
        const status = localBrowser && !pushStatus ? await browserPushStatus(profile).catch(() => undefined) : undefined

        if (reads === pushReads.current) {
          setPushState(previous => {
            const current = (previous.scope === pushScope ? previous.status : undefined) ?? status

            return current ? { scope: pushScope, status: { ...current, active: false, needsRepair: false } } : previous
          })
        }
      } catch (error) {
        const methodMissing = error instanceof Error && /^(404|405):/.test(error.message)

        const unsupported = methodMissing &&
          (pushStatus ?? await browserPushStatus(master ? null : profile).catch(() => undefined))?.legacyBackend === true

        if (!unsupported) {
          const pending = error instanceof Error && (error.message.startsWith('503:') || error.name === 'AbortError')

          if (pending && reads === pushReads.current) {
            setPushState({ failed: true, scope: pushScope })
          }

          notify({ kind: 'error', message: pending ? pushCopy.revocationPending : pushCopy.failed })

          return
        }
      } finally {
        // A focus read can start while the server is still processing the opt-out.
        reads.version++
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
    const reads = pushReads.current
    reads.version++
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
      const enrolled = await browserPushStatus(profile)

      if (reads === pushReads.current) {
        setPushState({ scope: pushScope, status: enrolled })
      }
    } catch {
      notify({ kind: 'error', message: pushCopy.failed })
    } finally {
      reads.version++
      setPushBusy(false)
    }
  }

  const changePreview = async (preview: boolean) => {
    const reads = pushReads.current
    reads.version++
    setPushBusy(true)

    try {
      const confirmed = await setBrowserPushPreview(profile, preview)

      if (reads === pushReads.current) {
        setPushState(previous => previous.scope === pushScope && previous.status?.active
          ? { scope: pushScope, status: { ...previous.status, preview: confirmed } }
          : previous)
      }
    } catch {
      notify({ kind: 'error', message: pushCopy.failed })
    } finally {
      reads.version++
      setPushBusy(false)
    }
  }

  const runTest = async () => {
    triggerHaptic('open')

    if (localBrowser) {
      const reads = pushReads.current

      try {
        const status = pushStatus ?? await browserPushStatus(profile)

        if (status.available) {
          if (!status.active || status.needsRepair) {
            throw new Error('Web Push test unavailable')
          }

          const result = await testBrowserPush(profile)

          if (result === 'inactive') {
            throw new Error('Web Push subscription inactive')
          }

          notify({ kind: 'info', message: result === 'recent' ? pushCopy.recent : pushCopy.queued })

          return
        }
      } catch {
        if (reads !== pushReads.current) {
          return
        }

        const version = ++reads.version
        const status = await browserPushStatus(profile).catch(() => undefined)

        if (reads === pushReads.current && version === reads.version) {
          setPushState({ failed: !status, scope: pushScope, status })
        }

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

          {localBrowser && <ResponseReadyProfileDefaultRow key={defaultProfile} profile={defaultProfile} />}

          {localBrowser && (pushStatus?.available || pushError) && (
            <ListRow
              action={(!pushStatus?.active || pushStatus.needsRepair) && (
                <Button disabled={pushBusy || !prefs.enabled ||
                    (!pushStatus?.conversationPolicy && !prefs.kinds.turnDone && !pushStatus?.active)}
                  onClick={() => void setupPush()} size="sm" type="button" variant="outline">
                  {pushStatus?.needsRepair || pushError ? pushCopy.repair : pushCopy.enable}
                </Button>
              )}
              description={pushError ? pushCopy.unavailable :
                pushStatus?.active && !pushStatus.needsRepair ? pushCopy.active : pushCopy.setup}
              title={pushCopy.title}
            />
          )}

          {pushStatus?.active && typeof pushStatus.preview === 'boolean' && (
            <ToggleRow
              checked={pushStatus.preview}
              description={copy.webPushPreview.description}
              disabled={pushBusy}
              label={copy.webPushPreview.label}
              onChange={preview => void changePreview(preview)}
            />
          )}

          {NATIVE_NOTIFICATION_KINDS.filter(kind => kind !== 'turnDone' || !pushStatus?.conversationPolicy).map(kind => (
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
          <Caption>{pushStatus?.active && !pushStatus.needsRepair ? pushCopy.active : copy.focusedHint}</Caption>
        </div>
      )}
    </SettingsContent>
  )
}
