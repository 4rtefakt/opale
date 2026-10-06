// Statuts d'une demande de matériel, dans l'ordre du parcours. Même liste que
// la contrainte CHECK de la migration 082 et que front/views/materiel.js.
export const STATUSES = [
  'new',              // à traiter
  'quote',            // attente devis
  'awaiting_choice',  // attente du choix du demandeur
  'approval',         // attente validation (budget, facture)
  'to_order',         // à commander
  'ordered',          // commandée
  'received',         // reçue
  'to_prepare',       // à préparer (installation, enrôlement)
  'to_install',       // à installer / à remettre
  'diagnosis',        // diagnostic en cours
  'to_test',          // à tester
  'done',             // terminée
  'cancelled',        // annulée
]

// Statuts qui sortent une demande de la liste des demandes ouvertes.
export const CLOSED_STATUSES = ['done', 'cancelled']

export const PRIORITIES = ['low', 'normal', 'high']
