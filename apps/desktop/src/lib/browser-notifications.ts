/**
 * Browser half of hermesDesktop.notify. Ask permission only from Settings.
 * The tab title can still flash when the OS notification is unavailable.
 */

import { flagTabAttention } from '@/store/browser-tab-attention'

export type BrowserNotificationPermission = 'default' | 'denied' | 'granted' | 'insecure' | 'unsupported'

export function browserNotificationPermission(): BrowserNotificationPermission {
  if (typeof window === 'undefined') {
    return 'unsupported'
  }

  if (!window.isSecureContext) {
    return 'insecure'
  }

  return typeof Notification !== 'undefined' && typeof Notification.permission === 'string'
    ? Notification.permission
    : 'unsupported'
}

/** Call from a click handler only. */
export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermission> {
  if (browserNotificationPermission() === 'default') {
    await Notification.requestPermission()
  }

  return browserNotificationPermission()
}

type FocusSessionListener = (sessionId: string) => void

const focusSessionListeners = new Set<FocusSessionListener>()
const WORKER_FILE = 'hermes-notifications-sw.js'
const NOTIFICATION_TIMEOUT_MS = 5000
let notificationWorkerUrl: string | undefined

/** Same click contract as Electron's onFocusSession. */
export function onBrowserFocusSession(callback: FocusSessionListener): () => void {
  const serviceWorker = navigator.serviceWorker

  const onWorkerClick = (event: MessageEvent) => {
    const source = event.source

    if (
      source &&
      'scriptURL' in source &&
      source.scriptURL === notificationWorkerUrl &&
      event.data?.type === 'hermes:focus-session' &&
      typeof event.data.sessionId === 'string' &&
      event.data.sessionId
    ) {
      callback(event.data.sessionId)
    }
  }

  focusSessionListeners.add(callback)
  serviceWorker?.addEventListener('message', onWorkerClick)

  return () => {
    focusSessionListeners.delete(callback)
    serviceWorker?.removeEventListener('message', onWorkerClick)
  }
}

export interface BrowserNotifyPayload {
  body?: string
  focusSessionId?: string
  kind?: string
  sessionId?: string
  silent?: boolean
  tag?: string
  title?: string
}

interface BrowserNotificationContext {
  basePath: string
  /** Only provide a profile when a fresh window can route back to this gateway. */
  reopenProfile?: null | string
}

async function activeNotificationWorker(registration: ServiceWorkerRegistration, updating = false): Promise<ServiceWorker> {
  const worker = updating
    ? registration.installing ?? registration.waiting ?? registration.active
    : registration.active ?? registration.installing ?? registration.waiting

  if (!worker || worker.state === 'redundant') {
    throw new Error('Notification service worker is unavailable')
  }

  if (worker.state === 'activated') {
    return worker
  }

  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      worker.removeEventListener('statechange', onStateChange)

      if (error) {
        reject(error)
      } else {
        resolve(worker)
      }
    }

    const onStateChange = () => {
      if (worker.state === 'activated') {
        finish()
      } else if (worker.state === 'redundant') {
        finish(new Error('Notification service worker failed to activate'))
      }
    }

    const timer = setTimeout(
      () => finish(new Error('Notification service worker activation timed out')),
      NOTIFICATION_TIMEOUT_MS
    )

    worker.addEventListener('statechange', onStateChange)
    onStateChange()
  })
}

export async function notificationRegistration(serviceWorker: ServiceWorkerContainer, basePath: string) {
  const root = new URL(`${basePath}/`, window.location.origin)
  const script = new URL(WORKER_FILE, root).href
  notificationWorkerUrl = script

  // This scope leaves app navigation and other service workers alone.
  return serviceWorker.register(script, { scope: new URL('hermes-notifications/', root).href })
}

export async function pushNotificationRegistration(basePath: string) {
  const registration = await notificationRegistration(navigator.serviceWorker, basePath)
  await registration.update()
  await activeNotificationWorker(registration, true)

  return registration
}

async function showWorkerNotification(
  serviceWorker: ServiceWorkerContainer,
  title: string,
  options: NotificationOptions,
  sessionId: string | undefined,
  reopenSessionId: string | undefined,
  { basePath, reopenProfile }: BrowserNotificationContext
): Promise<boolean> {
  const registration = await notificationRegistration(serviceWorker, basePath)
  const worker = await activeNotificationWorker(registration)

  return new Promise((resolve, reject) => {
    const { port1, port2 } = new MessageChannel()

    const finish = (error?: Error) => {
      clearTimeout(timer)
      port1.close()
      port2.close()

      if (error) {
        reject(error)
      } else {
        resolve(true)
      }
    }

    const timer = setTimeout(
      () => finish(new Error('Notification service worker did not respond')),
      NOTIFICATION_TIMEOUT_MS
    )

    port1.onmessage = ({ data }) => {
      finish(
        data?.ok === true
          ? undefined
          : new Error(`Notification service worker failed (${data?.error ?? 'unknown error'})`)
      )
    }

    try {
      worker.postMessage(
        { type: 'hermes:show-notification', title, options, sessionId, reopenSessionId, reopenProfile },
        [port2]
      )
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Report permission barriers as false and propagate failures to the bridge caller. */
export async function showBrowserNotification(
  payload: BrowserNotifyPayload,
  context: BrowserNotificationContext = { basePath: '' }
): Promise<boolean> {
  const title = payload.title || 'Hermes'

  flagTabAttention(title)

  if (browserNotificationPermission() !== 'granted') {
    return false
  }

  const focusSessionId = payload.focusSessionId || payload.sessionId
  const turnTag = payload.kind === 'turnDone' && payload.tag ? `turn:${payload.tag}` : undefined

  const options: NotificationOptions = {
    body: payload.body,
    silent: payload.silent,
    tag: `hermes:${payload.kind ?? ''}:${turnTag ?? focusSessionId ?? payload.tag ?? ''}`
  }

  let notification: Notification

  try {
    notification = new Notification(title, options)
  } catch (error) {
    // Android exposes Notification.permission but throws from its constructor.
    // Fall back only before anything was shown, so a failure cannot double-send.
    const serviceWorker = navigator.serviceWorker

    if (!(error instanceof TypeError) || !serviceWorker) {
      throw error
    }

    return showWorkerNotification(serviceWorker, title, options, focusSessionId, payload.focusSessionId, context)
  }

  notification.onclick = () => {
    window.focus()
    notification.close()

    if (focusSessionId) {
      focusSessionListeners.forEach(listener => listener(focusSessionId))
    }
  }

  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer)
      notification.onshow = null
      notification.onerror = null

      if (error) {
        reject(error)
      } else {
        resolve(true)
      }
    }

    const timer = setTimeout(
      () => finish(new Error('Browser notification did not report delivery')),
      NOTIFICATION_TIMEOUT_MS
    )

    notification.onshow = () => finish()
    notification.onerror = () => finish(new Error('Browser notification failed to show'))
  })
}
