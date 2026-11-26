import { LOCAL_CONNECTION_ID } from '@hermes/shared'
import { useStore } from '@nanostores/react'
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'

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

function Caption({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return <p className={cn(CAPTION, className)} id={id}>{children}</p>
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

interface PushReadState {
  failed?: boolean
  retryResult?: boolean
  setupUnconfirmed?: boolean
  status?: WebPushStatus
}

interface NotificationsSettingsProps {
  subpage?: string
}

export function NotificationsSettings({ subpage }: NotificationsSettingsProps = {}) {
  const browser = hostHas('browserNotifications')
  const connection = useStore($connection)
  const localBrowser = browser && (!connection?.connectionId || connection.connectionId === LOCAL_CONNECTION_ID)
  const profile = connection?.profile ?? null
  const showAlerts = subpage === undefined || subpage === 'alerts'

  // A returning profile starts a fresh read even if the intervening profile never finished loading.
  const scope = localBrowser && showAlerts ? `push:${profile ?? ''}` : 'fallback'

  return <ScopedNotificationsSettings browser={browser} key={scope} localBrowser={localBrowser} profile={profile} subpage={subpage} />
}

function ScopedNotificationsSettings({ browser, localBrowser, profile, subpage }: NotificationsSettingsProps & {
  browser: boolean
  localBrowser: boolean
  profile: null | string
}) {
  const { t } = useI18n()
  const prefs = useStore($nativeNotifyPrefs)
  const muted = useStore($hapticsMuted)
  const completionSoundVariantId = useStore($completionSoundVariantId)
  const copy = t.settings.notifications
  const pushCopy = { ...enNotifications.webPush, ...copy.webPush }
  const testCopy = copy.testStatus ?? enNotifications.testStatus
  const deviceTitle = copy.device ?? enNotifications.device
  const testHintId = useId()
  const activeProfile = useStore($activeGatewayProfile)
  const defaultProfile = normalizeProfileKey(profile ?? activeProfile)
  const [pushState, setPushState] = useState<PushReadState>({})
  const [pushBusy, setPushBusy] = useState(false)
  const pushReads = useRef({ version: 0, writing: false })
  const pushStatusText = useRef<HTMLSpanElement>(null)
  const { status: pushStatus, failed: pushError, setupUnconfirmed } = pushState
  const showStatusRetry = pushError || setupUnconfirmed

  const handoffRetryFocus = useCallback((button: HTMLButtonElement | null) => {
    if (!button) { return }

    // The retry node can be removed by any status source, even while its own read is pending.
    return () => {
      if (button.ownerDocument.activeElement === button) { pushStatusText.current?.focus() }
    }
  }, [])

  const testPushBlocker = (status: WebPushStatus) => {
    if (!status.available) { return undefined }

    if (status.needsRepair) { return testCopy.needsRepair }

    return status.active ? undefined : testCopy.needsSetup
  }

  let testBlocker: string | undefined

  if (!prefs.enabled) {
    testBlocker = testCopy.masterOff
  } else if (pushBusy) {
    testBlocker = testCopy.busy
  } else if (localBrowser) {
    testBlocker = showStatusRetry ? testCopy.statusFailed : pushStatus ? testPushBlocker(pushStatus) : testCopy.checking
  }

  const setupBlockedByKind = !pushStatus?.conversationPolicy && !prefs.kinds.turnDone && !pushStatus?.active
  let pushDescription = pushCopy.unsupported

  if (pushError) {
    pushDescription = pushCopy.unavailable
  } else if (setupUnconfirmed) {
    pushDescription = pushCopy.setupUnconfirmed
  } else if (pushStatus?.available) {
    if (!prefs.enabled) {
      pushDescription = testCopy.masterOff
    } else if (setupBlockedByKind) {
      pushDescription = pushCopy.turnDoneOff
    } else if (pushStatus.needsRepair) {
      pushDescription = pushCopy.needsRepair
    } else {
      pushDescription = pushStatus.active ? pushCopy.active : pushCopy.setup
    }
  }

  const showAlerts = subpage === undefined || subpage === 'alerts'
  const showSounds = subpage === undefined || subpage === 'sounds'

  useSettingDeepLink('notifications', page => subpage === undefined || page === subpage)

  const refreshPushStatus = useCallback(async (reason: 'refresh' | 'retry' | 'setup' | 'preview' = 'refresh') => {
    const reads = pushReads.current
    const version = ++reads.version
    const observeOnly = reason === 'retry' || reason === 'preview'
    const response = observeOnly ? browserPushStatus(profile, { observeOnly }) : browserPushStatus(profile)

    const next = await response.then<PushReadState, PushReadState>(
      status => ({ status }),
      () => ({ failed: true })
    )

    if (reads !== pushReads.current || version !== reads.version) { return undefined }

    setPushState(previous => {
      const confirmed = next.status?.active && !next.status.needsRepair

      // A passive refresh may confirm activation. Otherwise let the user check explicitly before offering another write.
      const setupUnconfirmed = reason === 'setup'
        ? !confirmed
        : previous.setupUnconfirmed && !confirmed && (reason !== 'retry' || next.failed)

      // Keep the live region mounted when a retry row resolves to an unavailable status.
      const retryResult = reason === 'retry' || (next.status?.available === false &&
        (previous.retryResult || previous.failed || previous.setupUnconfirmed))

      return { ...next, setupUnconfirmed, retryResult }
    })

    return next
  }, [profile])

  // eslint-disable-next-line no-restricted-syntax -- This effect owns a request token for the mounted profile.
  useEffect(() => {
    if (!showAlerts || !localBrowser) {
      return
    }

    const refresh = () => {
      if (!pushReads.current.writing) { void refreshPushStatus() }
    }

    refresh()
    window.addEventListener('focus', refresh)

    return () => {
      pushReads.current = { version: 0, writing: false }
      window.removeEventListener('focus', refresh)
    }
  }, [localBrowser, refreshPushStatus, showAlerts])

  const changeResponsePreference = async (on: boolean, master: boolean) => {
    if (!on && (localBrowser || (master && browser))) {
      const reads = pushReads.current
      reads.version++
      reads.writing = true
      setPushBusy(true)

      try {
        await disableBrowserPush(master ? null : profile, master)
        const status = localBrowser && !pushStatus ? await browserPushStatus(profile).catch(() => undefined) : undefined

        if (reads === pushReads.current) {
          setPushState(previous => {
            const current = previous.status ?? status

            return current ? {
              ...previous,
              failed: false,
              retryResult: previous.retryResult || previous.failed,
              status: { ...current, active: false, needsRepair: false }
            } : previous
          })
        }
      } catch (error) {
        const methodMissing = error instanceof Error && /^(404|405):/.test(error.message)

        const unsupported = methodMissing &&
          (pushStatus ?? await browserPushStatus(master ? null : profile).catch(() => undefined))?.legacyBackend === true

        if (!unsupported) {
          const pending = error instanceof Error && (error.message.startsWith('503:') || error.name === 'AbortError')

          if (pending && reads === pushReads.current) {
            setPushState({ failed: true })
          }

          notify({ kind: 'error', message: pending ? pushCopy.revocationPending : pushCopy.failed })

          return
        }
      } finally {
        reads.version++
        reads.writing = false
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
    reads.writing = true
    setPushBusy(true)

    try {
      const permission = await askPermissionFromSettings(copy.browserPermission.requestFailed)

      if (permission !== 'granted') {
        if (permission) { notify({ kind: 'error', message: copy.browserPermission.states[permission] }) }

        return
      }

      const status = pushStatus ?? await browserPushStatus(profile)

      if (!status.available || !status.publicKey) {
        throw new Error('Web Push unavailable')
      }

      const enrollment = await enableBrowserPush(profile, status.publicKey)

      if (reads !== pushReads.current) { return }

      if (enrollment === 'unconfirmed') {
        setPushState(previous => ({ ...previous, setupUnconfirmed: true }))
        notify({ kind: 'error', message: pushCopy.setupUnconfirmed })

        return
      }

      const enrolled = await refreshPushStatus('setup')

      if (enrolled && (!enrolled.status?.active || enrolled.status.needsRepair)) {
        notify({ kind: 'error', message: pushCopy.setupUnconfirmed })
      }
    } catch {
      if (reads === pushReads.current) { notify({ kind: 'error', message: pushCopy.failed }) }
    } finally {
      reads.version++
      reads.writing = false
      setPushBusy(false)
    }
  }

  const changePreview = async (preview: boolean) => {
    const reads = pushReads.current
    reads.version++
    reads.writing = true
    setPushBusy(true)

    try {
      const confirmed = await setBrowserPushPreview(profile, preview)

      if (reads === pushReads.current) {
        setPushState(previous => previous.status?.active
          ? { status: { ...previous.status, preview: confirmed } }
          : previous)
      }
    } catch {
      if (reads !== pushReads.current) { return }

      setPushState(previous => previous.status
        ? { status: { ...previous.status, preview: undefined } }
        : previous)
      notify({ kind: 'error', message: pushCopy.previewUnconfirmed })
      await refreshPushStatus('preview')
    } finally {
      reads.version++
      reads.writing = false
      setPushBusy(false)
    }
  }

  const runTest = async () => {
    if (testBlocker) { return }

    triggerHaptic('open')

    if (localBrowser && pushStatus?.available) {
      const reads = pushReads.current

      try {
        const result = await testBrowserPush(profile)

        if (reads !== pushReads.current) { return }

        if (result === 'inactive') {
          throw new Error('Web Push subscription inactive')
        }

        notify({ kind: 'info', message: result === 'recent' ? pushCopy.recent : pushCopy.queued })
      } catch {
        if (reads !== pushReads.current) { return }

        const next = await refreshPushStatus()

        if (next) {
          notify({
            kind: 'error',
            message: next.status ? testPushBlocker(next.status) ?? copy.testFailed : testCopy.statusFailed
          })
        }
      }

      return
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

          <section aria-label={deviceTitle}>
            <h3 className="mb-1 pt-2 text-sm font-medium">{deviceTitle}</h3>
            <ToggleRow
              checked={prefs.enabled}
              description={copy.enableAllDesc}
              disabled={pushBusy}
              id={settingElementId(SETTING_IDS.notifications.enableAll)}
              label={copy.enableAll}
              onChange={on => void changeResponsePreference(on, true)}
            />

            {browser && <BrowserPermissionRow />}

            {localBrowser && (showStatusRetry || pushStatus?.available || pushState.retryResult) && (
              <ListRow
                action={showStatusRetry ? (
                  <Button
                    disabled={pushBusy}
                    key="retry"
                    onClick={() => void refreshPushStatus('retry')}
                    ref={handoffRetryFocus}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {pushCopy.retry}
                  </Button>
                ) : pushStatus?.available && (!pushStatus.active || pushStatus.needsRepair) && (
                  <Button disabled={pushBusy || !prefs.enabled || setupBlockedByKind} key="setup"
                    onClick={() => void setupPush()} size="sm" type="button" variant="outline">
                    {pushStatus.needsRepair ? pushCopy.repair : pushCopy.enable}
                  </Button>
                )}
                description={
                  <span ref={pushStatusText} role="status" tabIndex={-1}>
                    {pushDescription}
                  </span>
                }
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

            <div className="mt-4 flex flex-col gap-2">
              <Button aria-describedby={testBlocker || !pushStatus?.active ? testHintId : undefined} className="self-start" disabled={Boolean(testBlocker)}
                onClick={() => void runTest()} size="sm" type="button" variant="outline">
                <Bell />
                {copy.test}
              </Button>
              {(testBlocker || !pushStatus?.active) && <Caption id={testHintId}>{testBlocker ?? copy.focusedHint}</Caption>}
            </div>
          </section>

          {localBrowser && <ResponseReadyProfileDefaultRow key={defaultProfile} profile={defaultProfile} />}
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
    </SettingsContent>
  )
}
