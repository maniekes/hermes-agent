import type { GatewayEvent } from '@hermes/shared'

/** Renderer-only provenance of a successful canonical attach on a concrete socket. */
export interface SessionAttachment {
  connectionId: string
  profile: string
  runtimeId: string
  isCurrent: () => boolean
}

export type SessionBindingOwner = Pick<SessionAttachment, 'connectionId' | 'profile'>

const ATTACHMENT = Symbol('session-attachment')

export function recordSessionAttachment(result: object, attachment: SessionAttachment): void {
  Object.defineProperty(result, ATTACHMENT, { value: attachment })
}

export function sessionAttachment(result: unknown): SessionAttachment | undefined {
  if (!result || typeof result !== 'object') {
    return undefined
  }

  return (result as { [ATTACHMENT]?: SessionAttachment })[ATTACHMENT]
}

export function sameSessionBindingOwner(
  left: SessionBindingOwner | undefined,
  right: SessionBindingOwner | undefined
): boolean {
  return left?.connectionId === right?.connectionId && left?.profile === right?.profile
}

export function isCronReportFrame(event: GatewayEvent): boolean {
  return event.type === 'session.info' && Boolean((event.payload as GatewayEvent<'session.info'>['payload'])?.cron_report)
}
