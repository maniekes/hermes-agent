export const PUSH_INSTALLATION_HEADER = 'X-Hermes-Push-Installation'

/** Browser storage is shared by this installation's windows and is independent of a socket or tab. */
export function pushInstallation(basePath: string): string | undefined {
  if (!window.isSecureContext || !navigator.serviceWorker || !('PushManager' in window)) {
    return undefined
  }

  try {
    const key = `hermes:web-push-installation:${basePath}`
    const current = window.localStorage.getItem(key)

    if (current && /^[a-f0-9]{64}$/.test(current)) {
      return current
    }

    const value = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte =>
      byte.toString(16).padStart(2, '0')
    ).join('')

    window.localStorage.setItem(key, value)

    return value
  } catch {
    return undefined
  }
}
