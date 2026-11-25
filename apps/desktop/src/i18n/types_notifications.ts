// Notification settings types used by every desktop locale.
export interface NotificationSettingsTranslations {
  title: string
  intro: string
  device?: string
  conversationDefaults?: string
  enableAll: string
  enableAllDesc: string
  focusedHint: string
  webPushPreview: { label: string; description: string }
  webPushProfileDefault: { label: string; description: string; failed: string; unavailable: string }
  webPushPolicy: { title: string; inherit: string; inheritOn: string; on: string; off: string; failed: string }
  kinds: Record<
    'approval' | 'backgroundDone' | 'credits' | 'input' | 'plugin' | 'turnDone' | 'turnError',
    { label: string; description: string }
  >
  browserPermission: {
    title: string
    allow: string
    requestFailed: string
    states: Record<'default' | 'denied' | 'granted' | 'insecure' | 'unsupported', string>
  }
  webPush?: {
    title: string
    enable: string
    repair: string
    needsRepair?: string
    turnDoneOff?: string
    retry?: string
    setup: string
    active: string
    unavailable: string
    failed: string
    queued: string
    recent: string
    revocationPending: string
    sound: string
  }
  test: string
  testTitle: string
  testBody: string
  testSent: string
  testUnsupported: string
  testFailed: string
  testStatus?: {
    masterOff: string
    checking: string
    busy: string
    statusFailed: string
    needsSetup: string
    needsRepair: string
  }
  muteSoundsTitle: string
  muteSoundsDesc: string
  completionSoundTitle: string
  completionSoundDesc: string
  completionSoundPreview: string
}
