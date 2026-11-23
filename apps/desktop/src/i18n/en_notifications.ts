// Notification settings copy used when the desktop locale loads.
export const enNotifications = {
  title: 'Notifications',
  intro: 'OS notifications (not in-app toasts). Per device.',
  enableAll: 'Enable notifications',
  enableAllDesc: 'Off silences every notification below.',
  focusedHint: 'Completion alerts only fire while Hermes is in the background.',
  kinds: {
    approval: {
      label: 'Approval needed',
      description: 'A command is waiting for you to approve or reject it.'
    },
    input: {
      label: 'Input needed',
      description: 'Hermes asked a question or needs a password or secret.'
    },
    turnDone: {
      label: 'Response ready',
      description: 'A turn finished while Hermes was in the background.'
    },
    turnError: {
      label: 'Turn failed',
      description: 'Background turn errors.'
    },
    backgroundDone: {
      label: 'Background task finished',
      description: 'A backgrounded terminal command completed.'
    },
    credits: {
      label: 'Credit alerts',
      description: 'Credit access is paused or restored.'
    },
    plugin: {
      label: 'Plugin notifications',
      description: 'A desktop plugin sent a notification while Hermes was in the background.'
    }
  },
  browserPermission: {
    title: 'Browser notifications',
    allow: 'Allow',
    requestFailed: 'The browser could not request notification permission. Check this site’s notification settings.',
    states: {
      default:
        'Show alerts from this browser while the tab is in the background. Until you allow it, only the tab title flashes.',
      granted: 'Allowed. Alerts show while this tab is in the background; the tab title flashes too.',
      denied: "Blocked in this browser's site settings. The tab title still flashes.",
      insecure: 'Needs HTTPS, such as Tailscale serve. Over plain HTTP the tab title still flashes.',
      unsupported: 'This browser cannot show notifications. The tab title still flashes.'
    }
  },
  webPush: {
    title: 'Response ready when Hermes is closed',
    enable: 'Set up on this device',
    repair: 'Repair',
    setup: 'Set up Web Push for the current profile. Other notification kinds keep their existing behavior.',
    active: 'Web Push is active for this profile. Hermes tries to skip the alert when you are reading the completed response.',
    unavailable: 'Web Push status is unavailable. Reload Hermes or try again.',
    failed: 'Web Push settings could not be saved. Try again.',
    queued: 'Push test queued. Check this device for the notification.',
    sound: 'Web Push sound follows this device’s notification settings.'
  },
  test: 'Send test notification',
  testTitle: 'Hermes',
  testBody: 'Notifications are working.',
  testSent: 'Test sent. If nothing appears, check your OS notification permissions and Focus/Do Not Disturb.',
  testUnsupported: 'This system does not support native notifications.',
  testFailed: 'The test notification failed to send. Reload Hermes and try again.',
  muteSoundsTitle: 'Mute interface sounds',
  muteSoundsDesc:
    'Silences automatic completion, wake-word and thinking cues, haptic feedback, and OS notification sounds. Sound previews and spoken replies still play.',
  completionSoundTitle: 'Completion Sound',
  completionSoundDesc: 'Plays when an agent turn finishes. Pick a preset and preview it here.',
  completionSoundPreview: 'Preview'
}
