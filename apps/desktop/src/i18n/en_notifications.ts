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
  diagnostics: {
    title: "Notification diagnostics",
    intro: "Capture decisions in this page for up to five minutes. The report stays in memory, excludes chat content, and is cleared on reload.",
    frontendBuild: "Frontend build",
    start: "Start capture",
    stopAndCopy: "Stop and copy report",
    copyReport: "Copy report",
    clear: "Clear",
    capturing: "Capture running.",
    stopped: "Capture stopped.",
    expired: "Capture expired. The report is ready to copy.",
    copied: "Report copied.",
    copyFailed: "Clipboard unavailable. Select and copy the report below.",
    report: "Notification report"
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
