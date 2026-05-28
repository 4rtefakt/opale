-- Pièces jointes des tickets (upload manuel). Strictement additif.
--
-- Les fichiers sont stockés sur disque (volume Docker RW monté sur
-- /app/data/ticket-attachments), pas en DB : purge propre par rm lors de
-- la rotation 6 mois après fermeture du ticket, et dumps Postgres légers.
-- La table ne garde que les métadonnées + le chemin de stockage relatif.
--
-- storage_path : chemin RELATIF au répertoire de base des PJ, de la forme
-- "<ticket_id>/<uuid>". On NE met JAMAIS le filename original dans le
-- chemin (anti path-traversal) ; le nom d'origine vit dans `filename` et
-- ne sert qu'au Content-Disposition au download.
--
-- ON DELETE CASCADE : si le ticket est supprimé, la row part. Le fichier
-- disque correspondant est nettoyé par l'applicatif (route DELETE) ou par
-- le script de purge — PAS par la cascade SQL.

CREATE TABLE IF NOT EXISTS ticket_attachments (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id            UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  filename             TEXT NOT NULL,
  mime_type            TEXT,
  size_bytes           BIGINT NOT NULL,
  storage_path         TEXT NOT NULL,
  uploaded_by_entra_id TEXT,
  uploaded_by_name     TEXT,
  created_at           TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticket_attachments_ticket
  ON ticket_attachments(ticket_id);
