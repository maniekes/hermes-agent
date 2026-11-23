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
