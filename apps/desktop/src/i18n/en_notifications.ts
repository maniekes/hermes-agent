// Notification settings copy used when the desktop locale loads.
export const enNotifications = {
  title: 'Notifications',
  intro: 'Manage system notifications.',
  device: 'This device',
  conversationDefaults: 'Conversation defaults',
  enableAll: 'Enable notifications',
  enableAllDesc: 'Off silences system notifications on this device.',
  webPushPolicy: {
    title: 'Response ready',
    inherit: 'Default (off)',
    inheritOn: 'Default (on)',
    on: 'On',
    off: 'Off',
    failed: 'The conversation notification setting could not be saved. Try again.'
  },
  webPushProfileDefault: {
    label: 'Response ready default ({profile})',
    description: 'Applies across devices to new and existing conversations set to Default in this profile.',
    failed: 'The profile default could not be saved.',
    unavailable: 'The profile default could not be read.'
  },
  webPushPreview: {
    label: 'Show message previews',
    description: 'Include the conversation title and part of the final reply on this device’s lock screen. Off shows a generic alert.'
  },
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
      denied: "Blocked in this browser. Allow notifications in this site’s settings.",
      insecure: 'Needs HTTPS, such as Tailscale serve. Over plain HTTP the tab title still flashes.',
      unsupported: 'This browser cannot show notifications. The tab title still flashes.'
    }
  },
  webPush: {
    title: 'Response ready when Hermes is closed',
    enable: 'Set up on this device',
    repair: 'Repair',
    setup: 'Set up Web Push for the current profile. Other notification kinds keep their existing behavior.',
    active: 'Web Push is active for this profile on this device.',
    needsRepair: 'Reconnect background notifications on this device.',
    turnDoneOff: 'Turn on Response ready below to set up background notifications.',
    retry: 'Retry status',
    unavailable: 'Could not read background notification status.',
    failed: 'Web Push settings could not be saved. Try again.',
    queued: 'Push test queued. If nothing appears, check system notification permissions and Focus/Do Not Disturb.',
    recent: 'A Push test finished recently. Wait a moment before sending another.',
    revocationPending: 'A Push send may still be in progress. Retry to confirm disabling Web Push.',
    sound: 'Web Push sound follows this device’s notification settings.'
  },
  test: 'Send test notification',
  testTitle: 'Hermes',
  testBody: 'This is a test notification.',
  testSent: 'Test sent. If nothing appears, check your OS notification permissions and Focus/Do Not Disturb.',
  testUnsupported: 'This system does not support native notifications.',
  testFailed: 'The test notification failed to send. Try again.',
  testStatus: {
    masterOff: 'Turn on notifications on this device first.',
    checking: 'Checking background notification status…',
    busy: 'Wait for the notification settings to finish updating.',
    statusFailed: 'Retry the status check before sending a test.',
    needsSetup: 'Set up background notifications on this device to send a test.',
    needsRepair: 'Repair background notifications on this device to send a test.'
  },
  muteSoundsTitle: 'Mute interface sounds',
  muteSoundsDesc:
    'Silences automatic completion, wake-word and thinking cues, haptic feedback, and OS notification sounds. Sound previews and spoken replies still play.',
  completionSoundTitle: 'Completion Sound',
  completionSoundDesc: 'Plays when an agent turn finishes. Pick a preset and preview it here.',
  completionSoundPreview: 'Preview'
}
