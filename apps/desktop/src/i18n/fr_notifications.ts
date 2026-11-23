// Notification settings copy used when the desktop locale loads.
export const frNotifications = {
  title: 'Notifications',
  intro: "Notifications système (pas les toasts de l'application). Par appareil.",
  enableAll: 'Activer les notifications',
  enableAllDesc: 'Désactivé coupe toutes les notifications ci-dessous.',
  focusedHint: 'Les alertes de fin ne se déclenchent que quand Hermes est en arrière-plan.',
  kinds: {
    approval: {
      label: 'Approbation requise',
      description: "Une commande attend que vous l'approuviez ou la rejetiez."
    },
    input: {
      label: 'Saisie requise',
      description: "Hermes a posé une question ou a besoin d'un mot de passe ou d'un secret."
    },
    turnDone: {
      label: 'Réponse prête',
      description: "Un tour s'est terminé pendant que Hermes était en arrière-plan."
    },
    turnError: {
      label: 'Échec du tour',
      description: 'Erreurs de tour en arrière-plan.'
    },
    backgroundDone: {
      label: 'Tâche en arrière-plan terminée',
      description: "Une commande terminal en arrière-plan s'est terminée."
    },
    credits: {
      label: 'Alertes de crédits',
      description: "L'accès aux crédits est suspendu ou rétabli."
    },
    plugin: {
      label: 'Notifications des plugins',
      description: 'Un plugin desktop a envoyé une notification pendant que Hermes était en arrière-plan.'
    }
  },
  browserPermission: {
    title: 'Notifications du navigateur',
    allow: 'Autoriser',
    requestFailed: 'Le navigateur n’a pas pu demander l’autorisation d’afficher des notifications. Vérifiez les paramètres de ce site.',
    states: {
      default:
        "Affiche des alertes de ce navigateur quand l'onglet est en arrière-plan. Tant que vous ne l'autorisez pas, seul le titre de l'onglet clignote.",
      granted:
        "Autorisé. Les alertes s'affichent quand cet onglet est en arrière-plan ; le titre de l'onglet clignote aussi.",
      denied: "Bloqué dans les paramètres du site de ce navigateur. Le titre de l'onglet clignote quand même.",
      insecure: "Nécessite HTTPS, par exemple Tailscale serve. En HTTP simple, seul le titre de l'onglet clignote.",
      unsupported: "Ce navigateur ne peut pas afficher de notifications. Le titre de l'onglet clignote quand même."
    }
  },
  diagnostics: {
    title: "Diagnostic des notifications",
    intro: "Enregistre les décisions sur cette page pendant cinq minutes au maximum. Le rapport reste en mémoire, exclut le contenu des conversations et disparaît au rechargement.",
    frontendBuild: "Version du frontend",
    start: "Démarrer la capture",
    stopAndCopy: "Arrêter et copier le rapport",
    copyReport: "Copier le rapport",
    clear: "Effacer",
    capturing: "Capture en cours.",
    stopped: "Capture arrêtée.",
    expired: "Capture expirée. Le rapport peut être copié.",
    copied: "Rapport copié.",
    copyFailed: "Presse-papiers indisponible. Sélectionnez et copiez le rapport ci-dessous.",
    report: "Rapport de notifications"
  },
  test: 'Envoyer une notification de test',
  testTitle: 'Hermes',
  testBody: 'Les notifications fonctionnent.',
  testSent:
    "Test envoyé. Si rien n'apparaît, vérifiez les autorisations de notification de votre système et le mode Ne pas déranger.",
  testUnsupported: 'Ce système ne prend pas en charge les notifications natives.',
  testFailed: 'La notification de test n’a pas pu être envoyée. Rechargez Hermes et réessayez.',
  muteSoundsTitle: 'Couper les sons de l’interface',
  muteSoundsDesc:
    'Coupe les signaux automatiques de fin, d’activation et de réflexion, le retour haptique et les sons des notifications système. Les aperçus sonores et les réponses vocales restent audibles.',
  completionSoundTitle: 'Son de fin',
  completionSoundDesc: "Se joue à la fin d'un tour d'agent. Choisissez un préréglage et prévisualisez-le ici.",
  completionSoundPreview: 'Aperçu'
}
