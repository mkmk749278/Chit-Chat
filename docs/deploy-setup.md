# Deploy setup — VPS + GitHub Secrets

Turn the (currently skipped) `backend.yml` / `web.yml` deploy lanes on.
Target host: **`95.111.241.97`**, domain **`luminchat.app`** (DNS via Cloudflare).

The deploy job stays **skipped** (green, not red) until `VPS_HOST` exists in GitHub Secrets.

---

## 1. DNS — Cloudflare (DONE)

Four **A** records → `95.111.241.97`, all **DNS only (grey cloud)**: `@`, `api`, `ws`, `grafana`.

> Keep them grey, never orange. Caddy obtains Let's Encrypt certs itself (HTTP-01/TLS-ALPN
> on 80/443) and the Grafana allowlist needs the real client IP — Cloudflare's proxy breaks both.

Verify: `dig +short luminchat.app api.luminchat.app ws.luminchat.app grafana.luminchat.app`
→ all four return `95.111.241.97`.

---

## 2. Provision the VPS (run once, as root on `95.111.241.97`)

```bash
# 2.1 Docker engine + compose plugin
curl -fsSL https://get.docker.com | sh

# 2.2 Deploy user (docker + sudo), no password sudo for convenience
adduser --disabled-password --gecos "" deploy
usermod -aG docker,sudo deploy
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy

# 2.3 SSH key the GitHub Action will use (run on the VPS, no passphrase)
sudo -u deploy ssh-keygen -t ed25519 -f /home/deploy/.ssh/gha -N "" -C "github-actions"
sudo -u deploy bash -c 'cat /home/deploy/.ssh/gha.pub >> /home/deploy/.ssh/authorized_keys'
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
echo "===== COPY THIS PRIVATE KEY INTO THE GitHub SECRET VPS_SSH_KEY ====="
cat /home/deploy/.ssh/gha          # includes BEGIN/END lines — copy all of it
echo "===================================================================="

# 2.4 Clone the repo to /app, owned by deploy
git clone https://github.com/mkmk749278/Chit-Chat.git /app
chown -R deploy:deploy /app

# 2.5 Firewall — ONLY 22/80/443 public. (Docker bypasses ufw for published ports,
#     but the compose now binds app/db ports to 127.0.0.1, so this is the full surface.)
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

Copy the **private key** printed in 2.3 into the `VPS_SSH_KEY` secret below.

---

## 3. Firebase (REQUIRED — the backend will not boot without it)

`FirebaseAdminService` initializes at startup with a real service-account key, so you need a
Firebase project before the first deploy.

1. https://console.firebase.google.com → create project `luminchat` (or reuse one).
2. **Authentication → Sign-in method → Phone** → enable.
3. **Project settings → Service accounts → Generate new private key** → downloads a JSON with
   `project_id`, `client_email`, `private_key`. → feeds `ENV_BACKEND`.
4. **Project settings → General → Your apps → Web app** (create one) → copy the
   `firebaseConfig` values (`apiKey`, `authDomain`, `projectId`, `appId`,
   `storageBucket`, `messagingSenderId`). → feeds `ENV_WEB`.

---

## 4. GitHub Secrets (repo → Settings → Secrets and variables → Actions → New repository secret)

### Access + routing

| Secret | Value |
| --- | --- |
| `VPS_HOST` | `95.111.241.97` |
| `VPS_USER` | `deploy` |
| `VPS_SSH_KEY` | the private key printed in step 2.3 (all lines incl. BEGIN/END) |
| `VPS_APP_DIR` | `/app` |
| `DOMAIN` | `luminchat.app` |

### Per-service env files (each secret = the FULL contents of that file)

The deploy renders these to `infra/docker/.env.<service>` (and `.env`) before `docker compose up`.

**`ENV_BACKEND`** — replace the three `FIREBASE_*` from your service-account JSON. The other
values are pre-generated for you (rotate later if you like). `FIREBASE_PRIVATE_KEY` goes on ONE
line with literal `\n` (copy it exactly as it appears in the JSON):
```
DATABASE_URL=postgres://chituser:REPLACE_DB_PASSWORD@postgres:5432/chitchat
PGBOUNCER_URL=postgres://chituser:REPLACE_DB_PASSWORD@pgbouncer:5432/chitchat
REDIS_URL=redis://redis:6379
FIREBASE_PROJECT_ID=your-firebase-project-id
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxx@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n
JWT_SECRET=REPLACE_JWT_SECRET
ENCRYPTION_KEY=REPLACE_ENCRYPTION_KEY
SHADOW_MASTER_KEY_SALT=REPLACE_SALT
PORT=3000
WS_PORT=3001
```
(`SENTRY_DSN_BACKEND` is optional now — omit it, or add a real DSN to enable error reporting.)

**`ENV_POSTGRES`**
```
POSTGRES_USER=chituser
POSTGRES_PASSWORD=REPLACE_DB_PASSWORD
POSTGRES_DB=chitchat
```

**`ENV_PGBOUNCER`** (edoburu/pgbouncer — auto-generates its config from these):
```
DB_HOST=postgres
DB_NAME=chitchat
DB_USER=chituser
DB_PASSWORD=REPLACE_DB_PASSWORD
AUTH_TYPE=scram-sha-256
ADMIN_USERS=chituser
```

**`ENV_WEB`** (public Firebase web config — inlined into the client at build time):
```
NEXT_PUBLIC_FIREBASE_API_KEY=AIza...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-firebase-project-id
NEXT_PUBLIC_FIREBASE_APP_ID=1:1234567890:web:abc123
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=1234567890
```

**`ENV_CADDY`** (`ADMIN_IP_RANGE` = your admin IP for Grafana — get it with `curl ifconfig.me`):
```
DOMAIN=luminchat.app
ADMIN_IP_RANGE=YOUR.ADMIN.IP.ADDR/32
```

**`ENV_GRAFANA`**
```
GF_SECURITY_ADMIN_PASSWORD=REPLACE_GRAFANA_PASSWORD
GF_SERVER_ROOT_URL=https://grafana.luminchat.app
```

> **`REPLACE_DB_PASSWORD` must be identical** in `ENV_BACKEND` (both URLs), `ENV_POSTGRES`, and
> `ENV_PGBOUNCER`. Use a hex value (URL-safe, no escaping). Generate any of these with
> `openssl rand -hex 24`.

### Later (only when those pipelines run)
- **Android** (`android.yml`): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON`.
- **Backups** (`backup.yml`): `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_BACKUP_BUCKET_NAME`,
  `BACKUP_GPG_KEY`, `BACKUP_GPG_PASSPHRASE`.

---

## 5. Deploy

Push to `main` touching `apps/backend/**` / `apps/web/**` / `packages/**`, or run the workflow
manually. Each deploy: renders the `.env.*` files from Secrets → `scp` to `/app/infra/docker/` →
`git pull` → `docker compose up --build -d` (whole stack) → backend migrations → health-check
`https://api.luminchat.app/health` (and `https://luminchat.app/health`).

> First run builds all images on the VPS (a few minutes) and Caddy provisions TLS (needs DNS live,
> which it is). If a step trips, the health check fails the run with the cause — fix the secret and
> re-push. Backend and web deploys share one concurrency group so they never converge concurrently.
