import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $notifications, clearNotifications } from '@/store/notifications'

import { ResponseReadyPolicyPicker } from './response-ready-policy'

afterEach(() => {
  cleanup()
  clearNotifications()
})

it('selects the conversation policy only after durable readback', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ response_ready_policy: { effective: 'off', mode: 'inherit', revision: 2 } })

  let confirm!: (value: unknown) => void
  request.mockReturnValueOnce(new Promise(resolve => { confirm = resolve }))
    .mockResolvedValueOnce({ response_ready_policy: { effective: 'on', mode: 'on', revision: 3 } })
  render(<ResponseReadyPolicyPicker request={request} sessionId="chat-a" />)
  const picker = await screen.findByRole<HTMLSelectElement>('combobox', { name: 'Response ready' })
  expect(picker.value).toBe('inherit')
  expect(screen.getByRole('option', { name: 'Inherit (off)' })).toBeTruthy()

  fireEvent.change(picker, { target: { value: 'on' } })
  expect(request).toHaveBeenNthCalledWith(2, 'session.mutate', {
    expected_revision: 2,
    operation: 'response_ready',
    payload: { mode: 'on' },
    request_id: expect.any(String),
    session_id: 'chat-a'
  })
  expect(picker.value).toBe('inherit')
  await act(async () => confirm({ response_ready_policy: { effective: 'on', mode: 'on' } }))
  expect(request).toHaveBeenLastCalledWith('session.info', { session_id: 'chat-a' })
  expect(picker.value).toBe('on')

  request.mockRejectedValueOnce(new Error('refused'))
    .mockResolvedValueOnce({ response_ready_policy: { effective: 'on', mode: 'on', revision: 3 } })
  await act(async () => { fireEvent.change(picker, { target: { value: 'off' } }) })
  expect(picker.value).toBe('on')
})

it('keeps the picker absent when the server does not support the policy', async () => {
  const request = vi.fn().mockResolvedValue({})
  await act(async () => { render(<ResponseReadyPolicyPicker request={request} sessionId="legacy" />) })
  expect(screen.queryByRole('combobox')).toBeNull()
})

it('reconciles a revision conflict and uses the fresh revision on deliberate retry', async () => {
  let current = { effective: 'off', mode: 'inherit', revision: 1 }

  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'session.info') { return { response_ready_policy: current } }

    if (params.expected_revision !== current.revision) { throw new Error('revision_conflict') }

    current = { effective: 'off', mode: 'off', revision: 3 }

    return {}
  })

  render(<ResponseReadyPolicyPicker request={request} sessionId="chat-a" />)
  const picker = await screen.findByRole<HTMLSelectElement>('combobox')
  expect(picker.value).toBe('inherit')

  current = { effective: 'on', mode: 'on', revision: 2 }
  await act(async () => { fireEvent.change(picker, { target: { value: 'off' } }) })
  expect(picker.value).toBe('on')
  expect(request.mock.calls.filter(([method]) => method === 'session.mutate')).toHaveLength(1)
  expect($notifications.get()).toEqual([expect.objectContaining({ kind: 'error' })])

  await act(async () => { fireEvent.change(picker, { target: { value: 'off' } }) })
  expect(request).toHaveBeenNthCalledWith(4, 'session.mutate', expect.objectContaining({
    expected_revision: 2, payload: { mode: 'off' }
  }))
  expect(picker.value).toBe('off')
})

it('does not show stale OFF when conflict readback fails and recovers on focus', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ response_ready_policy: { effective: 'off', mode: 'inherit', revision: 1 } })
    .mockRejectedValueOnce(new Error('revision_conflict'))
    .mockRejectedValueOnce(new Error('disconnected'))
    .mockResolvedValueOnce({ response_ready_policy: { effective: 'on', mode: 'on', revision: 2 } })

  render(<ResponseReadyPolicyPicker request={request} sessionId="chat-a" />)
  const picker = await screen.findByRole<HTMLSelectElement>('combobox')
  await act(async () => { fireEvent.change(picker, { target: { value: 'off' } }) })
  expect(screen.queryByRole('combobox')).toBeNull()

  await act(async () => { fireEvent.focus(window) })
  expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('on')
})

it('ignores an older focus read after a mutation and an old readback after changing chats', async () => {
  const policy = (mode: 'inherit' | 'on' | 'off', revision: number) => ({
    response_ready_policy: { effective: mode === 'on' ? 'on' : 'off', mode, revision }
  })

  let newerRead!: (value: unknown) => void
  let olderRead!: (value: unknown) => void
  let oldChatRead!: (value: unknown) => void

  const request = vi.fn()
    .mockResolvedValueOnce(policy('inherit', 1))
    .mockImplementationOnce(() => new Promise(resolve => { olderRead = resolve }))
    .mockRejectedValueOnce(new Error('revision_conflict'))
    .mockImplementationOnce(() => new Promise(resolve => { newerRead = resolve }))
    .mockRejectedValueOnce(new Error('revision_conflict'))
    .mockImplementationOnce(() => new Promise(resolve => { oldChatRead = resolve }))
    .mockResolvedValueOnce(policy('off', 5))

  const view = render(<ResponseReadyPolicyPicker request={request} sessionId="chat-a" />)
  const picker = await screen.findByRole<HTMLSelectElement>('combobox')
  fireEvent.focus(window)
  await act(async () => { fireEvent.change(picker, { target: { value: 'off' } }) })
  await act(async () => newerRead(policy('on', 2)))
  await act(async () => olderRead(policy('inherit', 1)))
  expect(picker.value).toBe('on')

  await act(async () => { fireEvent.change(picker, { target: { value: 'off' } }) })
  view.rerender(<ResponseReadyPolicyPicker request={request} sessionId="chat-b" />)
  await act(async () => oldChatRead(policy('on', 3)))
  expect(screen.getByRole<HTMLSelectElement>('combobox').value).toBe('off')
  expect(request).toHaveBeenLastCalledWith('session.info', { session_id: 'chat-b' })
})

it('shows the inherited profile value after focus without changing the conversation override', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ response_ready_policy: { default: 'off', effective: 'off', mode: 'inherit', revision: 2 } })
    .mockResolvedValueOnce({ response_ready_policy: { default: 'on', effective: 'on', mode: 'inherit', revision: 2 } })
    .mockRejectedValueOnce(new Error('unavailable'))

  render(<ResponseReadyPolicyPicker request={request} sessionId="chat-a" />)
  const picker = await screen.findByRole<HTMLSelectElement>('combobox')
  expect(picker.value).toBe('inherit')
  expect(screen.getByRole('option', { name: 'Inherit (off)' })).toBeTruthy()
  await act(async () => { fireEvent.focus(window) })
  expect(screen.getByRole('option', { name: 'Inherit (on)' })).toBeTruthy()
  expect(picker.value).toBe('inherit')
  expect(request.mock.calls.every(([method]) => method === 'session.info')).toBe(true)
  await act(async () => { fireEvent.focus(window) })
  expect(screen.queryByRole('combobox')).toBeNull()
})
