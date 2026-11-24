/* global self */
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))

// The registration is under a dedicated sub-scope of the Webapp.
const app = new URL('../', self.registration.scope)

self.addEventListener('message', event => {
  const {
    data,
    source,
    ports: [reply]
  } = event

  if (!reply || data?.type !== 'hermes:show-notification' || source?.type !== 'window') {
    return
  }

  // Use the browser-supplied client ID, never a purported sender in the payload.
  event.waitUntil(
    (async () => {
      try {
        const { title, options, sessionId, reopenSessionId, reopenProfile } = data

        await self.registration.showNotification(title, {
          body: options.body,
          silent: options.silent,
          tag: `${source.id}:${options.tag}`,
          data: { clientId: source.id, sessionId, reopenSessionId, reopenProfile }
        })
        reply.postMessage({ ok: true })
      } catch (error) {
        reply.postMessage({ ok: false, error: error?.name })
      }
    })()
  )
})

const PUSH_CLICK_WAIT_MS = 1000
let latestPushClick = 0

function preparePushClient(client, data, id, proof, deadline) {
  const { port1, port2 } = new MessageChannel()

  return new Promise(resolve => {
    const finish = ready => {
      clearTimeout(timer)
      port1.onmessage = null
      if (!ready) { port1.close() }
      resolve(ready ? { client, port: port1 } : null)
    }
    const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
    port1.onmessage = ({ data: reply }) => finish(reply?.ready === true && reply.id === id && Date.now() < deadline)

    try {
      client.postMessage({
        type: 'hermes:prepare-push-click',
        proof,
        profile: data.pushProfile,
        session: data.pushSession,
        deadline
      }, [port2])
    } catch {
      port2.close()
      finish(false)
    }
  })
}

async function openPushTarget(data, target, id, click) {
  if (target.searchParams.has('pushSession') && id) {
    let ready = []
    try {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const candidates = windows.filter(client => {
        const url = new URL(client.url)
        return client.frameType === 'top-level' && url.origin === app.origin && url.pathname === app.pathname
      })
      if (candidates.length > 0 && candidates.length <= 16 && click === latestPushClick) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id))
        const proof = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
        const deadline = Date.now() + PUSH_CLICK_WAIT_MS
        ready = (await Promise.all(candidates.map(client => preparePushClient(client, data, id, proof, deadline)))).filter(Boolean)
      }
      if (ready.length === 1 && click === latestPushClick) {
        const { client, port } = ready[0]
        const focused = await client.focus()
        if (focused?.id === client.id && click === latestPushClick) {
          // Once dispatched, an unconfirmed renderer action must not open a second window.
          port.postMessage({ open: true })
          return
        }
      }
    } catch {
      // Closed, unsupported or unresponsive candidates leave the login-safe cold path.
    } finally {
      for (const candidate of ready) { candidate.port.close() }
    }
  }
  if (click === latestPushClick) { await self.clients.openWindow(target.href) }
}

self.addEventListener('notificationclick', event => {
  const data = event.notification.data
  event.notification.close()

  if (data?.push === true) {
    const target = new URL(app)
    if (typeof data.pushSession === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.pushSession) &&
      typeof data.pushProfile === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.pushProfile)) {
      target.searchParams.set('profile', data.pushProfile)
      target.searchParams.set('pushSession', data.pushSession)
    }
    const id = /^hermes:push:([0-9a-f]{32})$/.exec(event.notification.tag)?.[1]
    event.waitUntil(openPushTarget(data, target, id, ++latestPushClick))

    return
  }

  if (typeof data?.clientId !== 'string') {
    return
  }

  event.waitUntil(
    (async () => {
      const client = await self.clients.get(data.clientId)

      if (client?.type === 'window') {
        if (typeof data.sessionId === 'string' && data.sessionId) {
          client.postMessage({ type: 'hermes:focus-session', sessionId: data.sessionId })
        }
        await client.focus()

        return
      }

      // Never repurpose another open tab. Reopen only on the serving gateway,
      // under its existing sign-in policy, with a durable conversation ID.
      if (
        typeof data.reopenProfile === 'string' &&
        data.reopenProfile &&
        typeof data.reopenSessionId === 'string' &&
        data.reopenSessionId
      ) {
        const target = new URL(app)
        target.searchParams.set('profile', data.reopenProfile)
        target.hash = `/${encodeURIComponent(data.reopenSessionId)}`
        await self.clients.openWindow(target.href)
      }
    })()
  )
})

self.addEventListener('push', event => {
  let payload

  try {
    payload = event.data?.json()
  } catch {
    // Older or invalid payloads still result in a visible, generic notification.
  }

  const id = typeof payload?.id === 'string' && /^[0-9a-f]{32}$/.test(payload.id) ? payload.id : ''
  const hasTarget =
    payload?.kind === 'turn' &&
    typeof payload.session === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.session) &&
    typeof payload.profile === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(payload.profile)

  const preview = hasTarget && id && validPreview(payload.preview) ? payload.preview : null
  const polish = /^pl(?:-|$)/i.test(self.navigator?.language ?? '')
  const generic = polish ? 'Odpowiedź gotowa' : 'Response ready'

  event.waitUntil(self.registration.showNotification(preview?.title ?? 'Hermes', {
    body: payload?.kind === 'test' ? 'Test notification' : preview?.body ?? generic,
    data: {
      push: true,
      ...(hasTarget ? {
        pushSession: payload.session,
        pushProfile: payload.profile
      } : {})
    },
    renotify: false,
    tag: id ? `hermes:push:${id}` : 'hermes:push'
  }))
})

function validPreview(preview) {
  const validText = (text, limit) => typeof text === 'string' && text.trim() && text.length <= 2 * limit &&
    [...text].length <= limit && !/\p{Cc}|<\/?[a-z][^>]*>/iu.test(text)

  return preview && validText(preview.body, 240) &&
    (preview.title === undefined || validText(preview.title, 80))
}
