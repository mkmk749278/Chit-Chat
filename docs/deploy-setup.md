# Deploy setup — VPS + GitHub Secrets

Concrete steps to turn the (currently skipped) `backend.yml` / `web.yml` deploy lanes on.
Target host for this project: **`95.111.241.97`**, domain **`luminchat.app`**.

## 1. DNS — point the domain at the VPS (Cloudflare)

Create these A records → `95.111.241.97` (Caddy obtains Let's Encrypt certs once they resolve):

| Record | Type | Value | Proxy status |
| --- | --- | --- | --- |
| `luminchat.app` | A | `95.111.241.97` | **DNS only (grey cloud)** |
| `api.luminchat.app` | A | `95.111.241.97` | **DNS only (grey cloud)** |
| `ws.luminchat.app` | A | `95.111.241.97` | **DNS only (grey cloud)** |
| `grafana.luminchat.app` | A | `95.111.241.97` | **DNS only (grey cloud)** |

> **Set every record to DNS‑only (grey cloud), not Proxied (orange).** Caddy terminates
> TLS itself and obtains Let's Encrypt certs via the HTTP‑01/TLS‑ALPN challenge on ports
> 80/443. Cloudflare's proxy would terminate TLS first (breaking the challenge), and would
> also replace the visitor IP with a Cloudflare IP — which breaks the Grafana admin allowlist
> (`remote_ip {$ADMIN_IP_RANGE}` in `infra/caddy/Caddyfile`) and complicates the `ws.` WebSocket
> upgrade. Grey cloud avoids all three.
>
> SSL/TLS mode in Cloudflare is irrelevant while records are grey‑clouded (Cloudflare isn't in
> the path). If you later want the orange‑cloud proxy (DDoS protection, hidden origin IP), it's
> a separate piece of work: switch Caddy to a **DNS‑01** challenge using the Cloudflare DNS
> plugin (custom Caddy build + a Cloudflare API token), set SSL/TLS to **Full (strict)**, and
> add `trusted_proxies` with Cloudflare's ranges so the Grafana real‑IP check keeps working.
> Ask and I'll wire that up.

## 2. Provision the VPS (once)

Follow `docs/vps-provisioning.md`: create the `deploy` user (in `docker` + `sudo`), install
Docker + Compose, authorize the GitHub Actions **public** key in `deploy`'s
`authorized_keys`, and `git clone` this repo to **`/app`** (the deploy default `VPS_APP_DIR`).
Open ports 80/443. (Caddy runs as a compose service, so the host package is optional.)

## 3. GitHub Secrets (repo → Settings → Secrets and variables → Actions)

Only you can set these. The deploy job stays **skipped** until `VPS_HOST` is present.

**VPS access + routing**

| Secret | Value |
| --- | --- |
| `VPS_HOST` | `95.111.241.97` |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | the **private** key whose public half is in `deploy`'s `authorized_keys` |
| `VPS_APP_DIR` | `/app` |
| `DOMAIN` | `luminchat.app` |

**Per-service env files** — each secret holds the **entire contents** of that service's
`.env` file; the deploy renders them to `infra/docker/.env.<service>` before
`docker compose up`:

- `ENV_BACKEND` — every var from `apps/backend/src/config/env.validation.ts`
  (`DATABASE_URL`, `PGBOUNCER_URL`, `REDIS_URL`, `FIREBASE_PROJECT_ID`,
  `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `SENTRY_DSN_BACKEND`, `JWT_SECRET`,
  `ENCRYPTION_KEY`, optional `PORT`/`WS_PORT`/`MONITORING_CIDRS`).
- `ENV_POSTGRES` — `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.
- `ENV_PGBOUNCER` — pgbouncer auth/db settings matching Postgres.
- `ENV_WEB` — `NEXT_PUBLIC_FIREBASE_*` (public client config).
- `ENV_CADDY` — `DOMAIN=luminchat.app` and `ADMIN_IP_RANGE=<your admin CIDR>` (Grafana allowlist).
- `ENV_GRAFANA` — `GF_SECURITY_ADMIN_PASSWORD` (and any Grafana config).

**Android (only when building the AAB)** — `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON` (base64).

**Backups (only for backup.yml)** — `B2_KEY_ID`, `B2_APPLICATION_KEY`,
`B2_BACKUP_BUCKET_NAME`, `BACKUP_GPG_KEY`, `BACKUP_GPG_PASSPHRASE`.

## 4. Trigger a deploy

Push to `main` touching `apps/backend/**` / `apps/web/**` / `packages/**`, or run the
workflow manually. The deploy job: renders the `.env.*` files from Secrets → `scp`s them to
`/app/infra/docker/` → `git pull` → `docker compose up --build -d` (whole stack) → runs
backend migrations → polls `https://api.luminchat.app/health` (and `https://luminchat.app/health`).

> First run note: the very first `docker compose up` builds all images on the VPS and Caddy
> provisions TLS (needs DNS live first). If anything trips, the health step fails the run
> with the cause — fix and re-push. The web/backend deploys share one concurrency group so
> they never converge the stack at the same time.
