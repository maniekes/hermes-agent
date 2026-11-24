import { LOCAL_CONNECTION_ID } from '@hermes/shared'

import { findBrowserPushAdmission, ownsBrowserPushAdmission } from '@/lib/browser-notification-turns'
import {
  browserNotificationPermission, pushNotificationRegistration, updateExistingNotificationWorker
} from '@/lib/browser-notifications'
import { PUSH_INSTALLATION_HEADER, pushInstallation } from '@/lib/browser-push-installation'
import { browserApi, browserBootstrap, endpointUrl } from '@/lib/browser-transport'
import { type BrowserHostGlobals, browserLaunchProfileOrDefault, isBrowserHostedDesktop } from '@/lib/platform'
import { $connection } from '@/store/session'
import { isBrowserWindow, isHudWindow, isWatchWindow } from '@/store/windows'

export interface WebPushStatus {
  active: boolean
  available: boolean
  conversationPolicy?: boolean
  legacyBackend?: boolean
  publicKey?: string
  preview?: boolean
  needsRepair?: boolean
}

export interface ResponseReadyProfileDefault {
  enabled: boolean
  revision: number
}

const unavailable = { active: false, available: false }
const path = '/api/webapp/web-push'

export async function readProfileDefault(profile: string): Promise<ResponseReadyProfileDefault | undefined> {
  const bootstrap = browserBootstrap()

  if (!bootstrap?.authRequired) { return undefined }

  try {
    const value = await browserApi<ResponseReadyProfileDefault>(bootstrap, {
      method: 'GET', path: `${path}/profile-default`, profile, timeoutMs: 5000
    })

    if (typeof value?.enabled !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new Error('Invalid Response ready profile default')
    }

    return value
  } catch (error) {
    if (error instanceof Error && /^(404|405):/.test(error.message)) { return undefined }

    throw error
  }
}

export async function writeProfileDefault(profile: string, enabled: boolean, expectedRevision: number) {
  const bootstrap = browserBootstrap()

  if (!bootstrap?.authRequired) { throw new Error('Webapp sign-in required') }

  await browserApi(bootstrap, {
    body: { enabled, expected_revision: expectedRevision },
    method: 'POST', path: `${path}/profile-default`, profile, timeoutMs: 5000
  })
}

function request<T>(profile?: null | string, action?: string, body?: unknown) {
  const bootstrap = browserBootstrap()
  const installation = bootstrap?.authRequired && pushInstallation(bootstrap.basePath)

  if (!bootstrap || !installation) {
    return undefined
  }

  return browserApi<T>(bootstrap, {
    body,
    method: action ? 'POST' : 'GET',
    path: action ? `${path}/${action}` : path,
    profile,
    timeoutMs: action?.startsWith('disable') ? 10000 : 5000
  }, { [PUSH_INSTALLATION_HEADER]: installation })
}

export async function browserPushStatus(profile?: null | string): Promise<WebPushStatus> {
  let status: WebPushStatus

  try {
    status = await request<WebPushStatus>(profile) ?? unavailable
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('404:')) {
      return { ...unavailable, legacyBackend: true }
    }

    throw error
  }

  if (!status.available) {
    return status
  }

  const subscription = await existingBrowserSubscription()

  if (!status.active) {
    return { ...status, needsRepair: Boolean(subscription) }
  }

  if (!subscription || browserNotificationPermission() !== 'granted' ||
      !status.publicKey || !sameKey(subscription, applicationKey(status.publicKey))) {
    return { ...status, active: false, needsRepair: true }
  }

  const check = await request<{ active: boolean }>(profile, 'check', subscription.toJSON())
  const active = check?.active === true

  if (active) { void refreshExistingBrowserPushWorker() }

  return { ...status, active, needsRepair: !active }
}

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const base = value.replaceAll('-', '+').replaceAll('_', '/')

  return Uint8Array.from(atob(base.padEnd(Math.ceil(base.length / 4) * 4, '=')), char => char.charCodeAt(0))
}

async function existingBrowserRegistration(basePath: string) {
  const scope = new URL(`${basePath}/hermes-notifications/`, window.location.origin).href
  const registration = await navigator.serviceWorker?.getRegistration(scope)

  return registration?.scope === scope ? registration : undefined
}

async function existingBrowserSubscription() {
  const bootstrap = browserBootstrap()
  const registration = bootstrap && await existingBrowserRegistration(bootstrap.basePath)

  return registration ? registration.pushManager.getSubscription() : undefined
}

let existingWorkerUpdate: Promise<boolean> | undefined

export async function refreshExistingBrowserPushWorker(retryAfterOverlap?: () => boolean): Promise<void> {
  const bootstrap = browserBootstrap()

  if (!bootstrap?.authRequired || browserNotificationPermission() !== 'granted') { return }

  if (existingWorkerUpdate && retryAfterOverlap) {
    // An online event may arrive before the previous attempt notices that it failed.
    if (!(await existingWorkerUpdate) && retryAfterOverlap()) { await refreshExistingBrowserPushWorker() }

    return
  }

  // This sub-scope does not control app navigation, so boot can leave an older worker active.
  existingWorkerUpdate ??= (async () => {
    const registration = await existingBrowserRegistration(bootstrap.basePath)

    if (registration && await registration.pushManager.getSubscription()) {
      await updateExistingNotificationWorker(registration, bootstrap.basePath)
    }
  })().then(() => true, () => {
    // An update can fail offline. Enrollment and privacy readback remain independent.
    return false
  }).finally(() => { existingWorkerUpdate = undefined })

  await existingWorkerUpdate
}

function sameKey(subscription: PushSubscription, key: Uint8Array) {
  const current = new Uint8Array(subscription.options.applicationServerKey ?? new ArrayBuffer(0))

  return current.length === key.length && current.every((byte, index) => byte === key[index])
}

export async function enableBrowserPush(profile: null | string, publicKey: string) {
  const bootstrap = browserBootstrap()

  if (!bootstrap || browserNotificationPermission() !== 'granted') {
    throw new Error('Web Push permission is unavailable')
  }

  const key = applicationKey(publicKey)
  const registration = await pushNotificationRegistration(bootstrap.basePath)
  let subscription = await registration.pushManager.getSubscription()

  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe()
    subscription = null
  }

  subscription ??= await registration.pushManager.subscribe({ applicationServerKey: key, userVisibleOnly: true })

  if (!(await request<{ active: boolean }>(profile, 'subscribe', subscription.toJSON()))?.active) {
    throw new Error('Web Push registration failed')
  }
}

export async function disableBrowserPush(profile: null | string, allProfiles = false) {
  const result = await request<{ applied: boolean }>(profile, allProfiles ? 'disable-all' : 'disable', {})

  if (result?.applied && allProfiles) {
    const subscription = await existingBrowserSubscription()
    await subscription?.unsubscribe()
  }
}

export async function testBrowserPush(profile: null | string) {
  try {
    return (await request<{ applied: boolean }>(profile, 'test', {}))?.applied ? 'queued' : 'inactive'
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('429:')) {
      return 'recent'
    }

    throw error
  }
}

export async function setBrowserPushPreview(profile: null | string, preview: boolean) {
  const answer = await request<{ preview: boolean }>(profile, 'privacy', { preview })

  if (typeof answer?.preview !== 'boolean') {
    throw new Error('Web Push privacy choice could not be read back')
  }

  return answer.preview
}

export function acknowledgeBrowserPush(admissionId: string, profile?: string) {
  void request(profile, 'seen', admissionId)?.catch(() => {})
}

const PUSH_CLICK_CONFIRM_MS = 1000

interface BrowserPushClick {
  commitBy: number
  deadline: number
  profile: string
  proof: string
  session: string
}

const pushTargetPart = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

function isPushClick(value: Record<string, unknown>): value is Record<string, unknown> & BrowserPushClick {
  const now = Date.now()

  return value.version === 2 && typeof value.proof === 'string' && /^[0-9a-f]{64}$/.test(value.proof) &&
    pushTargetPart(value.profile) && pushTargetPart(value.session) && typeof value.deadline === 'number' &&
    value.deadline > now && value.deadline <= now + PUSH_CLICK_CONFIRM_MS &&
    value.commitBy === value.deadline + PUSH_CLICK_CONFIRM_MS
}

/** Offer/commit runs only for a click. The live view never follows an unverified payload. */
export function onBrowserPushClick(
  profile: string,
  canOpen: (session: string) => boolean,
  open: (session: string) => void
): (() => void) | undefined {
  const bootstrap = browserBootstrap()
  const serviceWorker = navigator.serviceWorker

  if (!serviceWorker || !bootstrap?.authRequired || !isBrowserHostedDesktop() ||
      (window as Window & BrowserHostGlobals).__HERMES_UI_SURFACE__ !== 'webapp' ||
      isBrowserWindow() || isHudWindow() || isWatchWindow()) { return }

  const script = endpointUrl('/hermes-notifications-sw.js', bootstrap.basePath).href
  const pending = new Set<() => void>()
  let listening = true

  const eligible = (data: BrowserPushClick) => {
    const current = $connection.get()

    return listening && data.profile === profile && current &&
      (current.connectionId || LOCAL_CONNECTION_ID) === LOCAL_CONNECTION_ID &&
      (current.profile || browserLaunchProfileOrDefault()) === profile &&
      canOpen(data.session)
  }

  const prepare = async (data: BrowserPushClick, port: MessagePort) => {
    const installation = eligible(data) ? pushInstallation(bootstrap.basePath, false) : undefined

    if (!installation) {
      port.postMessage({ ready: false })
      port.close()

      return
    }

    const controller = new AbortController()
    let ready = false
    let settled = false

    const release = () => {
      window.clearTimeout(timer)
      pending.delete(reject)
      controller.abort()
      port.close()
    }

    const reject = () => {
      if (settled) { return }

      settled = true
      port.postMessage(ready ? { outcome: 'rejected' } : { ready: false })
      release()
    }

    const timer = window.setTimeout(reject, Math.max(0, data.commitBy - Date.now()))
    pending.add(reject)

    try {
      // The offer carries a digest so a reply cannot just echo the receipt
      // ID. Use this document's receipts and check the server's scope too.
      const id = await findBrowserPushAdmission(data.proof)

      if (!id || settled || Date.now() >= data.deadline || !eligible(data)) {
        reject()

        return
      }

      // A 401 here declines the offer. The worker's cold document link carries the
      // target through login, so this request must never redirect the current page.
      const response = await fetch(endpointUrl(`${path}/open`, bootstrap.basePath, data.profile), {
        body: JSON.stringify({ id, session: data.session }),
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', [PUSH_INSTALLATION_HEADER]: installation },
        method: 'POST',
        redirect: 'error',
        signal: controller.signal
      })

      const allowed = response.ok && (await response.json()).allowed === true

      if (allowed && !settled && Date.now() < data.deadline && eligible(data) && ownsBrowserPushAdmission(id)) {
        port.onmessage = ({ data: choice }) => {
          if (settled || choice?.open !== true) { return }

          if (Date.now() >= data.commitBy || !eligible(data) || !ownsBrowserPushAdmission(id)) {
            reject()

            return
          }

          // Navigation can synchronously dispose the listener. From this point
          // a missing result is uncertain, never a safe rejection.
          settled = true

          try {
            open(data.session)
            port.postMessage({ outcome: 'applied' })
          } catch {
            // The route or pane may already have changed.
          } finally {
            release()
          }
        }

        ready = true
        port.postMessage({ ready: true, id, version: 2 })

        return
      }
    } catch {
      // No usable authorization for the warm path.
    }

    reject()
  }

  const onMessage = (event: MessageEvent) => {
    const { data, source, ports: [port] } = event

    if (port && typeof ServiceWorker !== 'undefined' && source instanceof ServiceWorker && source.scriptURL === script &&
      data?.type === 'hermes:prepare-push-click' && isPushClick(data)) {
      void prepare(data, port)
    }
  }

  serviceWorker.addEventListener('message', onMessage)

  return () => {
    listening = false
    serviceWorker.removeEventListener('message', onMessage)

    for (const finish of pending) { finish() }
  }
}

/** Consume only the same-origin deep link that survived the Webapp login redirect. */
export function consumeBrowserPushLink(location: URL): URL | undefined {
  const session = location.searchParams.get('pushSession')

  if (!session || !/^[A-Za-z0-9_-]{1,128}$/.test(session) || location.hash) {
    return undefined
  }

  const target = new URL(location)
  target.searchParams.delete('pushSession')
  target.hash = `/${encodeURIComponent(session)}`

  return target
}
