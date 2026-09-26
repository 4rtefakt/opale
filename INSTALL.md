# Installation guide

This guide walks through deploying a fresh Opale instance for a single
organisation. Time required: ~1 hour for a Linux operator already familiar
with Docker, Microsoft Entra app registrations, and DNS.

For local development, see the **Quick start** section in [README.md](README.md)
and skip to step 6 to bootstrap your first admin.

---

## 1. Prerequisites

**Server**
- Linux host with **Docker 24+** and **Docker Compose v2**
- ≥ 2 vCPU, 2 GB RAM, 20 GB SSD (small org with ~100 endpoints)
- Outbound HTTPS to `login.microsoftonline.com` and `graph.microsoft.com`
- Inbound HTTPS (443) for the agents and the web UI

**DNS & TLS**
- A DNS record (e.g. `rmm.example.com`) pointing to the server
- A reverse proxy in front of the API container handling TLS termination —
  Caddy, Traefik, nginx, or your existing platform
- A valid TLS certificate (Let's Encrypt is fine; the Go agent refuses
  invalid certs and does **not** support `InsecureSkipVerify`)

**PostgreSQL**
- Either: use the embedded `postgres:16-alpine` from
  `docker-compose.example.yml` (fine for ≤ 200 endpoints)
- Or: point `POSTGRES_HOST` at an existing PostgreSQL 16 cluster

**Microsoft Entra ID**
- An Entra tenant (any plan) and the ability to create an
  **App Registration** with admin consent for application permissions
- Optionally Microsoft Intune, if you want compliance/enrollment data
  surfaced in the UI

**Mesh VPN (optional but recommended)**
- The in-browser SSH terminal connects to endpoints directly. In practice
  this means the API server needs IP-level reachability to each endpoint.
  A mesh VPN (Netbird, Tailscale, ZeroTier) is the easiest way to provide
  this. Without one, SSH is restricted to LAN-reachable devices.

---

## 2. Clone and vendor front-end dependencies

```bash
git clone https://github.com/4rtefakt/opale.git
cd opale
./setup.sh
```

`setup.sh` downloads MSAL Browser, Tabler Icons fonts, Chart.js and
xterm.js into `front/`. These files are gitignored on purpose — the
script runs in a few seconds and produces a self-contained `front/`
directory. Re-run it after pulling updates if the script changes.

---

## 3. Register an application in Microsoft Entra

1. Open <https://entra.microsoft.com> → **Applications** → **App
   registrations** → **New registration**.
2. **Name**: `Opale` (or any internal name).
3. **Supported account types**: *Accounts in this organizational directory
   only (single tenant)*.
4. **Redirect URI**: leave blank for now (we'll add it after step 5).
5. After creation, note the **Application (client) ID** and the
   **Directory (tenant) ID**. You'll paste them into `.env`.

### 3.1 Add a client secret

**Certificates & secrets** → **+ New client secret** → 24-month expiry
recommended → copy the **Value** immediately (it's only shown once).

### 3.2 Grant API permissions

**API permissions** → **+ Add a permission** → **Microsoft Graph** →
**Application permissions** (not delegated). Add:

| Permission | What it's used for |
|---|---|
| `User.Read.All` | Resolve users assigned to a device, fetch profile photos |
| `Device.Read.All` | List managed devices |
| `DeviceManagementManagedDevices.Read.All` | Pull Intune compliance data |
| `GroupMember.Read.All` | Verify admin groups, assign onboarding groups |

Then click **Grant admin consent for &lt;tenant&gt;**. All four permissions
should switch to ✅ Granted.

### 3.3 Add the redirect URI

**Authentication** → **+ Add a platform** → **Single-page application** →
URI: `https://rmm.example.com` (replace with your actual host) →
**Save**. Enable **Access tokens** and **ID tokens** under *Implicit
grant and hybrid flows* if not already on.

---

## 4. Configure `.env`

```bash
cp .env.example .env
```

Edit the file. The minimum viable setup:

```dotenv
PORT=3010
NODE_ENV=production

POSTGRES_DB=opale
POSTGRES_USER=opale
POSTGRES_PASSWORD=<random 32-char string>
POSTGRES_HOST=db                       # default for the bundled compose

FRONTEND_URL=https://rmm.example.com   # for CORS — must match your real host
API_BASE_URL=/api

ENTRA_TENANT_ID=<from step 3>
ENTRA_CLIENT_ID=<from step 3>
ENTRA_CLIENT_SECRET=<from step 3.1>

# SSH bridge to endpoints (only needed if you'll use the in-browser terminal)
SSH_USER=opale
SSH_PORT=22
SSH_PRIVATE_KEY_B64=<base64 of your ed25519 private key>

# Web Push — generate with `npx web-push generate-vapid-keys`
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_EMAIL=admin@example.com          # required as soon as VAPID keys are set
```

For the full matrix (every variable, what it does, default value, runtime
versus build-time), see [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## 5. Start the stack

```bash
docker compose -f docker-compose.example.yml up -d
docker compose -f docker-compose.example.yml logs -f api
```

The API applies the database migrations itself at startup, **before** it
starts listening: every `api/migrations/NNN_*.sql` file not yet recorded in
the `schema_migrations` table runs in order, each in its own transaction
(details in [api/migrations/MIGRATIONS.md](api/migrations/MIGRATIONS.md)).
In the logs you should see one `migration appliquée` line per file, then
`migrations : base à jour`. If a migration fails, the API logs the file,
line and PostgreSQL error, rolls that file back and exits (Docker restarts
it); it never serves requests on a half-migrated schema.

To apply migrations by hand instead, set `DB_AUTO_MIGRATE=false` in `.env`
and run them in order:

```bash
for m in api/migrations/0[0-9][0-9]_*.sql; do
  echo "→ $m"
  docker compose -f docker-compose.example.yml exec -T db \
    psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$m"
done
```

Wire your reverse proxy of choice to `localhost:3010` and serve the
host on HTTPS. Example with Caddy:

```caddyfile
rmm.example.com {
    reverse_proxy localhost:3010
}
```

Browse to `https://rmm.example.com` — you should land on the login
screen with the Microsoft button.

---

## 6. Bootstrap the first admin

The login flow trusts the JWT but reads admin status from the
`users_cache` table. After your first login, your row exists but has
`is_admin = false`. Promote yourself manually:

```bash
docker compose -f docker-compose.example.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "UPDATE users_cache SET is_admin = true WHERE email = 'you@example.com';"
```

Refresh the browser. The full sidebar (Devices, Settings, Stock, etc.)
should now appear.

---

## 7. Brand the instance

Sign in as the new admin → **Paramètres** → **Branding**:

- **Organisation name** — appears in the sidebar header
- **Product name** — replaces "Opale" in the title bar and login
- **Tagline** — under the product name on the login screen
- **Default role label** — fallback role for users without a job title

These values are persisted in the `settings` table and exposed at boot
via `/env.js → window.ENV.BRANDING.*`. No restart needed.

For visual assets (logo, favicon, login background), drop SVG/PNG files
into `front/branding/` — see [front/branding/README.md](front/branding/README.md)
for the recognised filenames and the fallback behaviour.

---

## 8. Deploy the Windows agent

The agent is a Go binary running as a Windows Service. The recommended
deployment path is **Microsoft Intune** with a one-time bootstrap script
generated from the API server.

### 8.1 Generate a bootstrap installer

The shipped helper expects SSH access to the server hosting the
PostgreSQL container:

```bash
URL=https://rmm.example.com \
SSH_HOST=root@your-server \
DB_USER=opale DB_NAME=opale \
./scripts/build-intune-bootstrap.sh 7      # bootstrap valid 7 days
```

Output: `intune-installers/install-bootstrap-YYYY-MM-DD.ps1` (gitignored,
~6 KB). The bootstrap token is embedded in clear inside this file — treat
it as sensitive (it can register any number of devices until it expires
or you revoke it).

### 8.2 Push it via Intune

1. Intune admin centre → **Devices** → **Scripts and remediations** →
   **Platform scripts** → **+ Add** → **Windows 10 and later**.
2. Upload the generated `.ps1`. Run as **System**, 64-bit context, no
   signature check.
3. Assign to a Windows group (a dynamic group like
   `Windows + agent_version is null` works well — see the script header
   for the suggested filter).

Each device runs the script once. The agent installs itself, exchanges
the bootstrap for a per-device token, registers in `devices`, and starts
checking in every 15 minutes.

### 8.3 Without Intune

The agent works fine without an MDM. Run `agent-go/install.ps1` as
SYSTEM with the appropriate environment variables.

---

## 9. Day-2 operations

**Updating the API**
```bash
git pull
docker compose -f docker-compose.example.yml build api
docker compose -f docker-compose.example.yml up -d api
```

**Health check** — `GET /api/health` (no authentication) answers
`200 {"status":"ok"}` when the API and PostgreSQL respond, `503
{"status":"unavailable"}` otherwise (cause in the API log; no details in the
response). Use it for uptime monitoring or a compose healthcheck:

```yaml
  api:
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:3010/api/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

**Updating the frontend** (no rebuild needed — `front/` is volume-mounted)
```bash
git pull
# edits visible immediately at the next page refresh
```

**Applying a new migration** — nothing to do: new files in
`api/migrations/` are applied when the updated API starts (see §5). With
`DB_AUTO_MIGRATE=false`, apply them with
`docker compose -f docker-compose.example.yml exec api node scripts/run-migrations.js`
(same runner, records them in `schema_migrations`) or by hand:
```bash
docker compose -f docker-compose.example.yml exec -T db \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < api/migrations/0NN_description.sql
```

**First start of the migration runner on an existing instance** (a database
whose migrations were applied by hand, without a `schema_migrations` table).
The runner cannot know which files were really applied by hand, so it
**re-runs every file once**, then records them. Every migration is written
to be idempotent on a populated database (tested), and this also applies the
files you may have missed (e.g. `071`, `075`). A file that fails because of
manual drift in your database (a constraint or index added by hand, duplicate
data) stops the start. Rehearse first:

```bash
DC="docker compose -f docker-compose.example.yml"   # adapt to your compose file

# 1. Back up the production database.
$DC exec -T db pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > opale-before-runner.dump

# 2. Pre-flight on production: both must be as shown.
$DC exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
  "SELECT current_schema(), to_regclass('schema_migrations') IS NULL"
#    → public|t   (no schema_migrations table left over from another tool)

# 3. Rehearsal: restore the dump into a scratch database and run ONLY the
#    runner on it, with the new image (build it first). The API itself is not
#    started, so nothing is sent (mail, Graph) from the copy.
$DC build api
$DC exec -T db createdb -U "$POSTGRES_USER" opale_rehearsal
$DC exec -T db pg_restore -U "$POSTGRES_USER" -d opale_rehearsal < opale-before-runner.dump
$DC run --rm --no-deps -e POSTGRES_DB=opale_rehearsal api node scripts/run-migrations.js
#    → exit 0 and "64 migration(s) appliquée(s)". Anything else: read the
#      error (file, line, SQLSTATE) and fix the drift before deploying.

# 4. Compare the seeded tables between production (before) and the rehearsal
#    (after). Seed migrations use INSERT … ON CONFLICT DO NOTHING: a row you
#    deleted by hand, or that came with a migration you never applied, is
#    (re-)created.
q() { $DC exec -T db psql -U "$POSTGRES_USER" -d "$1" -AtF '|' -c "$2"; }
for sql in "SELECT key, value FROM settings WHERE key NOT LIKE 'mail.%cursor%' ORDER BY key" \
           "SELECT action_type, estimated_minutes FROM automation_costs ORDER BY action_type" \
           "SELECT builtin_key, name FROM scripts WHERE is_builtin ORDER BY builtin_key"; do
  diff <(q "$POSTGRES_DB" "$sql") <(q opale_rehearsal "$sql")
done
$DC exec -T db dropdb -U "$POSTGRES_USER" opale_rehearsal
```

What to look for in step 4: lines only on the rehearsal side (`>`) are rows
the first boot will add. Most are harmless defaults, and the `mail.*` switches
all default to `false`. Two settings default to **`true`**:
`tickets.assistant.enabled` (AI suggestions on tickets, Ollama at
`http://ollama:11434`) and `ask.enabled` (Ask Opale, which answers 503 until
`OPALE_ASK_API_KEY` is set). If they show up and you don't want them, set
them to `false` right after the deploy:
`UPDATE settings SET value = 'false' WHERE key IN ('tickets.assistant.enabled', 'ask.enabled');`.
Re-created `automation_costs` rows count again in the Rapports KPI;
re-created built-in scripts reappear in the script library.

Then deploy and start the new API as usual. A warning
`base existante sans historique` is logged, followed by one
`migration appliquée` line per file; it takes a few seconds and the API only
starts listening afterwards. Close any open `psql` session first: a table lock
held for more than 60 s makes the start fail (it is retried by Docker).
Check: `SELECT count(*), max(filename) FROM schema_migrations;` → `64`,
`075_strip_onboarding_temp_passwords.sql`, and `GET /api/health` → 200.

**If the API crash-loops on a migration** (log
`Migration NNN_….sql en échec …`): set `DB_AUTO_MIGRATE=false` in `.env` and
`$DC up -d api` to restore service immediately (the checkin keeps working
even if `071` is missing), then fix the cause, apply with
`$DC exec api node scripts/run-migrations.js`, and remove the setting.
Restore the dump only if the data itself is damaged.

To keep applying migrations by hand, set `DB_AUTO_MIGRATE=false` before
deploying (and use `node scripts/run-migrations.js` or `psql`).

**After the upgrade** (same release, not migrations):
- Agent scripts stuck in `running` for more than 1 hour (and SSH executions
  for more than 6 hours) are marked `error` with a timeout message at the
  first start, then every 15 minutes.
- Routine agent checkins no longer write an `agent_checkin` audit row (only
  enrolment, rename, serial mismatch, agent version change and rejected
  Netbird IP do). The old routine rows stay until the 365-day purge; to drop
  them at once (smaller table, faster Audit view):
  `DELETE FROM audit_logs WHERE action = 'agent_checkin' AND NOT (details ? 'events');`
- Retention: the daily purge now keeps `bandwidth_stats`, `ping_stats` and
  `system_perf_stats` 7 days (bandwidth/ping were 30 days; the checkin already
  trimmed active devices to 7 days, and the UI never shows more).
- A checkin whose inventory contains a value PostgreSQL rejects now fails as
  a whole, `last_seen` included, so the device can look offline. NUL bytes
  are stripped at the API boundary; any other case shows up as a 500 on
  `POST /api/agent/checkin` in the API log.

**One-off data migration scripts** (`api/scripts/`)

After upgrading from a pre-refonte release of the tickets module, run
these once. Each accepts `--check` for a dry-run that lists candidates
without modifying anything.

```bash
# 1. Move HTML email bodies from tickets.description into a first
#    ticket_message, replacing the description with a short "Mail de X
#    reçu le Y" header. Idempotent.
docker compose exec api node \
  /app/scripts/migrate-html-descriptions-to-messages.js --check
docker compose exec api node \
  /app/scripts/migrate-html-descriptions-to-messages.js

# 2. Re-inject legacy emails previously classified as "skipped_other"
#    by the old auto-classifier back into the "to sort" inbox, so an
#    admin can verify there were no false positives. Re-runs the
#    classifier in advisory mode if configured. Idempotent.
docker compose exec api node \
  /app/scripts/migrate-legacy-skipped-to-inbox.js --check
docker compose exec api node \
  /app/scripts/migrate-legacy-skipped-to-inbox.js
```

**Ticket attachments storage** — uploaded files are stored on disk under
`/app/data/ticket-attachments` inside the API container (referenced from
`ticket_attachments.storage_path` in the DB). Mount a writable volume for
that path so files survive container rebuilds, e.g. in your compose:

```yaml
  api:
    volumes:
      - attachments_data:/app/data/ticket-attachments
# …
volumes:
  attachments_data:
```

Override the base path with `ATTACHMENTS_DIR` if needed. Files are pruned
6 months after a ticket is closed by a maintenance script (cron-friendly,
`--check` for dry-run):

```bash
docker compose exec api node /app/scripts/purge-old-attachments.js --check
docker compose exec api node /app/scripts/purge-old-attachments.js
```

**Updating the agent fleet** — bump the version in
`agent-go/version.go`, rebuild with `node agent-go/build.js`, copy
`agent-go/dist/` to the server's volume mount. Each agent picks up the
new binary at its next checkin (max 15 minutes), verifies the ed25519
signature, and self-replaces atomically with rollback on failure.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401 on every API call after login | `ENTRA_TENANT_ID` / `ENTRA_CLIENT_ID` mismatch with the redirect URI configured in Entra |
| Login works but sidebar is empty | `users_cache.is_admin` not set — see step 6 |
| Agent installs but no checkin | Server URL unreachable from the endpoint (firewall? mesh VPN missing?) — check `C:\ProgramData\<DataDir>\agent.log` |
| Agent rolls back after each update | Signature verification failure — the agent expects the binary served by `/api/agent/binary` to be signed by the ed25519 key embedded at build time |
| Push notifications don't trigger | `VAPID_EMAIL` missing or invalid — must be `mailto:…` or a bare email |
| API exits at startup with `Migration NNN_….sql en échec` | That migration failed and was rolled back (file, line and PostgreSQL error in the log). Fix the cause (or the file), then restart: already-applied files are not re-run. A `lock_timeout` error means another session held a table lock for 60 s — close it and restart |

For anything else, open an issue with the logs (`docker compose logs api`,
agent log, browser console) — see [SECURITY.md](SECURITY.md) first if it
looks security-related.
