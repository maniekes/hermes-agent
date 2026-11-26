import { atom } from 'nanostores'

// Bumped when the person opens a chat in this window (sidebar row, ⌘K, a
// notification, the session switcher: every door goes through openSession).
// Route effects that select a chat on their own (the cold-start route resume,
// runtime recovery) never bump it, so a background restore can tell a chat the
// user chose, which it must leave open, from one selected automatically.
let userSessionOpenRevision = 0

/** The revision at window start. Module load precedes any input, so a launch
 *  restore compares against this rather than a value read once boot reaches
 *  the registry: the connecting overlay lifts at the socket open while config
 *  still loads, and a chat clicked in that gap would otherwise become the
 *  baseline and be closed by the restore. */
export const LAUNCH_USER_SESSION_OPEN = 0

export function currentUserSessionOpen(): number {
  return userSessionOpenRevision
}

export function noteUserSessionOpen(): void {
  userSessionOpenRevision += 1
  $pushThreadArrival.set(null)
}

export function _resetUserSessionOpenForTests(): void {
  userSessionOpenRevision = LAUNCH_USER_SESSION_OPEN
}

interface PushThreadArrival {
  coldStart: boolean
  hash: string
  profile: string
  sessionKey: string
}

// One viewport instruction, owned by the navigation that opened the thread.
export const $pushThreadArrival = atom<PushThreadArrival | null>(null)

export function requestPushThreadEnd(sessionKey: string, profile: string, coldStart = false) {
  $pushThreadArrival.set({
    coldStart,
    hash: window.location.hash,
    profile,
    sessionKey
  })
}

export function currentPushThreadArrival(): PushThreadArrival | null {
  const arrival = $pushThreadArrival.get()

  if (arrival && arrival.hash !== window.location.hash) {
    $pushThreadArrival.set(null)

    return null
  }

  return arrival
}
