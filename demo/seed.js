// Données fictives de la démo publique. Tout est généré à la volée, avec des
// dates relatives à « maintenant » pour que la démo reste vivante (« il y a
// 2 h », « hier »). Aucune donnée réelle : noms, postes et mails inventés.
//
// seed() renvoie un état complet et mutable : le routeur (api.js) le lit et
// le modifie pour un visiteur donné (cookie), puis il est jeté.

const H = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
const D = (d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
const uid = (p, i) => `${p}-${String(i).padStart(3, '0')}`

export const ME = { entraId: 'me', email: 'admin@demo.opale.fr', displayName: 'Camille Roussel', isAdmin: true, jobTitle: 'Responsable IT' }

const PEOPLE = [
  ['Alice Martin', 'Comptable', 'Finance', 'Paris'], ['Karim Benali', 'Chef de projet', 'IT', 'Lyon'],
  ['Nadia Roux', 'Contrôleuse de gestion', 'Finance', 'Paris'], ['Thomas Girard', 'Commercial', 'Ventes', 'Lyon'],
  ['Sophie Durand', 'Développeuse', 'IT', 'Paris'], ['Marc Lefèvre', 'Directeur commercial', 'Ventes', 'Paris'],
  ['Paul Ricard', 'Accueil', 'Services généraux', 'Lyon'], ['Lucie Perrin', 'Responsable RH', 'RH', 'Paris'],
  ['Hugo Blanc', 'Technicien support', 'IT', 'Lyon'], ['Inès Moreau', 'Juriste', 'Direction', 'Paris'],
  ['Yanis Petit', 'Stagiaire marketing', 'Marketing', 'Paris'], ['Chloé Fontaine', 'Cheffe de produit', 'Marketing', 'Lyon'],
  ['Mehdi Garnier', 'Acheteur', 'Achats', 'Lyon'], ['Julie Lambert', 'Assistante de direction', 'Direction', 'Paris'],
  ['Antoine Rey', 'Data analyst', 'Finance', 'Paris'], ['Emma Caron', 'Chargée de recrutement', 'RH', 'Lyon'],
  ['Louis Marchand', 'Ingénieur avant-vente', 'Ventes', 'Paris'], ['Sarah Klein', 'Designer', 'Marketing', 'Paris'],
]
const MODELS = ['Latitude 5540', 'Latitude 7440', 'XPS 13 9340', 'ThinkPad T14 Gen 5', 'Surface Laptop 6', 'OptiPlex 7020']
const OS = ['Windows 11 24H2', 'Windows 11 23H2', 'Windows 11 24H2', 'Windows 10 22H2']

export function seed() {
  const users = PEOPLE.map(([name, job, dept, office], i) => ({
    entra_id: uid('u', i + 1), display_name: name, job_title: job, department: dept, office,
    email: name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(' ', '.') + '@demo.opale.fr',
  }))
  const byName = Object.fromEntries(users.map(u => [u.display_name, u]))

  // ── Postes : 1 par personne + serveurs + postes libres ────────────────────
  const devices = []
  const mk = (i, o) => {
    const disk = o.disk ?? 30 + ((i * 37) % 55)
    const age = o.age ?? (i % 7 === 3 ? 30 : i % 11 === 5 ? 200 : 0.05 + (i % 5) * 0.1)
    const status = age > 168 ? 'offline' : disk >= 90 ? 'critical' : disk >= 80 ? 'warn' : 'online'
    return {
      id: uid('d', i), hostname: o.hostname, model: o.model || MODELS[i % MODELS.length], manufacturer: (o.model || MODELS[i % MODELS.length]).startsWith('ThinkPad') ? 'Lenovo' : (o.model || '').startsWith('Surface') ? 'Microsoft' : 'Dell',
      platform: 'windows', managed_by: null, profile: null, ring: null, last_apply_status: null, last_apply_at: null,
      os: OS[i % OS.length], os_build: '26100.2033', ram_gb: i % 4 === 0 ? 32 : 16, cpu: i % 3 ? 'Intel Core i7-1365U' : 'Intel Core Ultra 7 155U',
      disk_used_pct: disk, user: o.user ? { id: byName[o.user].entra_id, name: o.user, email: byName[o.user].email, job_title: byName[o.user].job_title } : null,
      user_name: o.user || null, assigned_user_id: o.user ? byName[o.user].entra_id : null,
      ip_netbird: `100.64.0.${i + 10}`, agent_version: i % 6 === 0 ? '2.14.0' : '2.15.3', last_seen: H(age), status, serial: `5CG${4000 + i * 7}X`,
      compliance_state: i % 9 === 4 ? 'noncompliant' : 'compliant', join_type: 'azureADJoined', enrolled_at: H(4000 + i * 50), intune_last_sync: H(1 + (i % 6)),
      bios_version: '1.14.0', ssh_host_key_fp: `SHA256:${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}demo`, ssh_host_key_learned_at: H(500), ssh_host_key_policy: 'tofu',
    }
  }
  PEOPLE.forEach(([name], i) => devices.push(mk(i + 1, { hostname: `${['PC', 'LT'][i % 2]}-${name.split(' ')[0].toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}`, user: name, disk: [62, 84, 35, 48, 71, 55, 91, 30, 44, 58, 22, 67, 39, 51, 76, 28, 63, 47][i] })))
  devices.push(mk(19, { hostname: 'SRV-FILES', model: 'PowerEdge R350', disk: 96, age: 0.05 }))
  devices.push(mk(20, { hostname: 'SRV-PRINT', model: 'PowerEdge R250', disk: 41, age: 0.1 }))
  devices.push(mk(21, { hostname: 'PC-ACCUEIL-2', disk: 33, age: 0.3 }))
  devices.push(mk(22, { hostname: 'PC-SALLE-REU', disk: 25, age: 400 }))
  devices.push(mk(23, { hostname: 'LT-PRET-01', disk: 18, age: 0.2 }))
  devices.push(mk(24, { hostname: 'LT-PRET-02', disk: 21, age: 60 }))
  // Deux postes Debian gérés par état désiré (parc Linux) : l'un à jour sur
  // stable, l'autre en pilote avec une application en échec et sans escrow.
  const SHA = (n) => n.toString(16).padStart(2, '0').repeat(20)
  const REV = { head: SHA(0xa1), stable: SHA(0xb2), previous: SHA(0xc3), initial: SHA(0xd4) }
  Object.assign(devices.find(d => d.hostname === 'LT-PRET-02'), {
    platform: 'linux', managed_by: 'pull', os: 'Debian 13', os_build: null,
    profile: 'field-researcher', ring: 'stable', last_apply_status: 'success', last_apply_at: H(1),
    last_revision_applied: REV.stable, last_successful_revision: REV.stable,
    ip_netbird: null, agent_version: null, compliance_state: null, join_type: null, intune_last_sync: null,
    ssh_host_key_fp: null, ssh_host_key_learned_at: null,
  })
  Object.assign(devices.find(d => d.hostname === 'LT-EMMA'), {
    platform: 'linux', managed_by: 'pull', os: 'Debian 13', os_build: null,
    profile: 'office', ring: 'pilot', last_apply_status: 'failed', last_apply_at: H(3),
    last_revision_applied: REV.head, last_successful_revision: REV.previous,
    ip_netbird: null, agent_version: null, compliance_state: null, join_type: null, intune_last_sync: null,
    ssh_host_key_fp: null, ssh_host_key_learned_at: null,
  })
  const dev = (host) => devices.find(d => d.hostname === host)

  const tags = [
    { id: 'tag-reseau', name: 'réseau', color: 'blue' }, { id: 'tag-urgent', name: 'urgent', color: 'red' },
    { id: 'tag-materiel', name: 'matériel', color: 'amber' }, { id: 'tag-acces', name: 'accès', color: 'violet' },
    { id: 'tag-impression', name: 'impression', color: 'teal' },
  ]
  const tag = (...names) => tags.filter(t => names.includes(t.name))

  // ── Tickets ────────────────────────────────────────────────────────────────
  let msgSeq = 0
  const msg = (type, author, content, hoursAgo, extra = {}) => ({ id: `m-${++msgSeq}`, type, author, content, created_at: H(hoursAgo), email_sent_at: type === 'comment' ? H(hoursAgo) : null, ...extra })
  const T = []
  const ticket = (i, o) => {
    const requester = o.requester ? byName[o.requester] : null
    const device = o.device ? dev(o.device) : null
    const messages = o.messages
    const last = [...messages].reverse().find(m => m.type !== 'system')
    const tk = {
      id: `t-${String(i).padStart(4, '0')}`, title: o.title, description: o.description || '', status: o.status, priority: o.priority || 'normal',
      created_at: H(o.age), updated_at: H(o.updated ?? o.age), resolved_at: o.status === 'resolved' || o.status === 'closed' ? H(o.updated ?? o.age) : null,
      requester_name: requester?.display_name || null, requester_email: requester?.email || null, user_id: requester?.entra_id || null,
      hostname: device?.hostname || null, device_id: device?.id || null,
      assigned_to_name: o.assigned === 'me' ? ME.displayName : o.assigned ? byName[o.assigned].display_name : null,
      assigned_to_entra_id: o.assigned === 'me' ? ME.entraId : o.assigned ? byName[o.assigned].entra_id : null,
      is_auto: !!o.auto, source: o.source || (o.auto ? 'alert' : o.mail ? 'email' : 'manual'), created_by_name: o.auto ? 'Opale' : ME.displayName,
      has_inbound_mail: !!o.mail, inbound_mail_count: o.mail ? messages.filter(m => m.type === 'comment' && m.author !== ME.displayName).length : 0,
      outbound_mail_count: o.mail ? messages.filter(m => m.type === 'comment' && m.author === ME.displayName).length : 0,
      mail_authors: o.mail && requester ? [requester.display_name, requester.email] : [],
      tags: o.tags || [], related_users: requester ? [{ entra_id: requester.entra_id, display_name: requester.display_name, email: requester.email, role: 'requester' }] : [],
      related_devices: device ? [{ id: device.id, hostname: device.hostname }] : [], attachments: o.attachments || [], messages,
      awaiting_reply: ['open', 'in_progress'].includes(o.status) && !!last && last.author !== ME.displayName,
    }
    T.push(tk)
  }
  ticket(1, { title: 'Imprimante du 2e étage bloquée — erreur E-52 récurrente depuis ce matin', status: 'open', priority: 'high', age: 27, updated: 2.5, requester: 'Alice Martin', device: 'PC-ALICE', mail: true, tags: tag('impression', 'urgent'),
    description: 'Fil de 3 mails — premier mail d\'Alice Martin hier matin.', attachments: [{ id: 'att-1', filename: 'capture-erreur-E52.png', size_bytes: 184320, created_at: H(27) }],
    messages: [
      msg('comment', 'Alice Martin', 'Bonjour,\n\nDepuis ce matin l\'imprimante du 2e étage affiche une erreur E-52 et refuse toute impression. J\'ai redémarré deux fois sans succès.\n\nMerci d\'avance,\nAlice', 27),
      msg('comment', ME.displayName, 'Bonjour Alice, pouvez-vous me dire si le voyant orange clignote ou reste fixe ?', 25),
      msg('internal_note', ME.displayName, 'Probablement le capteur du bac 2 (déjà vu sur ce modèle). Prévoir passage avec un chiffon sec.', 24),
      msg('comment', 'Alice Martin', 'Il clignote. Et maintenant l\'écran affiche « bourrage bac 2 » alors qu\'il n\'y a rien dedans.', 2.5),
    ] })
  ticket(2, { title: 'VPN qui tombe toutes les 10 minutes', status: 'in_progress', age: 75, updated: 5, requester: 'Karim Benali', device: 'LT-KARIM', assigned: 'me', mail: true, tags: tag('réseau'),
    messages: [
      msg('comment', 'Karim Benali', 'Le VPN se coupe toutes les 10 minutes environ depuis la mise à jour de lundi. Je dois me reconnecter à chaque fois.', 75),
      msg('system', ME.displayName, 'Ticket pris en charge', 70),
      msg('comment', ME.displayName, 'Je viens de pousser un correctif du client VPN sur votre poste. Pouvez-vous me confirmer demain si les coupures persistent ?', 30),
      msg('comment', 'Karim Benali', 'Toujours une coupure ce matin vers 9h15, mais une seule en 3 heures. Ça va mieux.', 5),
    ] })
  ticket(3, { title: 'Disque C: à 96 % sur SRV-FILES', status: 'open', priority: 'critical', age: 22, device: 'SRV-FILES', auto: true,
    description: 'Alerte disque critique : 96 % utilisés (seuil 90 %).', messages: [msg('system', 'Opale', 'Ticket créé automatiquement (alerte disque_critical)', 22)] })
  ticket(4, { title: 'Serveur de fichiers injoignable depuis le 1er étage', status: 'open', priority: 'critical', age: 0.6, requester: 'Nadia Roux', device: 'SRV-FILES', mail: true,
    messages: [msg('comment', 'Nadia Roux', 'Bonjour, plus personne au 1er étage n\'arrive à ouvrir le lecteur P:. Message « chemin réseau introuvable ». Urgent, on clôture la paie.', 0.6)] })
  ticket(5, { title: 'Outlook demande le mot de passe en boucle', status: 'in_progress', age: 30, updated: 6, requester: 'Thomas Girard', device: 'PC-THOMAS', assigned: 'me', mail: true, tags: tag('accès'),
    messages: [
      msg('comment', 'Thomas Girard', 'Outlook me redemande mon mot de passe toutes les 5 minutes, même quand je le saisis correctement.', 30),
      msg('comment', ME.displayName, 'Bonjour Thomas, j\'ai réinitialisé les identifiants mis en cache. Pouvez-vous fermer Outlook, le rouvrir et me dire si ça persiste ?', 6),
    ] })
  ticket(6, { title: 'Nouveau poste pour la stagiaire marketing', status: 'open', priority: 'low', age: 20, requester: 'Chloé Fontaine', assigned: 'me',
    description: 'Arrivée de Yanis le 1er octobre. Prévoir un portable de prêt en attendant la commande.',
    messages: [msg('comment', ME.displayName, 'Portable LT-PRET-01 réservé, Autopilot lancé. Reste le badge.', 20)] })
  ticket(7, { title: 'Demande d\'accès au dossier partagé Compta', status: 'resolved', priority: 'low', age: 200, updated: 180, requester: 'Antoine Rey', assigned: 'me', tags: tag('accès'),
    messages: [msg('comment', 'Antoine Rey', 'Pourrais-je avoir accès en lecture au dossier Compta\\Clôtures ? Validé par Nadia.', 200), msg('comment', ME.displayName, 'C\'est fait, accès en lecture accordé.', 180), msg('resolution', ME.displayName, 'Ticket résolu', 180)] })
  ticket(8, { title: 'Écran externe non détecté sur la station d\'accueil', status: 'open', priority: 'normal', age: 50, updated: 3, requester: 'Sophie Durand', device: 'PC-SOPHIE', mail: true, tags: tag('matériel'),
    messages: [msg('comment', 'Sophie Durand', 'Depuis ce matin mon deuxième écran reste noir sur la station d\'accueil. Le câble est bien branché.', 50), msg('comment', ME.displayName, 'Pouvez-vous essayer l\'autre port DisplayPort de la station ?', 40), msg('comment', 'Sophie Durand', 'Essayé, toujours rien. Le voyant de la station clignote en orange.', 3)] })
  ticket(9, { title: 'Teams : micro coupé en réunion (casque Jabra)', status: 'resolved', age: 400, updated: 380, requester: 'Marc Lefèvre', device: 'PC-MARC', assigned: 'Hugo Blanc',
    messages: [msg('comment', 'Marc Lefèvre', 'Mes interlocuteurs ne m\'entendent plus après 2 minutes de réunion.', 400), msg('comment', 'Hugo Blanc', 'Firmware du casque mis à jour et périphérique par défaut corrigé.', 380), msg('resolution', 'Hugo Blanc', 'Ticket résolu', 380)] })
  ticket(10, { title: 'Licence Adobe Acrobat expirée', status: 'open', priority: 'normal', age: 8, requester: 'Inès Moreau', device: 'LT-INES', mail: true,
    messages: [msg('comment', 'Inès Moreau', 'Acrobat m\'indique que la licence a expiré, je ne peux plus signer les contrats.', 8)] })
  ticket(11, { title: 'Wi-Fi lent en salle de réunion B', status: 'open', priority: 'normal', age: 120, updated: 100, requester: 'Julie Lambert', assigned: 'Hugo Blanc', tags: tag('réseau'),
    messages: [msg('comment', 'Julie Lambert', 'Les visios en salle B se figent régulièrement.', 120), msg('comment', 'Hugo Blanc', 'Borne repositionnée, on surveille cette semaine.', 100)] })
  ticket(12, { title: 'Poste PC-ACCUEIL-2 à préparer pour le remplaçant', status: 'closed', priority: 'low', age: 900, updated: 800, requester: 'Paul Ricard', device: 'PC-ACCUEIL-2', assigned: 'me',
    messages: [msg('comment', ME.displayName, 'Poste réinitialisé et enrôlé.', 800), msg('resolution', ME.displayName, 'Ticket résolu', 800)] })
  ticket(13, { title: 'Mot de passe oublié — Emma Caron', status: 'resolved', priority: 'high', age: 60, updated: 59, requester: 'Emma Caron', assigned: 'me', tags: tag('accès'),
    messages: [msg('comment', 'Emma Caron', 'Je suis bloquée, compte verrouillé après plusieurs essais.', 60), msg('comment', ME.displayName, 'Compte déverrouillé et mot de passe temporaire envoyé par SMS.', 59), msg('resolution', ME.displayName, 'Ticket résolu', 59)] })
  ticket(14, { title: 'Clavier qui double les touches', status: 'open', priority: 'low', age: 140, requester: 'Mehdi Garnier', device: 'LT-MEHDI', tags: tag('matériel'),
    messages: [msg('comment', 'Mehdi Garnier', 'Les touches e et a s\'écrivent en double par moments.', 140)] })
  ticket(15, { title: 'Mise à jour Windows bloquée à 35 %', status: 'in_progress', priority: 'normal', age: 15, updated: 4, requester: 'Louis Marchand', device: 'PC-LOUIS', assigned: 'me', mail: true,
    messages: [msg('comment', 'Louis Marchand', 'Le poste redémarre en boucle sur la mise à jour, bloqué à 35 %.', 15), msg('comment', ME.displayName, 'Je lance le script de réparation Windows Update à distance, comptez 20 minutes.', 4)] })
  ticket(16, { title: 'Onboarding : compte et matériel pour Sarah Klein', status: 'resolved', priority: 'normal', age: 700, updated: 650, requester: 'Lucie Perrin', assigned: 'me',
    messages: [msg('comment', ME.displayName, 'Compte créé, portable livré, badge remis.', 650), msg('resolution', ME.displayName, 'Ticket résolu', 650)] })
  ticket(17, { title: 'Impossible d\'imprimer en recto-verso', status: 'closed', priority: 'low', age: 1200, updated: 1100, requester: 'Paul Ricard', tags: tag('impression'),
    messages: [msg('comment', ME.displayName, 'Pilote remplacé par le pilote universel.', 1100), msg('resolution', ME.displayName, 'Ticket résolu', 1100)] })

  // ── Mails à trier (fils) ───────────────────────────────────────────────────
  const inbox = []
  const mail = (id, o) => inbox.push({ id, mailbox: 'support@demo.opale.fr', from_address: o.from, from_name: o.name, subject: o.subject, received_at: H(o.age), conversation_id: o.conv, thread_count: o.count || 1, body_preview: o.preview, body_text: o.body || o.preview,
    classifier_result: o.intent ? { intent: o.intent, confidence: 0.88, reason: 'demande de support' } : null, suggested_user_id: o.user ? byName[o.user].entra_id : null, suggested_user_name: o.user || null,
    suggested_device_id: o.user && dev(`PC-${o.user.split(' ')[0].toUpperCase()}`) ? dev(`PC-${o.user.split(' ')[0].toUpperCase()}`).id : null, suggested_device_hostname: o.user && dev(`PC-${o.user.split(' ')[0].toUpperCase()}`) ? `PC-${o.user.split(' ')[0].toUpperCase()}` : null,
    has_attachments: !!o.att, direction: 'inbound', action: 'pending_review' })
  mail('mail-001', { from: 'antoine.rey@demo.opale.fr', name: 'Antoine Rey', subject: 'Excel plante à l\'ouverture du fichier budget', conv: 'conv-budget', count: 2, age: 16, user: 'Antoine Rey', intent: 'new_ticket', preview: 'Bonjour, depuis hier le fichier Budget_2027.xlsx fait planter Excel dès l\'ouverture…', body: 'Bonjour,\n\nDepuis hier le fichier Budget_2027.xlsx fait planter Excel dès l\'ouverture. Sur le poste de Nadia il s\'ouvre correctement.\n\nAntoine' })
  mail('mail-002', { from: 'antoine.rey@demo.opale.fr', name: 'Antoine Rey', subject: 'RE: Excel plante à l\'ouverture du fichier budget', conv: 'conv-budget', count: 2, age: 3, user: 'Antoine Rey', intent: 'new_ticket', att: true, preview: 'Je joins la capture du message d\'erreur. C\'est bloquant pour la clôture.', body: 'Je joins la capture du message d\'erreur. C\'est bloquant pour la clôture de vendredi.\n\nAntoine' })
  mail('mail-003', { from: 'emma.caron@demo.opale.fr', name: 'Emma Caron', subject: 'Accès au SIRH pour la nouvelle alternante', conv: 'conv-sirh', age: 9, user: 'Emma Caron', intent: 'new_ticket', preview: 'Pourriez-vous créer un accès SIRH en lecture pour Léa (arrivée lundi) ?', body: 'Bonjour,\n\nPourriez-vous créer un accès SIRH en lecture pour Léa, alternante RH qui arrive lundi ?\n\nMerci,\nEmma' })
  mail('mail-004', { from: 'newsletter@fournisseur-it.example', name: 'Fournisseur IT', subject: 'Nos offres de rentrée : -20 % sur les écrans', conv: 'conv-promo', age: 40, intent: 'other', preview: 'Découvrez nos nouvelles promotions sur les écrans 27" et les stations d\'accueil…' })
  mail('mail-005', { from: 'sarah.klein@demo.opale.fr', name: 'Sarah Klein', subject: 'Figma très lent depuis ce matin', conv: 'conv-figma', age: 1.2, user: 'Sarah Klein', intent: 'new_ticket', preview: 'Figma met 30 secondes à ouvrir un fichier, même les petits. Chrome ou l\'app, pareil.', body: 'Bonjour,\n\nFigma met 30 secondes à ouvrir un fichier, même les petits. Chrome ou l\'application, c\'est pareil. Mon collègue n\'a pas le problème.\n\nSarah' })

  const proposals = [
    { id: 'prop-1', source: 'alert', status: 'pending', suggested_title: 'PC-PAUL — disque à 91 %', suggested_priority: 'high', suggested_description: 'Alerte disque_high sur PC-PAUL (91 %, seuil 90 %). Ouvrir un ticket pour planifier un nettoyage.', created_at: H(4), device_id: dev('PC-PAUL')?.id, hostname: 'PC-PAUL' },
  ]

  // ── Alertes (dérivées des postes) ──────────────────────────────────────────
  const snoozes = [{ id: 'snz-1', device_id: dev('LT-KARIM').id, alert_type: 'disk_high', until_at: H(-72), reason: 'Nettoyage prévu vendredi', by_name: ME.displayName, created_at: H(20) }]

  const scripts = [
    { id: 'sc-1', name: 'Vider le cache Teams', description: 'Supprime %appdata%/Teams/Cache et relance Teams.', category: 'Bureautique', shell_type: 'powershell', is_builtin: true, exec_count: 64, last_run: H(30), code: 'Stop-Process -Name Teams -Force -ErrorAction SilentlyContinue\nRemove-Item "$env:APPDATA\\Microsoft\\Teams\\Cache\\*" -Recurse -Force\nStart-Process teams' },
    { id: 'sc-2', name: 'Redémarrer le spouleur', description: 'Restart-Service Spooler', category: 'Impression', shell_type: 'powershell', is_builtin: true, exec_count: 12, last_run: H(200), code: 'Restart-Service Spooler' },
    { id: 'sc-3', name: 'Réparer Windows Update', description: 'Réinitialise les composants Windows Update.', category: 'Maintenance', shell_type: 'powershell', is_builtin: true, exec_count: 9, last_run: H(4), code: 'Stop-Service wuauserv, bits\nRemove-Item "$env:WINDIR\\SoftwareDistribution\\*" -Recurse -Force\nStart-Service bits, wuauserv' },
    { id: 'sc-4', name: 'Nettoyage disque', description: 'Vide la corbeille et les temporaires.', category: 'Maintenance', shell_type: 'powershell', is_builtin: false, by_name: ME.displayName, exec_count: 5, last_run: H(500), code: 'Clear-RecycleBin -Force\nRemove-Item "$env:TEMP\\*" -Recurse -Force -ErrorAction SilentlyContinue' },
    { id: 'sc-5', name: 'Inventaire logiciels', description: 'Liste les programmes installés (winget list).', category: 'Inventaire', shell_type: 'powershell', is_builtin: false, by_name: 'Hugo Blanc', exec_count: 21, last_run: H(80), code: 'winget list --accept-source-agreements' },
  ]
  const executions = devices.slice(0, 12).flatMap((d, i) => [
    { id: `ex-${i}-1`, device_id: d.id, hostname: d.hostname, script_id: 'sc-1', script_name: 'Vider le cache Teams', by_name: ME.displayName, status: 'done', output: 'Cache supprimé (412 Mo)', queued_at: H(30 + i * 9), completed_at: H(29 + i * 9) },
    ...(i % 3 === 0 ? [{ id: `ex-${i}-2`, device_id: d.id, hostname: d.hostname, script_id: 'sc-2', script_name: 'Redémarrer le spouleur', by_name: 'Hugo Blanc', status: 'error', output: 'Restart-Service : accès refusé', queued_at: H(200 + i * 3), completed_at: H(199 + i * 3) }] : []),
  ])

  const packages = [
    { id: 'pk-1', name: 'Google Chrome', type: 'winget', winget_id: 'Google.Chrome', status: 'approved', version: '130.0', description: 'Navigateur par défaut, mis à jour automatiquement sur tous les postes.', approved_by_name: ME.displayName, approved_at: H(900), created_at: H(2000) },
    { id: 'pk-2', name: '7-Zip', type: 'winget', winget_id: '7zip.7zip', status: 'approved', version: '24.08', description: '', approved_by_name: ME.displayName, approved_at: H(1500), created_at: H(2000) },
    { id: 'pk-3', name: 'Agent de sauvegarde', type: 'script', status: 'draft', version: '1.2', description: 'Installe l\'agent de sauvegarde et enregistre le poste.', install_script: 'Start-Process msiexec -ArgumentList "/i backup-agent.msi /qn" -Wait', detection_script: 'if (Get-Service BackupAgent -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }', created_at: H(300) },
    { id: 'pk-4', name: 'Adobe Acrobat Reader', type: 'winget', winget_id: 'Adobe.Acrobat.Reader.64-bit', status: 'approved', version: '24.3', description: '', approved_by_name: 'Hugo Blanc', approved_at: H(600), created_at: H(700) },
  ]
  let dpSeq = 0
  const deployments = []
  const dp = (pkgId, d, status, age, extra = {}) => deployments.push({ id: `dp-${++dpSeq}`, package_id: pkgId, package_name: packages.find(p => p.id === pkgId).name, device_id: d.id, hostname: d.hostname, assigned_user_name: d.user_name, status, exit_code: status === 'success' ? 0 : status === 'failed' ? 1603 : null, deployed_by_name: extra.by || 'auto', created_at: H(age + 1), queued_at: H(age + 1), completed_at: ['success', 'failed'].includes(status) ? H(age) : null, output: status === 'success' ? 'Successfully installed' : status === 'failed' ? 'winget: installer hash mismatch' : null, job_id: 'job-1' })
  devices.forEach((d, i) => { dp('pk-1', d, i === 5 ? 'failed' : i === 8 ? 'running' : i === 11 ? 'pending' : 'success', 200 + i * 4); dp('pk-2', d, 'success', 400 + i * 2); if (i % 2) dp('pk-4', d, i === 7 ? 'failed' : 'success', 100 + i) })

  const stock = [
    { id: 'st-1', name: 'Souris sans fil Logitech M185', category: 'Périphériques', quantity: 12, threshold: 4, unit: 'pcs', last_movement_at: H(5) },
    { id: 'st-2', name: 'Câble HDMI 2 m', category: 'Câbles', quantity: 3, threshold: 5, unit: 'pcs', last_movement_at: H(40) },
    { id: 'st-3', name: 'Chargeur USB-C 65 W', category: 'Alimentation', quantity: 0, threshold: 2, unit: 'pcs', last_movement_at: H(120) },
    { id: 'st-4', name: 'Casque Jabra Evolve2 40', category: 'Périphériques', quantity: 6, threshold: 2, unit: 'pcs', last_movement_at: H(300) },
    { id: 'st-5', name: 'Écran Dell 24"', category: 'Écrans', quantity: 2, threshold: 1, unit: 'pcs', last_movement_at: null },
    { id: 'st-6', name: 'Station d\'accueil WD19S', category: 'Périphériques', quantity: 4, threshold: 2, unit: 'pcs', last_movement_at: H(700) },
  ]
  const movements = { 'st-1': [{ id: 'mv-1', type: 'out', quantity: 1, by_name: ME.displayName, recipient_name: 'Sophie Durand', note: 'Onboarding', created_at: H(5) }, { id: 'mv-2', type: 'in', quantity: 10, by_name: ME.displayName, note: 'Commande LDLC', created_at: H(200) }] }

  const groups = [
    { id: 'g-1', name: 'Finance', color: 'green', source: 'entra', entra_group_id: 'entra-finance', description: 'Service financier', created_at: H(3000) },
    { id: 'g-2', name: 'Portables', color: 'blue', source: 'native', description: 'Tous les portables', created_at: H(2500) },
    { id: 'g-3', name: 'Direction', color: 'violet', source: 'native', description: 'Postes VIP', created_at: H(2500) },
    { id: 'g-4', name: 'Stagiaires', color: 'amber', source: 'native', description: '', created_at: H(900) },
  ]
  const groupMembers = {
    'g-1': users.filter(u => u.department === 'Finance').map(u => ({ member_id: `gm-${u.entra_id}`, user_id: u.entra_id, display_name: u.display_name, email: u.email })),
    'g-2': devices.filter(d => d.hostname.startsWith('LT-')).map(d => ({ member_id: `gm-${d.id}`, device_id: d.id, hostname: d.hostname, os: d.os })),
    'g-3': devices.filter(d => ['PC-MARC', 'LT-INES', 'PC-JULIE'].includes(d.hostname)).map(d => ({ member_id: `gm-${d.id}`, device_id: d.id, hostname: d.hostname, os: d.os })),
    'g-4': devices.filter(d => ['LT-PRET-01', 'LT-PRET-02', 'PC-YANIS'].includes(d.hostname)).map(d => ({ member_id: `gm-${d.id}`, device_id: d.id, hostname: d.hostname, os: d.os })),
  }

  const onboardings = [
    { id: 'ob-1', person_name: 'Léa Bernard', kind: 'onboard', status: 'in_progress', contract_type: 'Alternant.e', start_date: D(-3), email: 'lea.bernard@demo.opale.fr', role: 'Alternante RH', department: 'RH', manager_name: 'Lucie Perrin', notes: 'Portable de prêt en attendant la commande.', by_name: ME.displayName, created_at: H(100), entra_id_created: null,
      checks: [
        { id: 'c1', section: 'Compte', label: 'Créer le compte Entra', done: true, is_auto: true, done_by: ME.displayName, done_at: H(90) },
        { id: 'c2', section: 'Compte', label: 'Ajouter aux groupes de sécurité', done: true, is_auto: true, done_by: ME.displayName, done_at: H(90) },
        { id: 'c3', section: 'Compte', label: 'Licence Microsoft 365', done: false, is_auto: true },
        { id: 'c4', section: 'Matériel', label: 'Préparer le poste (Autopilot)', done: true, is_auto: false, done_by: ME.displayName, done_at: H(50) },
        { id: 'c5', section: 'Matériel', label: 'Casque + écran', done: false, is_auto: false },
        { id: 'c6', section: 'Matériel', label: 'Badge d\'accès', done: false, is_auto: false },
        { id: 'c7', section: 'Accueil', label: 'Mail de bienvenue', done: true, is_auto: false, done_by: ME.displayName, done_at: H(40) },
        { id: 'c8', section: 'Accueil', label: 'Présentation outils (30 min)', done: false, is_auto: false },
      ] },
    { id: 'ob-2', person_name: 'Marc Lefèvre', kind: 'offboard', status: 'in_progress', contract_type: 'CDI', start_date: D(-10), end_date: D(-10), email: 'marc.lefevre@demo.opale.fr', role: 'Directeur commercial', department: 'Ventes', manager_name: 'Inès Moreau', notes: '', by_name: ME.displayName, created_at: H(60), entra_id_created: null,
      checks: [
        { id: 'c1', section: 'Compte', label: 'Désactiver le compte Entra', done: false, is_auto: true },
        { id: 'c2', section: 'Compte', label: 'Transférer la boîte mail', done: false, is_auto: false },
        { id: 'c3', section: 'Matériel', label: 'Récupérer le portable', done: true, is_auto: false, done_by: ME.displayName, done_at: H(20) },
        { id: 'c4', section: 'Matériel', label: 'Récupérer le badge', done: false, is_auto: false },
      ] },
    { id: 'ob-3', person_name: 'Yanis Petit', kind: 'onboard', status: 'done', contract_type: 'Stagiaire', start_date: D(25), email: 'yanis.petit@demo.opale.fr', role: 'Stagiaire marketing', department: 'Marketing', manager_name: 'Chloé Fontaine', notes: '', by_name: 'Hugo Blanc', created_at: H(700), entra_id_created: 'u-011',
      checks: [{ id: 'c1', section: 'Compte', label: 'Créer le compte Entra', done: true, is_auto: true, done_by: 'Hugo Blanc', done_at: H(690) }, { id: 'c2', section: 'Matériel', label: 'Préparer le poste (Autopilot)', done: true, is_auto: false, done_by: 'Hugo Blanc', done_at: H(650) }, { id: 'c3', section: 'Accueil', label: 'Mail de bienvenue', done: true, is_auto: false, done_by: 'Hugo Blanc', done_at: H(640) }] },
  ]

  const reviews = [
    { id: 'rv-1', title: 'Point informatique — septembre', period_start: D(28), period_end: D(0), created_by_name: ME.displayName, created_by_entra_id: ME.entraId, created_at: H(30), updated_at: H(10),
      snapshot: { generated_at: H(30), period_days: 28, email: { days: 28, total: 61, by_action: { pending_review: 5, message_appended: 40, skipped_other: 16 } }, counts: { tickets_created: 23, proposals_pending: 1, inbox_pending: 5 } },
      sections: [{ heading: 'Faits marquants', body: 'Migration du serveur de fichiers terminée. Deux incidents réseau au 1er étage, causés par une borne défaillante (remplacée).' }, { heading: 'Sécurité', body: 'BitLocker actif sur 92 % du parc. Deux postes à régulariser (PC-PAUL, SRV-FILES).' }, { heading: 'Projets du mois prochain', body: 'Déploiement de l\'agent de sauvegarde, renouvellement des portables 2021.' }] },
    { id: 'rv-2', title: 'Point informatique — août', period_start: D(60), period_end: D(28), created_by_name: ME.displayName, created_by_entra_id: ME.entraId, created_at: H(700), updated_at: H(700),
      snapshot: { generated_at: H(700), period_days: 31, email: { days: 31, total: 42, by_action: { pending_review: 2, message_appended: 30, skipped_other: 10 } }, counts: { tickets_created: 17, proposals_pending: 0, inbox_pending: 2 } },
      sections: [{ heading: 'Faits marquants', body: 'Période calme, 17 tickets, aucun incident majeur.' }] },
  ]

  const audit = [
    { id: 'au-1', action: 'ssh_open', by_user: ME.displayName, by_user_entra_id: ME.entraId, target: 'LT-KARIM', device_id: dev('LT-KARIM').id, device_hostname: 'LT-KARIM', device_user_name: 'Karim Benali', details: { reason: { category: 'troubleshoot', note: 'VPN instable' }, host: 'LT-KARIM', ip: dev('LT-KARIM').ip_netbird }, created_at: H(0.5) },
    { id: 'au-2', action: 'ssh_close', by_user: ME.displayName, by_user_entra_id: ME.entraId, target: 'LT-KARIM', device_id: dev('LT-KARIM').id, device_hostname: 'LT-KARIM', details: { duration_seconds: 754 }, created_at: H(0.3) },
    { id: 'au-3', action: 'package_deployed', by_user: ME.displayName, by_user_entra_id: ME.entraId, target: 'Google Chrome', details: { devices: 24 }, created_at: H(3) },
    { id: 'au-4', action: 'intune_sync', by_user: 'système', details: { upserted: 24, errors: 0 }, created_at: H(6) },
    { id: 'au-5', action: 'laps_rotated', by_user: 'agent', target: 'PC-PAUL', device_id: dev('PC-PAUL').id, device_hostname: 'PC-PAUL', details: {}, created_at: H(9) },
    { id: 'au-6', action: 'setup_script', by_user: ME.displayName, by_user_entra_id: ME.entraId, target: 'PC-LOUIS', device_id: dev('PC-LOUIS').id, device_hostname: 'PC-LOUIS', details: { script: 'Réparer Windows Update' }, created_at: H(4) },
    { id: 'au-7', action: 'token_created', by_user: ME.displayName, by_user_entra_id: ME.entraId, target: 'cli-laptop', details: {}, created_at: H(30) },
    { id: 'au-8', action: 'agent_checkin', by_user: 'agent', target: 'SRV-FILES', device_id: dev('SRV-FILES').id, device_hostname: 'SRV-FILES', details: { version: '2.15.3' }, created_at: H(0.1) },
    { id: 'au-9', action: 'ticket_created', by_user: 'Opale', target: 'Disque C: à 96 % sur SRV-FILES', details: { source: 'alert' }, created_at: H(22) },
    { id: 'au-10', action: 'device_deleted', by_user: ME.displayName, by_user_entra_id: ME.entraId, target: 'PC-OLD-12', details: {}, created_at: H(50) },
    { id: 'au-11', action: 'group_member_added', by_user: ME.displayName, by_user_entra_id: ME.entraId, target: 'Stagiaires', details: { target: 'device:LT-PRET-02' }, created_at: H(70) },
    { id: 'au-12', action: 'mail_ingest_blocked', by_user: 'worker', details: { since: H(2), attempts: 3, error: 'timeout Graph' }, created_at: H(2) },
  ]

  const settings = {
    settings: { 'org.name': 'Démo Opale', 'app.product_name': 'Opale', 'app.tagline': 'Open RMM platform', 'app.default_role_label': 'IT', 'users.filter_attribute': '', 'users.filter_value': '', disk_warn_pct: '80', disk_critical_pct: '90', agent_offline_days: '7', compliance_alerts_enabled: 'true', cost_per_hour: '22.54', 'agent.laps_recovery_username': 'opale-recovery', 'mail.inboxes': 'support@demo.opale.fr', 'mail.poll_enabled': 'true', 'mail.send_enabled': 'true', 'mail.sender_address': 'support@demo.opale.fr', 'mail.classifier.enabled': 'true', 'mail.classifier.model': 'mistral-small', 'ask.enabled': 'true', 'ask.provider': 'mistral', 'ask.model': 'mistral-small' },
    tokens: [{ id: 'tk-1', label: 'Bootstrap 2026', hostname: null, created_at: H(900), created_by: ME.displayName, last_used_at: H(3), revoked_at: null }, { id: 'tk-2', label: 'Ancien token', hostname: 'PC-OLD-12', created_at: H(5000), created_by: ME.displayName, last_used_at: H(3000), revoked_at: H(2000) }],
    ssh_keys: [{ id: 'k-1', label: 'camille@laptop', public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyDemoKeyDemoKeyDemoKeyDemoKey camille@laptop', created_at: H(1500), created_by: ME.displayName }],
    cli_tokens: [{ id: 'c-1', label: 'cli-laptop', owner_name: ME.displayName, entra_id: ME.entraId, created_at: H(30), expires_at: H(-700), last_used_at: H(1), revoked_at: null }],
    admins: [{ entra_id: ME.entraId, display_name: ME.displayName, email: ME.email, is_admin: true }, { entra_id: byName['Hugo Blanc'].entra_id, display_name: 'Hugo Blanc', email: byName['Hugo Blanc'].email, is_admin: true }],
  }

  // ── Parc Linux : clés des postes, file d'enrôlement, pré-inscriptions,
  //    rapports d'application, clés de récupération, miroir git, réglages ──
  const ESCROW_KEY_ID = '0f3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c'
  const fp = (seed) => seed.repeat(8).slice(0, 64)
  const key = (id, backing, seed, extra = {}) => ({ id, fingerprint: fp(seed), key_backing: backing, status: 'approved', agent_version: '0.3.1', os_version: 'Debian GNU/Linux 13 (trixie)', last_seen_at: H(0.2), approved_at: H(400), approved_by: ME.displayName, revoked_at: null, revoked_by: null, revoke_reason: null, luks_root: true, ...extra })
  const report = (id, revision, status, age, extra = {}) => ({ id, revision, status, started_at: H(age + 0.02), finished_at: H(age), error_summary: null, log_tail: null, agent_version: '0.3.1', received_at: H(age), ...extra })
  const linux = {
    keys: {
      [dev('LT-PRET-02').id]: key('lk-1', 'tpm', '3f9a1c22'),
      [dev('LT-EMMA').id]: key('lk-2', 'software', '7c0d21aa', { last_seen_at: H(3.1) }),
    },
    enrollments: [
      { id: 'en-1', fingerprint: fp('9e4b77c1'), code: '9e4b77c1', key_backing: 'software', serial_claimed: '5CG4990X', hostname_claimed: 'debian', os_version: 'Debian GNU/Linux 13 (trixie)', agent_version: '0.3.1', status: 'pending', source: 'manual', conflict: null, preregistration: null, device_id: null, first_seen_at: H(1.5), last_seen_at: H(0.05), enroll_attempts: 9, approved_at: null, approved_by: null, rejected_at: null, rejected_by: null, revoked_at: null, revoked_by: null, revoke_reason: null },
    ],
    preregistrations: [
      { id: 'pr-1', serial: 'PF3ABC12', hostname: 'lx-yanis', profile: 'office', ring: 'stable', assigned_user: { entra_id: byName['Yanis Petit'].entra_id, display_name: 'Yanis Petit', email: byName['Yanis Petit'].email }, note: 'Portable de prêt en attendant la commande', created_by: ME.displayName, created_at: H(48), consumed_at: null, consumed_by_key_id: null, matches_device: null },
    ],
    reports: {
      [dev('LT-PRET-02').id]: [report('rp-1', REV.stable, 'skipped', 1), report('rp-2', REV.stable, 'success', 25), report('rp-3', REV.previous, 'success', 73)],
      [dev('LT-EMMA').id]: [
        report('rp-4', REV.head, 'failed', 3, { error_summary: 'TASK [office : install printer driver] — apt: Unable to locate package hplip-plugin', log_tail: 'PLAY [localhost] *********************************************************\n\nTASK [base : apt update] ***************************************************\nok: [localhost]\n\nTASK [office : install printer driver] ************************************\nfatal: [localhost]: FAILED! => {"msg": "No package matching \'hplip-plugin\' is available"}\n\nPLAY RECAP ****************************************************************\nlocalhost : ok=1 changed=0 unreachable=0 failed=1 skipped=0' }),
        report('rp-5', REV.previous, 'success', 27), report('rp-6', REV.previous, 'success', 51),
      ],
    },
    recoveryKeys: {
      [dev('LT-PRET-02').id]: [{ id: 'rk-1', kind: 'luks_recovery', label: '/', key_id: ESCROW_KEY_ID, created_at: H(300), superseded_at: null, current: true, last_viewed_at: H(100), last_viewed_by_name: 'Hugo Blanc' }],
      [dev('LT-EMMA').id]: [],
    },
    laps: {
      [dev('LT-PRET-02').id]: { username: 'opale-recovery', password_changed_at: H(70), rotation_requested_at: null, last_viewed_at: null, last_viewed_by_name: null },
      [dev('LT-EMMA').id]: { username: 'opale-recovery', password_changed_at: H(90), rotation_requested_at: null, last_viewed_at: H(100), last_viewed_by_name: 'Hugo Blanc' },
    },
    profiles: ['admin', 'field-researcher', 'office'],
    settings: { repo_url: 'https://git.demo.opale.fr/it/fleet.git', allowed_signers: ['ops@demo.opale.fr ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoSignerKeyDemoSignerKeyDemoSignerKey'], alerts_enabled: true, rings: { pilot: { branch: 'main' }, stable: { branch: 'main' } }, local_admin_username: 'opale-recovery' },
    escrow: { status: 'ok', key_id: ESCROW_KEY_ID, bits: 3072, backup_confirmed: null },
    git: { state: 'ready', upstream: 'https://git.demo.opale.fr/it/fleet.git', last_fetch_at: H(0.05), fetch_age_s: 180, last_error: null, heads: { pilot: REV.head, stable: REV.stable, upstream: { main: REV.head } }, children: 0, binaries_ok: true },
    tipSince: { pilot: H(2), stable: H(30) },
    log: [
      { sha: REV.head, author: 'Hugo Blanc', date: H(2), subject: 'office: pilote HP via hplip-plugin', signed: true },
      { sha: REV.stable, author: 'Camille Roussel', date: H(30), subject: 'field-researcher: QGIS 3.40 + profils GPS', signed: true },
      { sha: REV.previous, author: 'Hugo Blanc', date: H(80), subject: 'base: durcissement sshd, unattended-upgrades', signed: true },
      { sha: REV.initial, author: 'Camille Roussel', date: H(200), subject: 'Dépôt de flotte initial', signed: false },
    ],
  }

  return {
    users, devices, tags, tickets: T, inbox, proposals, snoozes, scripts, executions, packages, deployments, stock, movements,
    groups, groupMembers, onboardings, reviews, audit, settings, linux, prefs: {}, nextId: 1000,
  }
}
