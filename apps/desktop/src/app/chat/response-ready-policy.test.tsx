import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ResponseReadyPolicyPicker } from './response-ready-policy'

afterEach(cleanup)

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
  await act(async () => { fireEvent.change(picker, { target: { value: 'off' } }) })
  expect(picker.value).toBe('on')
})

it('keeps the picker absent when the server does not support the policy', async () => {
  const request = vi.fn().mockResolvedValue({})
  await act(async () => { render(<ResponseReadyPolicyPicker request={request} sessionId="legacy" />) })
  expect(screen.queryByRole('combobox')).toBeNull()
})
