// Génère la checklist selon le type d'opération et le type de contrat
export function generateChecklist(kind) {
  if (kind === 'offboard') {
    return [
      { step_id: 'disable_account',  label: 'Désactiver le compte Entra ID',  section: 'Accès',         is_auto: true  },
      { step_id: 'revoke_sessions',  label: 'Révoquer les sessions actives',   section: 'Accès',         is_auto: true  },
      { step_id: 'remove_groups',    label: 'Retirer des groupes M365',        section: 'Accès',         is_auto: false },
      { step_id: 'recover_equipment',label: 'Récupérer le matériel',           section: 'Matériel',      is_auto: false },
      { step_id: 'wipe_device',      label: 'Effacer / réinitialiser le poste',section: 'Matériel',      is_auto: false },
      { step_id: 'return_badge',     label: 'Restituer le badge d\'accès',     section: 'Administratif', is_auto: false },
      { step_id: 'final_docs',       label: 'Documents de fin de contrat',     section: 'Administratif', is_auto: false },
      { step_id: 'data_archive',     label: 'Archivage des données',           section: 'Administratif', is_auto: false },
      { step_id: 'notify_teams',     label: 'Informer les équipes',            section: 'Administratif', is_auto: false },
    ]
  }

  // onboard — identique pour tous les types de contrat, ajuster manuellement si besoin
  return [
    { step_id: 'create_account',   label: 'Créer le compte Entra ID',         section: 'Identité',      is_auto: true  },
    { step_id: 'assign_license',   label: 'Attribuer les licences M365',       section: 'Identité',      is_auto: true  },
    { step_id: 'assign_groups',    label: 'Ajouter aux groupes de base',       section: 'Identité',      is_auto: true  },
    { step_id: 'order_equipment',  label: 'Commander l\'équipement',           section: 'Matériel',      is_auto: false },
    { step_id: 'prepare_device',   label: 'Préparer le poste (Intune)',        section: 'Matériel',      is_auto: false },
    { step_id: 'deliver_equipment',label: 'Remettre le matériel',              section: 'Matériel',      is_auto: false },
    { step_id: 'create_netbird',   label: 'Créer l\'accès Netbird/VPN',       section: 'Accès',         is_auto: false },
    { step_id: 'specific_accesses',label: 'Accès applicatifs métier',          section: 'Accès',         is_auto: false },
    { step_id: 'access_badge',     label: 'Badge d\'accès',                   section: 'Administratif', is_auto: false },
    { step_id: 'internal_rules',   label: 'Règlement intérieur signé',        section: 'Administratif', is_auto: false },
    { step_id: 'welcome_email',    label: 'Email de bienvenue envoyé',        section: 'Administratif', is_auto: false },
  ]
}
