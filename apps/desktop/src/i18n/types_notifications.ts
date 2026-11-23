// Notification settings types used by every desktop locale.
export interface NotificationSettingsTranslations {
  title: string
  intro: string
  enableAll: string
  enableAllDesc: string
  focusedHint: string
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
    setup: string
    active: string
    preview?: string
    previewDescription?: string
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
  muteSoundsTitle: string
  muteSoundsDesc: string
  completionSoundTitle: string
  completionSoundDesc: string
  completionSoundPreview: string
}
