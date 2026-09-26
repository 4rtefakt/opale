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

The API calls Microsoft Graph **app-only**: it gets its token with the
OAuth 2.0 client-credentials flow (secret from step 3.1, scope
`https://graph.microsoft.com/.default`). Every application permission
consented here therefore applies to the **whole tenant**, whoever is
signed in to Opale. Grant only what the features you use need: a feature
whose permission is missing fails with a Graph 403, the rest of Opale
keeps working.

**API permissions** → **+ Add a permission** → **Microsoft Graph** →
**Application permissions** (not delegated). Add:

**Core (required)**

| Permission | Graph calls | Used for |
|---|---|---|
| `User.Read.All` | `GET /users` (list and `$search`), `GET /users/{id}`, `GET /users/{id}/photo/$value` | Staff directory and *sync all users*, user details, profile photos, user picker in onboarding |

**Optional, per feature**

| Feature | Permission | Graph calls |
|---|---|---|
| Intune import (*Sync Intune* in the device list and in Settings) | `DeviceManagementManagedDevices.Read.All` | `GET /deviceManagement/managedDevices` |
| Intune remote sync (*Sync Intune* in the device list's selection bar, on a device page, and in the mobile device page/list) | `DeviceManagementManagedDevices.PrivilegedOperations.All` ⚠️ | `POST /deviceManagement/managedDevices/{id}/syncDevice` |
| Entra groups: group search, native groups imported from Entra, deployments to an Entra group and their hourly sync | `GroupMember.Read.All` | `GET /groups?$search=…`, `GET /groups/{id}/members/microsoft.graph.device`, `GET /groups/{id}/members/microsoft.graph.user` |
| Entra groups (same) | `Device.Read.All` | Same `…/members/microsoft.graph.device` call: without it Graph returns device members with their `id` only, so no hostname matches |
| Onboarding automation: *create account* | `User.ReadWrite.All` ⚠️ | `POST /users` |
| Onboarding automation: *disable account* | `User.EnableDisableAccount.All` ¹ | `PATCH /users/{id}` (`accountEnabled`) |
| Onboarding automation: *revoke sessions* | `User.RevokeSessions.All` ¹ | `POST /users/{id}/revokeSignInSessions` |
| Onboarding automation: *assign licence*, *assign groups* | `GroupMember.ReadWrite.All` ⚠️ | `POST /groups/{id}/members/$ref` |
| Email bridge, reading (`mail.poll_enabled`, `mail.sent_poll_enabled`, `api/scripts/backfill-sent-mail.js`) | `Mail.Read` ⚠️ ² | `GET /users/{mailbox}/messages`, `…/messages/{id}`, `…/mailFolders/{well-known name}`, `…/mailFolders/sentitems/messages` |
| Email bridge, *mark as read* (`mail.mark_as_read_enabled`) and threaded replies (`mail.send_enabled`) | `Mail.ReadWrite` ⚠️ ² (replaces `Mail.Read`) | `PATCH /users/{mailbox}/messages/{id}`, `POST …/messages/{id}/createReply` |
| Email bridge, sending (`mail.send_enabled`) | `Mail.Send` ⚠️ ² | `POST /users/{mailbox}/sendMail`, `POST …/messages/{id}/send` |

¹ Not needed when `User.ReadWrite.All` is granted, which covers both. If
the step still returns 403 with the dedicated permission, check Microsoft's
current Graph permissions reference.

² With Exchange **RBAC for Applications** (see *Hardening* below), assign
these in Exchange Online instead of here.

Ask Opale makes no Graph call, and the code uses no other Graph permission
(no `Directory.*`, no `Group.Read.All`). ⚠️ marks high-impact permissions:

- `Mail.Read` / `Mail.ReadWrite` / `Mail.Send`: read, alter or delete mail
  in, or send as, **any mailbox of the tenant** (executives, HR,
  finance…). Restrict them to the helpdesk mailbox(es).
- `User.ReadWrite.All`: write access to every non-admin user object.
- `GroupMember.ReadWrite.All`: add anyone to any group that is not
  role-assignable (licences, app access, Conditional Access exclusions…).
- `DeviceManagementManagedDevices.PrivilegedOperations.All`: also allows
  remote wipe, retire and lock of every Intune device.

**Delegated side.** The web UI (MSAL) and the CLI only request Opale's own
scope `api://<client-id>/access_as_user` (plus the standard `openid`,
`profile`, `offline_access`). Create it under **Expose an API** as described
in [docs/CLI.md](docs/CLI.md) (*Setup Microsoft Entra*, step 3). No
delegated Microsoft Graph permission is needed; the default `User.Read` is
not used.

Then click **Grant admin consent for &lt;tenant&gt;** and check that every
permission you added switches to ✅ Granted.

#### Hardening (recommended)

- **Restrict sign-in.** **Enterprise applications** → *Opale* →
  **Properties** → *Assignment required?* = **Yes**, then **Users and
  groups** → assign only your IT/admin group (the web UI only admits Opale
  admins anyway, and the CLI uses the same app). The first admin of step 6
  must be in that group. The API's app-only token is not affected.
- **Scope the mail permissions to the helpdesk mailbox(es)**: every
  address in `mail.inboxes`, `mail.sent_mailboxes` and
  `mail.sender_address`. Preferred: Exchange Online **RBAC for
  Applications**. Its grants add up with the Entra ones, so do **not**
  grant `Mail.*` in Entra (remove them and revoke their consent if already
  granted) and assign them in Exchange only:

  ```powershell
  Connect-ExchangeOnline
  # Tag every mailbox Opale may use with a custom attribute your tenant
  # doesn't already use (CustomAttribute15 here), then build a scope on it
  Set-Mailbox -Identity helpdesk@example.com -CustomAttribute15 "opale"
  New-ManagementScope -Name "Opale mailboxes" -RecipientRestrictionFilter "CustomAttribute15 -eq 'opale'"
  # ObjectId = Enterprise applications → Opale → Object ID (not the app registration's)
  New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "Opale"
  # Only the roles your mail features need: Mail.Read, or Mail.ReadWrite + Mail.Send
  New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.ReadWrite" -CustomResourceScope "Opale mailboxes"
  New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "Opale mailboxes"
  # InScope must be True for the helpdesk mailbox, False for any other one
  Test-ServicePrincipalAuthorization -Identity <client-id> -Resource helpdesk@example.com
  Test-ServicePrincipalAuthorization -Identity <client-id> -Resource someone.else@example.com
  ```

  Legacy alternative, which keeps the `Mail.*` grants in Entra and
  restricts them:

  ```powershell
  New-DistributionGroup -Name "Opale mailboxes" -Alias opale-mailboxes -Type Security -Members helpdesk@example.com
  New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId opale-mailboxes@example.com `
    -AccessRight RestrictAccess -Description "Opale: helpdesk mailboxes only"
  Test-ApplicationAccessPolicy -Identity helpdesk@example.com -AppId <client-id>      # Granted
  Test-ApplicationAccessPolicy -Identity someone.else@example.com -AppId <client-id>  # Denied
  ```

  Either way, changes can take up to about two hours to apply.
- **Remove what you don't use.** Delete every permission not needed by
  your features (e.g. `Device.Read.All` without Entra groups,
  `Group.Read.All`, `Directory.*`). Removing a permission from the list
  does not revoke its consent: under *Other permissions granted for
  &lt;tenant&gt;*, use **Revoke admin consent**.
- **Credentials.** Prefer a secret shorter-lived than the 24 months of
  step 3.1, store it only in `.env`, and rotate it: new secret → update
  `ENTRA_CLIENT_SECRET` → restart the API → delete the old secret. A
  certificate credential would be safer, but the API currently only
  supports a client secret.

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

The first start applies `api/migrations/001_init.sql` automatically.
Migrations `002+` are not auto-applied — run them in order:

```bash
for m in api/migrations/0[0-9][0-9]_*.sql; do
  [[ "$m" == *001_init.sql ]] && continue
  echo "→ $m"
  docker compose -f docker-compose.example.yml exec -T db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$m"
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

**Updating the frontend** (no rebuild needed — `front/` is volume-mounted)
```bash
git pull
# edits visible immediately at the next page refresh
```

**Applying a new migration**
```bash
docker compose -f docker-compose.example.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  < api/migrations/0NN_description.sql
```

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

For anything else, open an issue with the logs (`docker compose logs api`,
agent log, browser console) — see [SECURITY.md](SECURITY.md) first if it
looks security-related.
