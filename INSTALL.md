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
