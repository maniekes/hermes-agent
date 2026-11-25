import type { TranslationOverride } from '@hermes/shared/i18n'

import { registerAppLocale } from './registry'
import type { NotificationSettingsTranslations } from './types_notifications'

const notifications = {
  title: 'Powiadomienia',
  intro: 'Ustawienia powiadomień systemowych.',
  device: 'To urządzenie',
  conversationDefaults: 'Domyślne dla rozmów',
  enableAll: 'Włącz powiadomienia',
  enableAllDesc: 'Wyłączenie wycisza powiadomienia systemowe na tym urządzeniu.',
  webPushPolicy: {
    title: 'Powiadomienia o odpowiedzi',
    inherit: 'Domyślne (wył.)',
    inheritOn: 'Domyślne (wł.)',
    on: 'Włączone',
    off: 'Wyłączone',
    failed: 'Nie udało się zapisać ustawienia tej rozmowy. Spróbuj ponownie.'
  },
  webPushProfileDefault: {
    label: 'Domyślne powiadomienia o odpowiedzi ({profile})',
    description: 'Na wszystkich urządzeniach, dla nowych i istniejących rozmów z ustawieniem „Domyślne” w tym profilu.',
    failed: 'Nie udało się zapisać domyślnego ustawienia. Spróbuj ponownie.',
    unavailable: 'Nie udało się odczytać domyślnego ustawienia.'
  },
  webPushPreview: {
    label: 'Pokazuj podgląd treści',
    description: 'Pokazuje tytuł rozmowy i fragment odpowiedzi w powiadomieniach tego urządzenia. Po wyłączeniu zobaczysz ogólny komunikat.'
  },
  focusedHint: 'Powiadomienia o gotowej odpowiedzi pojawiają się, gdy Hermes działa w tle.',
  kinds: {
    approval: { label: 'Wymagana zgoda', description: 'Polecenie czeka na Twoją decyzję.' },
    input: { label: 'Wymagana odpowiedź', description: 'Hermes czeka na odpowiedź lub dane.' },
    turnDone: { label: 'Odpowiedź gotowa', description: 'Hermes skończył odpowiadać w tle.' },
    turnError: { label: 'Błąd odpowiedzi', description: 'Wystąpił błąd podczas odpowiadania w tle.' },
    backgroundDone: { label: 'Zadanie w tle zakończone', description: 'Polecenie w tle zakończyło działanie.' },
    credits: { label: 'Alerty kredytów', description: 'Dostęp do kredytów wstrzymano lub przywrócono.' },
    plugin: { label: 'Powiadomienia wtyczek', description: 'Wtyczka wysłała powiadomienie, gdy Hermes działał w tle.' }
  },
  browserPermission: {
    title: 'Zgoda przeglądarki',
    allow: 'Zezwól',
    requestFailed: 'Nie udało się poprosić o zgodę. Sprawdź uprawnienia witryny w przeglądarce.',
    states: {
      default: 'Zezwól na powiadomienia w przeglądarce.',
      granted: 'Przeglądarka zezwala na powiadomienia.',
      denied: 'Przeglądarka blokuje powiadomienia. Zezwól na nie w ustawieniach tej witryny.',
      insecure: 'Powiadomienia wymagają połączenia HTTPS.',
      unsupported: 'Ta przeglądarka nie obsługuje powiadomień.'
    }
  },
  webPush: {
    title: 'Odpowiedź gotowa, gdy Hermes jest zamknięty',
    enable: 'Skonfiguruj',
    repair: 'Napraw',
    needsRepair: 'Odnów połączenie powiadomień w tle na tym urządzeniu.',
    turnDoneOff: 'Włącz niżej „Odpowiedź gotowa”, aby skonfigurować powiadomienia w tle.',
    retry: 'Sprawdź ponownie',
    setup: 'Skonfiguruj powiadomienia o odpowiedzi w tle dla tego profilu.',
    active: 'Powiadomienia w tle są aktywne dla tego profilu na tym urządzeniu.',
    unavailable: 'Nie udało się sprawdzić stanu powiadomień w tle.',
    failed: 'Nie udało się zapisać ustawień powiadomień w tle. Spróbuj ponownie.',
    queued: 'Test dodano do kolejki. Jeśli powiadomienie się nie pojawi, sprawdź uprawnienia systemu i tryb „Nie przeszkadzać”.',
    recent: 'Test był już uruchomiony. Odczekaj chwilę przed kolejną próbą.',
    revocationPending: 'Wysyłka może jeszcze trwać. Ponów wyłączenie powiadomień w tle.'
  },
  test: 'Wyślij test powiadomienia',
  testBody: 'To jest powiadomienie testowe.',
  testSent: 'Wysłano test. Jeśli powiadomienie się nie pojawi, sprawdź uprawnienia systemu i tryb „Nie przeszkadzać”.',
  testUnsupported: 'Ten system nie obsługuje powiadomień systemowych.',
  testFailed: 'Nie udało się wysłać testu. Spróbuj ponownie.',
  testStatus: {
    masterOff: 'Najpierw włącz powiadomienia na tym urządzeniu.',
    checking: 'Sprawdzanie stanu powiadomień w tle…',
    busy: 'Poczekaj na aktualizację ustawień powiadomień.',
    statusFailed: 'Sprawdź stan powiadomień ponownie przed wysłaniem testu.',
    needsSetup: 'Skonfiguruj powiadomienia w tle na tym urządzeniu, aby wysłać test.',
    needsRepair: 'Napraw powiadomienia w tle na tym urządzeniu, aby wysłać test.'
  }
} satisfies TranslationOverride<NotificationSettingsTranslations>

registerAppLocale('pl', {
  endonym: 'Polski',
  englishName: 'Polish',
  translations: { settings: { nav: { notifications: notifications.title }, notifications } }
})
