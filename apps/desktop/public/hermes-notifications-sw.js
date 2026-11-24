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
const PUSH_CLICK_RESULT_GRACE_MS = 250
let latestPushClick = 0
let pendingPushCommit

function until(deadline, pending) {
  let timer
  const timeLimit = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())) })

  return Promise.race([pending, timeLimit]).finally(() => clearTimeout(timer))
}

function preparePushClient(client, data, id, proof, deadline, commitBy) {
  const { port1, port2 } = new MessageChannel()

  return new Promise(resolve => {
    const finish = ready => {
      clearTimeout(timer)
      if (!ready) {
        port1.onmessage = null
        port1.close()
        resolve(null)
        return
      }

      let settle
      const result = new Promise(resolveResult => { settle = resolveResult })
      const candidate = { client, port: port1, outcome: undefined, result }
      port1.onmessage = ({ data: reply }) => {
        if (!candidate.outcome && (reply?.outcome === 'applied' || reply?.outcome === 'rejected')) {
          candidate.outcome = reply.outcome
          settle(reply.outcome)
        }
      }
      resolve(candidate)
    }
    const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
    port1.onmessage = ({ data: reply }) => finish(
      reply?.ready === true && reply.version === 2 && reply.id === id && Date.now() < deadline
    )

    try {
      client.postMessage({
        type: 'hermes:prepare-push-click',
        version: 2,
        proof,
        profile: data.pushProfile,
        session: data.pushSession,
        deadline,
        commitBy
      }, [port2])
    } catch {
      port2.close()
      finish(false)
    }
  })
}

async function commitPushClick(candidate, commitBy, click) {
  if (candidate.outcome || Date.now() >= commitBy) { return false }

  const { client, port, result } = candidate
  const focused = await until(commitBy, Promise.race([client.focus(), result.then(() => null)]))
  if (focused?.id !== client.id || candidate.outcome || click !== latestPushClick || Date.now() >= commitBy) {
    return false
  }

  port.postMessage({ open: true })
  const pending = until(commitBy + PUSH_CLICK_RESULT_GRACE_MS, result)
  pendingPushCommit = pending
  const outcome = await pending
  if (pendingPushCommit === pending) { pendingPushCommit = undefined }

  // Silence after dispatch can mean navigation ran but its acknowledgement was lost.
  return outcome !== 'rejected'
}

async function openPushTarget(data, target, id, click) {
  // An older dispatched command can still apply until its lease expires.
  await pendingPushCommit
  if (click !== latestPushClick) { return }

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
        const commitBy = deadline + PUSH_CLICK_WAIT_MS
        ready = (await Promise.all(candidates.map(client => preparePushClient(client, data, id, proof, deadline, commitBy)))).filter(Boolean)
        if (ready.length === 1 && click === latestPushClick && await commitPushClick(ready[0], commitBy, click)) { return }
      }
    } catch {
      // A client that could not be focused or dispatched to leaves the login-safe cold path.
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
