import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { i18nHost } from '@/sdk/i18n'
import { $gateway } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { $gatewayState } from '@/store/session'

import { useI18n } from './context'
import { createPluginI18n } from './plugin-i18n'
import { ProfileI18nProvider } from './profile-provider'
import { registeredLocaleMeta, unregisterAppLocaleSource } from './registry'
import { $requestedLocale } from './runtime'

function Probe() {
  const { isLoadingConfig, locale, t } = useI18n()

  return <>
    <output data-config-ready={String(!isLoadingConfig)}>{locale} | {t.settings.notifications.device} | {t.settings.notifications.completionSoundPreview}</output>
    <span>{t.common.save}</span>
  </>
}

afterEach(() => {
  cleanup()
  $gateway.set(null)
  $gatewayState.set('idle')
  $activeGatewayProfile.set('default')
  $requestedLocale.set(null)
  unregisterAppLocaleSource('backend')
  unregisterAppLocaleSource('plugin:review')
  vi.unstubAllGlobals()
})

function stubHost(language?: string) {
  const api = vi.fn(async (req: { method?: string; path: string }) => {
    if (req.path !== '/api/config?include_defaults=false') {throw new Error('unexpected fixture API path')}

    if ((req.method ?? 'GET') !== 'GET') {throw new Error('unexpected preference write')}

    return { display: language === undefined ? {} : { language } }
  })

  const getMachineProfile = vi.fn(async () => ({ locale: 'pl-PL' }))
  vi.stubGlobal('hermesDesktop', { api, getMachineProfile })

  return { api, getMachineProfile }
}

it.each([
  ['pl', 'pl | To urządzenie | Preview'],
  ['en', 'en | This device | Preview'],
  [undefined, 'en | This device | Preview']
] as const)('loads the production provider with saved %s on a Polish system', async (saved, expected) => {
  const { api, getMachineProfile } = stubHost(saved)
  render(<ProfileI18nProvider><Probe /></ProfileI18nProvider>)
  await waitFor(() => {
    expect(api).toHaveBeenCalledOnce()
    expect(screen.getByText(expected).getAttribute('data-config-ready')).toBe('true')
    expect(getMachineProfile).toHaveBeenCalledTimes(saved ? 0 : 1)
  })
  expect(api.mock.calls.every(([req]) => (req.method ?? 'GET') === 'GET')).toBe(true)
})

it('applies backend and plugin overrides, disposes only the plugin, and drops the backend layer on profile change', async () => {
  const { api } = stubHost('pl')

  const request = vi.fn(async (method: string) => method === 'i18n.languages'
    ? { languages: [{ id: 'pl', surfaces: ['desktop'] }] }
    : { messages: { 'settings.notifications.device': 'Backend device' } })

  $gatewayState.set('open')
  $gateway.set({ request } as never)
  render(<ProfileI18nProvider><Probe /></ProfileI18nProvider>)
  expect(await screen.findByText('pl | Backend device | Preview')).toBeTruthy()
  let dispose!: () => void
  await act(async () => {
    const plugin = createPluginI18n('review', callback => callback)
    dispose = plugin.registerAppLocale('pl', { translations: { 'settings.notifications.device': 'Plugin device' } })
  })
  expect(screen.getByText('pl | Plugin device | Preview')).toBeTruthy()
  await act(async () => dispose())
  expect(screen.getByText('pl | Backend device | Preview')).toBeTruthy()
  await act(async () => {
    $gateway.set(null)
    $gatewayState.set('idle')
    $activeGatewayProfile.set('review-beta')
  })
  expect(await screen.findByText('pl | To urządzenie | Preview')).toBeTruthy()
  expect(registeredLocaleMeta('pl')).toHaveLength(1)
  expect(api.mock.calls.every(([req]) => (req.method ?? 'GET') === 'GET')).toBe(true)
})

it('discards a backend pack still in flight when the provider unmounts', async () => {
  stubHost('pl')
  let finishCatalog!: (value: unknown) => void
  const catalog = new Promise(resolve => { finishCatalog = resolve })

  const request = vi.fn(async (method: string) => method === 'i18n.languages'
    ? { languages: [{ id: 'pl', surfaces: ['desktop'] }] }
    : catalog)

  const mounted = render(<ProfileI18nProvider><Probe /></ProfileI18nProvider>)
  await screen.findByText('pl | To urządzenie | Preview')
  await act(async () => {
    $gatewayState.set('open')
    $gateway.set({ request } as never)
  })
  await waitFor(() => expect(request).toHaveBeenCalledWith('i18n.catalog', { lang: 'pl', surface: 'desktop' }))
  mounted.unmount()
  await act(async () => {
    finishCatalog({ messages: { 'settings.notifications.device': 'Late override' } })
  })
  expect(registeredLocaleMeta('pl')).toHaveLength(1)
})

it('keeps the Polish baseline through a legacy host registration, disposal and remount', async () => {
  const { api } = stubHost('pl')
  const first = render(<ProfileI18nProvider><Probe /></ProfileI18nProvider>)
  await screen.findByText('pl | To urządzenie | Preview')
  let dispose!: () => void
  await act(async () => {
    dispose = i18nHost.registerAppLocale('pl', { translations: { 'common.save': 'Zapisz z wtyczki' } })
  })
  expect(screen.getByText('Zapisz z wtyczki')).toBeTruthy()
  expect(screen.getByText('pl | To urządzenie | Preview')).toBeTruthy()
  await act(async () => dispose())
  expect(registeredLocaleMeta('pl')).toHaveLength(1)
  first.unmount()
  render(<ProfileI18nProvider><Probe /></ProfileI18nProvider>)
  await waitFor(() => {
    expect(api).toHaveBeenCalledTimes(2)
    expect(screen.getByText('pl | To urządzenie | Preview').getAttribute('data-config-ready')).toBe('true')
  })
  expect(api.mock.calls.every(([req]) => (req.method ?? 'GET') === 'GET')).toBe(true)
})
