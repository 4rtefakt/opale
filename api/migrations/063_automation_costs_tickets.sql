-- Page Rapports : intègre les gains de temps liés aux tickets/mail au KPI
-- "temps / argent économisé". Strictement additif.
--
-- Contrairement aux autres entrées automation_costs (comptées depuis
-- audit_logs), ces trois actions sont SYNTHÉTIQUES : elles n'écrivent pas
-- dans audit_logs, donc rapports.js les compte directement depuis les
-- tables métier (email_thread_mapping, tickets) sur la fenêtre 30 j, puis
-- réutilise estimated_minutes défini ici pour valoriser le gain. Même
-- mécanisme que 'agent_checkin_summary'.
--
-- Durées (forfaits conservateurs) :
--   ticket_mail_appended : un mail de suivi rattaché automatiquement au bon
--     ticket sans ressaisie ni copier-coller du contenu.
--   ticket_from_email    : ticket créé depuis un mail (depuis la vue "Mails
--     à trier" ou l'acceptation d'une proposition) — création + report du
--     contenu évités.
--   ticket_merged        : deux tickets doublons fusionnés en un seul —
--     retraitement manuel du doublon évité.

INSERT INTO automation_costs (action_type, label, estimated_minutes) VALUES
  ('ticket_mail_appended', 'Mail de suivi rattaché automatiquement',  5),
  ('ticket_from_email',    'Ticket créé depuis un mail',              8),
  ('ticket_merged',        'Tickets fusionnés (doublon évité)',      10)
ON CONFLICT (action_type) DO NOTHING;
