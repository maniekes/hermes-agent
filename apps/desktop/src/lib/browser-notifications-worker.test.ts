import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

const script = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../public/hermes-notifications-sw.js'), 'utf8')

function worker(language = 'en-US') {
  const callbacks = new Map<string, (event: unknown) => void>()
  const registration = { scope: 'https://hermes.example/webapp/hermes-notifications/', showNotification: vi.fn() }
  const clients = { get: vi.fn(), openWindow: vi.fn() }

  const self = {
    addEventListener: (type: string, callback: (event: unknown) => void) => callbacks.set(type, callback),
    clients,
    navigator: { language },
    registration
  }

  runInNewContext(script, { self, URL })

  function send(type: string, event: object) {
    let pending: Promise<unknown> | undefined
    callbacks.get(type)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => {
        pending = promise
      }
    })

    return pending
  }

  return { clients, registration, send }
}

describe('notification service worker', () => {
  const destination = { sessionId: 'runtime-1', reopenSessionId: 'stored/1', reopenProfile: 'work & more' }

  it('acknowledges display and delivers a click only to the original client', async () => {
    const { clients, registration, send } = worker()
    const client = { focus: vi.fn(), postMessage: vi.fn(), type: 'window' }
    clients.get.mockResolvedValue(client)
    const reply = { postMessage: vi.fn() }
    await send('message', {
      data: {
        ...destination,
        clientId: 'untrusted-id',
        options: { body: 'finished', silent: true, tag: 'hermes:turnDone:runtime-1' },
        title: 'Response ready',
        type: 'hermes:show-notification'
      },
      ports: [reply],
      source: { id: 'original', type: 'window' }
    })

    expect(reply.postMessage).toHaveBeenCalledWith({ ok: true })
    const options = registration.showNotification.mock.calls[0][1]
    expect(options).toMatchObject({
      data: { ...destination, clientId: 'original' },
      silent: true,
      tag: 'original:hermes:turnDone:runtime-1'
    })

    const close = vi.fn()
    await send('notificationclick', { notification: { close, data: options.data } })

    expect(close).toHaveBeenCalledOnce()
    expect(clients.get.mock.calls).toEqual([['original']])
    expect(client.postMessage).toHaveBeenCalledWith({ sessionId: 'runtime-1', type: 'hermes:focus-session' })
    expect(client.focus).toHaveBeenCalledOnce()
    expect(clients.openWindow).not.toHaveBeenCalled()
  })

  it('reopens the fixed app URL with only the durable session and profile when the client is gone', async () => {
    const { clients, send } = worker()
    await send('notificationclick', {
      notification: { close: vi.fn(), data: { ...destination, clientId: 'closed', url: 'https://elsewhere.example' } }
    })

    expect(clients.openWindow.mock.calls).toEqual([
      ['https://hermes.example/webapp/?profile=work+%26+more#/stored%2F1']
    ])
  })

  it('does not open an unrelated window without a durable local target, or on malformed data', async () => {
    const { clients, send } = worker()
    await send('notificationclick', {
      notification: { close: vi.fn(), data: { clientId: 'closed', sessionId: 'rt-1' } }
    })
    await send('notificationclick', { notification: { close: vi.fn(), data: { sessionId: 'spoofed' } } })

    expect(clients.get.mock.calls).toEqual([['closed']])
    expect(clients.openWindow).not.toHaveBeenCalled()
  })

  it('reports the rejection of showNotification through the reply port', async () => {
    const { registration, send } = worker()
    const reply = { postMessage: vi.fn() }
    registration.showNotification.mockRejectedValue(new DOMException('Permission revoked', 'NotAllowedError'))
    await send('message', {
      data: { options: {}, title: 'Test', type: 'hermes:show-notification' },
      ports: [reply],
      source: { id: 'original', type: 'window' }
    })

    expect(reply.postMessage).toHaveBeenCalledWith({ error: 'NotAllowedError', ok: false })
  })

  it('shows a generic push with an admission tag and opens the profile-aware login-safe URL', async () => {
    const { clients, registration, send } = worker()
    const id = '1'.repeat(32)

    const pending = send('push', {
      data: { json: () => ({ id, kind: 'turn', profile: 'work', session: 'old-chat', text: 'private text' }) }
    })

    await pending

    expect(registration.showNotification).toHaveBeenCalledWith('Hermes', {
      body: 'Response ready',
      data: { push: true, pushProfile: 'work', pushSession: 'old-chat' },
      renotify: false,
      tag: `hermes:push:${id}`
    })
    await send('notificationclick', {
      notification: { close: vi.fn(), data: registration.showNotification.mock.calls[0][1].data }
    })
    expect(clients.get).not.toHaveBeenCalled()
    expect(clients.openWindow).toHaveBeenCalledWith('https://hermes.example/webapp/?profile=work&pushSession=old-chat')
  })

  it('keeps a malformed push visible while refusing its proposed target', async () => {
    const { clients, registration, send } = worker()
    await send('push', { data: { json: () => ({ id: 'bad', kind: 'turn', profile: 'work', session: '//elsewhere' }) } })
    const options = registration.showNotification.mock.calls[0][1]
    expect(options.data).toEqual({ push: true })
    await send('notificationclick', { notification: { close: vi.fn(), data: options.data } })
    expect(clients.openWindow).toHaveBeenCalledWith('https://hermes.example/webapp/')
  })
})

it('displays a valid preview without putting private text in click data', async () => {
  const { clients, registration, send } = worker('pl-PL')
  const id = '2'.repeat(32)
  await send('push', {
    data: { json: () => ({ id, kind: 'turn', preview: { body: 'Podsumowanie 🧪', title: 'Tytuł' }, profile: 'work', session: 'old-chat' }) }
  })
  const [title, options] = registration.showNotification.mock.calls[0]
  expect(title).toBe('Tytuł')
  expect(options).toMatchObject({ body: 'Podsumowanie 🧪', data: { push: true, pushProfile: 'work', pushSession: 'old-chat' } })
  expect(Object.keys(options.data)).toEqual(['push', 'pushSession', 'pushProfile'])
  await send('notificationclick', { notification: { close: vi.fn(), data: options.data } })
  expect(clients.openWindow).toHaveBeenCalledWith('https://hermes.example/webapp/?profile=work&pushSession=old-chat')
})

it.each([
  { target: '../other', preview: { body: 'Private', title: 'Secret' } },
  { target: 'chat', preview: { body: '🧪'.repeat(241), title: 'Secret' } },
  { target: 'chat', preview: { body: '', title: 'Secret' } },
  { target: 'chat', preview: { body: '<think>Private</think>' } },
  { target: 'chat', preview: { body: 'Private', title: 42 } }
])('uses a Polish generic notification for an invalid preview or target', async ({ target, preview }) => {
  const { registration, send } = worker('pl-PL')
  await send('push', { data: { json: () => ({ id: '3'.repeat(32), kind: 'turn', preview, profile: 'work', session: target }) } })
  expect(registration.showNotification).toHaveBeenCalledWith('Hermes', expect.objectContaining({ body: 'Odpowiedź gotowa' }))
})
