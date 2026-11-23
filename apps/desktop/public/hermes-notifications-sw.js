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
    event.waitUntil(self.clients.openWindow(target.href))

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
      ...(hasTarget ? { pushSession: payload.session, pushProfile: payload.profile } : {})
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
