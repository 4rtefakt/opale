# Configuration reference

Every knob exposed by Opale, where it lives, and what it controls.
Three layers, in order of how often you'll touch them in practice:

1. **Environment variables** — set in `.env`, read at boot. Changing a
   value requires restarting the API container.
2. **Runtime settings** — stored in the `settings` table, edited from
   *Paramètres* in the UI. Pick up live (60-second cache).
3. **Branding assets** — files under `front/branding/`. Picked up at the
   next page load.

Plus: an integration matrix listing which IdP, MDM, and OS targets are
supported today.

---

## 1. Environment variables

Set in `.env` (copied from `.env.example`). The API container is the only
consumer; the frontend gets a curated subset via `GET /env.js`.

### 1.1 Server

| Variable | Required | Default | Notes |
|---|---|---|---|
| `PORT` | no | `3010` | API listen port (TLS terminated by your reverse proxy) |
| `NODE_ENV` | no | — | Set to `production` to disable verbose logs |

### 1.2 Database

| Variable | Required | Default | Notes |
|---|---|---|---|
| `POSTGRES_DB` | yes | `opale` | Database name |
| `POSTGRES_USER` | yes | `opale` | Role used by the API |
| `POSTGRES_PASSWORD` | yes | — | No default — set a strong random secret |
| `POSTGRES_HOST` | no | `db` | Resolves to the service name in the bundled compose |

### 1.3 Frontend

| Variable | Required | Default | Notes |
|---|---|---|---|
| `FRONTEND_URL` | yes | — | Used for CORS — must match the public origin (e.g. `https://rmm.example.com`) |
| `API_BASE_URL` | no | `/api` | Injected into `window.ENV.API_BASE_URL`, prefixed on every fetch |

### 1.4 Microsoft Entra ID (SSO + Graph)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ENTRA_TENANT_ID` | yes | — | Directory (tenant) ID from the App Registration |
| `ENTRA_CLIENT_ID` | yes | — | Application (client) ID — used by both MSAL and the API |
| `ENTRA_CLIENT_SECRET` | yes | — | Used for the app-only Graph token (server-to-server) |

### 1.5 SSH bridge to endpoints

Only required if you want the in-browser terminal.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SSH_USER` | recommended | `opale` | Local username on each endpoint that holds the public key. Boot warning if absent |
| `SSH_PORT` | no | `22` | TCP port |
| `SSH_PRIVATE_KEY_B64` | yes (if SSH used) | — | `base64 -i ~/.ssh/id_ed25519` |

### 1.6 Web Push (PWA notifications)

Generate the key pair once with `npx web-push generate-vapid-keys`.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VAPID_PUBLIC_KEY` | yes (for push) | — | Exposed to the SPA for subscription |
| `VAPID_PRIVATE_KEY` | yes (for push) | — | Server-side only |
| `VAPID_EMAIL` | yes (if VAPID set) | — | `mailto:admin@example.com` or bare email — fail-fast at boot if missing while keys are present |

### 1.7 Onboarding (Microsoft Entra group assignment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ONBOARDING_BASE_GROUP_IDS` | no | — | Comma-separated Entra group object IDs added to every onboarded user |
| `ONBOARDING_LICENSE_GROUP_ID` | no | — | Group whose membership grants a Microsoft 365 license |

---

## 2. Runtime settings

Persisted as `(key TEXT, value TEXT)` rows in the `settings` table.
Editable from **Paramètres** in the UI by any admin
(`users_cache.is_admin = true`). Server-side allowlist enforced in
`api/routes/settings.js`.

### 2.1 Branding (exposed to the SPA via `window.ENV.BRANDING`)

| Key | Type | Default | Effect |
|---|---|---|---|
| `org.name` | text | `Your Organization` | Sidebar header, login subtitle |
| `app.product_name` | text | `Opale` | Browser title, login hero, sidebar |
| `app.tagline` | text | `Open RMM platform` | Login subtitle |
| `app.default_role_label` | text | `IT` | Fallback role label under the avatar |

Branding cache TTL: 60 s. Invalidated immediately on `PATCH /api/settings`.
Also rebuilds `manifest.json` on the fly so PWA `name`/`short_name` follow
the product name.

### 2.2 Thresholds

| Key | Type | Default | Effect |
|---|---|---|---|
| `disk_warn_pct` | int | `80` | Disk usage % above which a warning alert fires and a push notification is sent |
| `disk_critical_pct` | int | `90` | Disk usage % above which a critical alert fires |
| `agent_offline_days` | int | `2` | Days of silence before a device is flagged offline |

### 2.3 Microsoft Graph user listing filter

Both empty → no extra filter applied (the full user directory is listed).

| Key | Type | Default | Effect |
|---|---|---|---|
| `users.filter_attribute` | text | — | Graph attribute name (e.g. `extensionAttribute1`) used in the OData filter |
| `users.filter_value` | text | — | Value the attribute must equal |

### 2.4 Windows agent (read by the agent at every checkin)

| Key | Type | Default | Effect |
|---|---|---|---|
| `agent.laps_recovery_username` | text | `opale-recovery` | Local Windows account name that the agent creates/rotates as a LAPS-style recovery. Validated server-side: 1–32 chars `[A-Za-z0-9_.-]`, banned values include `administrator`, `admin`, `root`, `system` |

Changing this name does **not** delete the previous account on already
deployed endpoints — the old account is left in place and a new one is
created at the next checkin. Clean the orphans manually if needed.

### 2.5 Operations

| Key | Type | Default | Effect |
|---|---|---|---|
| `ssh_public_key` | text | — | Public SSH key shown in the UI for distribution to endpoints |
| `annual_salary_brut` | int | — | Used by the *Rapports* page to monetise time saved |
| `maintenance_window_default` | JSON | none | Window during which agents accept `agent_update` and queued `deployments`. Outside the window the checkin response carries empty values. Format below |

`maintenance_window_default` JSON shape:

```json
{
  "weekdays": [1,2,3,4,5],
  "start": "02:00",
  "end":   "04:00",
  "tz":    "Europe/Paris"
}
```

`weekdays`: 0=Sunday … 6=Saturday; empty/absent = every day. `end < start`
crosses midnight. Invalid JSON fails open (window considered active).
**No UI editor today** — set via SQL.

---

## 3. Branding assets

Files under `front/branding/`. Served via `/branding/<file>` with an
automatic fallback to `front/<file>` if the override is absent.

| Served URL | Override path | Fallback | Recommended format |
|---|---|---|---|
| `/branding/icon.svg` | `front/branding/icon.svg` | `front/icon.svg` | SVG, square, ≥ 512×512 viewBox |
| `/branding/favicon.ico` | `front/branding/favicon.ico` | `front/favicon.ico` | ICO multi-resolution (16, 32, 48) |
| `/branding/login-bg.svg` | `front/branding/login-bg.svg` | `front/login-bg.svg` | SVG, ratio 16:9 or larger |

Any other file in `front/branding/` matching `[A-Za-z0-9._-]+` is also
exposed under `/branding/<name>`. Allowed extensions: `.svg`, `.png`,
`.jpg`, `.jpeg`, `.ico`, `.webp`. Cache: `max-age=300`.

Override files are gitignored on purpose — see
[front/branding/README.md](../front/branding/README.md).

The PWA `manifest.json` is generated dynamically from the runtime
branding settings, so installed PWAs follow the configured product name
without a rebuild.

---

## 4. Endpoints exposed to the Windows agent

All under `/api/agent/`, agent-token Bearer auth (token created from
**Paramètres → Tokens** or via the bootstrap script).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/exchange-token` | First-run: a one-time bootstrap token returns a per-device persistent token |
| `POST` | `/checkin` | Main loop: send metrics + receive `commands`, `deployments`, `agent_update`, `maintenance_window` |
| `POST` | `/result` | Report a queued script's exit code + output |
| `POST` | `/setup-log` | Upload first-run install logs |
| `POST` | `/admin-credential` | Escrow the LAPS rotation password (RSA-OAEP-SHA256 ciphertext) |
| `POST` | `/rotate-token` | Generate a successor token, expire the old one at +24 h |
| `GET` | `/version` | Latest agent version available on the server (semver string) |
| `GET` | `/runtime-config` | Current runtime config (`laps_recovery_username`, …) — fetched at boot and at each checkin |
| `GET` | `/binary` | Latest agent binary, signed; arch selected via UA `windows/<arch>` or `?arch=` |
| `GET` | `/binary/meta` | `{ arch, version, sha256, signature_ed25519, size }` — used by the agent before downloading |

Binary signature: ed25519 over the SHA-256 of the binary. The agent
embeds the public key at compile time and refuses any binary it can't
verify.

---

## 5. Compatibility matrix

What works today, what's planned, what won't ever be in scope.

### 5.1 Identity providers (SSO)

| Provider | Status | Notes |
|---|---|---|
| Microsoft Entra ID | ✅ Supported | MSAL.js + JWKS validation |
| Google Workspace | ⏳ Planned | Generic OIDC abstraction needed first — issue tracker label `auth-providers` |
| Authentik / Keycloak / generic OIDC | ⏳ Planned | Same |
| SAML | 🔬 Possible | Not prioritised — open an issue if you need it |
| Local password auth | ❌ Not planned | Use a self-hosted IdP if you don't have one |

### 5.2 MDM / device management

| Provider | Status | Notes |
|---|---|---|
| Microsoft Intune | ✅ Supported | Compliance, enrollment date, last MDM sync, device sync trigger |
| Jamf / Workspace ONE / Kandji / SCCM | ⏳ Planned | Requires `MdmProvider` abstraction — issue tracker label `mdm-providers` |
| **No MDM** (agent-only) | ✅ Supported | Recommended path going forward — Intune becomes an enricher, not the source of truth |

### 5.3 Endpoint OS

| Target | Status | Notes |
|---|---|---|
| Windows 10/11 | ✅ Supported | Go agent, Windows Service, amd64 + arm64 |
| Windows Server | 🔬 Best effort | Should work — service install logic identical |
| macOS | ❌ Not supported | No Mac agent today |
| Linux | ❌ Not supported | No Linux agent today |

### 5.4 Mesh VPN (for in-browser SSH)

The API server connects out to each endpoint over IP. Anything that
makes the endpoint routable from the API works. No protocol coupling.

| VPN | Status |
|---|---|
| Netbird | ✅ Used in production |
| Tailscale | ✅ Should work (same model) |
| ZeroTier | ✅ Should work |
| Plain LAN (no VPN) | ✅ Works if endpoints are reachable |
| IPsec / OpenVPN | ✅ Works |

### 5.5 Reverse proxies

Any proxy capable of forwarding plain HTTP/1.1 + WebSocket Upgrade to
the API container. Tested: Caddy, Traefik, nginx. The API does not
terminate TLS itself.

---

## 6. Where to find things

| Concern | Read this |
|---|---|
| Bootstrap a fresh instance | [INSTALL.md](../INSTALL.md) |
| GDPR / data minimisation | [PRIVACY.md](PRIVACY.md) |
| Vulnerability disclosure | [SECURITY.md](../SECURITY.md) |
| Contributing | [CONTRIBUTING.md](../CONTRIBUTING.md) |
