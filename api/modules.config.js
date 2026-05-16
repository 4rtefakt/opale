// Configuration des modules Opale.
//
// Active/désactive un module en passant `true`/`false`. Désactiver un module
// dont un autre dépend (cf. `requires` dans chaque modules/<X>/index.js) lève
// une erreur claire au démarrage.
//
// `core` est toujours actif et ne peut pas être désactivé.
// `inventory` est core-adjacent : presque tous les autres modules en dépendent.

export const modulesConfig = {
  core:         true,
  inventory:    true,
  monitoring:   true,
  remote:       true,
  tickets:      true,
  onboarding:   true,
  groups:       true,
  // Pont mail ↔ tickets (issue #8). Opt-in via les settings :
  //   - lecture     : mail.poll_enabled + mail.inboxes
  //   - classif IA  : mail.classifier.enabled + url + model
  //   - envoi       : mail.send_enabled + mail.sender_address
  // Tous vides par défaut → le module se charge mais ne fait rien tant
  // qu'on ne configure pas. Pas d'impact si on l'active sans config.
  'email-bridge': true
}
