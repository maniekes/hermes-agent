import { browserNotificationPermission, pushNotificationRegistration } from '@/lib/browser-notifications'
import { PUSH_INSTALLATION_HEADER, pushInstallation } from '@/lib/browser-push-installation'
import { browserApi, browserBootstrap } from '@/lib/browser-transport'

export interface WebPushStatus {
  active: boolean
  available: boolean
  legacyBackend?: boolean
  publicKey?: string
  needsRepair?: boolean
}

const unavailable = { active: false, available: false }
const path = '/api/webapp/web-push'

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

  return { ...status, active, needsRepair: !active }
}

function applicationKey(value: string): Uint8Array<ArrayBuffer> {
  const base = value.replaceAll('-', '+').replaceAll('_', '/')

  return Uint8Array.from(atob(base.padEnd(Math.ceil(base.length / 4) * 4, '=')), char => char.charCodeAt(0))
}

async function existingBrowserSubscription() {
  const bootstrap = browserBootstrap()

  if (!bootstrap || !navigator.serviceWorker) {
    return undefined
  }

  const scope = new URL(`${bootstrap.basePath}/hermes-notifications/`, window.location.origin).href
  const registration = await navigator.serviceWorker.getRegistration(scope)

  return registration?.scope === scope ? registration.pushManager.getSubscription() : undefined
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

export function acknowledgeBrowserPush(admissionId: string, profile?: string) {
  void request(profile, 'seen', admissionId)?.catch(() => {})
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
