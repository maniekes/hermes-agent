import { describe, expect, it } from 'vitest'

import { consumeBrowserPushLink } from './browser-web-push'

describe('Web Push conversation URL', () => {
  it('turns the query restored by login into the existing profile-scoped chat route', () => {
    const page = new URL('https://hermes.example/prefix/?profile=work&pushSession=old-chat')
    expect(consumeBrowserPushLink(page)?.href).toBe('https://hermes.example/prefix/?profile=work#/old-chat')
  })

  it('leaves existing routing alone and ignores external or malformed targets', () => {
    expect(consumeBrowserPushLink(new URL('https://hermes.example/?profile=work&pushSession=old-chat#/another'))).toBeUndefined()
    expect(consumeBrowserPushLink(new URL('https://hermes.example/?pushSession=https%3A%2F%2Foutside.example'))).toBeUndefined()
  })
})
