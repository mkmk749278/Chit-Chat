# One-Time VPS Provisioning Checklist (Phase 0)

> **Status:** Manual, one-time operator runbook. **Non-executable** — this document is
> reference only. Nothing here is run automatically by CI/CD.
>
> **Scope:** Bootstraps a fresh single VPS so the GitHub Actions deploy pipelines can take
> over. Per the Phase 0 design (Section 14.4 VPS provisioning, Section 14.5 Docker Compose),
> the running services themselves are managed by Docker Compose and deployed by GitHub
> Actions — this checklist only prepares the host.
>
> _Requirements: 9.1_

## Conventions

- Run every step **as `root`** (or via the cloud provider's initial admin login) unless a
  step explicitly switches to the `deploy` user.
- Replace placeholders such as `<GHA_DEPLOY_PUBLIC_KEY>`, `<REPO_URL>`, and
  `<DOMAIN>` with your real values.
- Commands are shown **for reference**. Read each one before running it; do not paste blindly.
- Target OS: a current Ubuntu/Debian LTS release (the `apt` examples assume this).

---

## 1. Create the non-root `deploy` user

The pipeline never logs in as `root`. Create a dedicated `deploy` user that owns the
application and can run `docker` and `sudo`.

- [ ] Create the user with a home directory and shell.
- [ ] Add `deploy` to the `sudo` group (administrative tasks during deploy).
- [ ] Add `deploy` to the `docker` group (run Docker without `sudo`).

```bash
# Reference only
adduser --gecos "" deploy            # create the deploy user (set/lock a password as policy dictates)
usermod -aG sudo deploy              # grant sudo
usermod -aG docker deploy            # grant docker access (group is created when Docker is installed, see §3)
```

> Note: the `docker` group exists only after Docker is installed (Section 3). If you create
> the user first, re-run the `usermod -aG docker deploy` line after Docker is installed, or
> simply do Section 3 before adding the group.

---

## 2. Authorize the GitHub Actions deploy key

GitHub Actions connects over SSH using the `VPS_SSH_KEY` secret (Category A). Add the
**public** half of that key pair to the `deploy` user's `authorized_keys`.

- [ ] Create the `~/.ssh` directory for `deploy` with correct ownership and permissions.
- [ ] Append the GitHub Actions **public** key to `authorized_keys`.
- [ ] Verify SSH login as `deploy` works using the matching private key before relying on CI.

```bash
# Reference only — run as root, then permissions are handed to deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
echo "<GHA_DEPLOY_PUBLIC_KEY>" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

> Security: only the **public** key goes on the VPS. The private key lives solely in the
> `VPS_SSH_KEY` GitHub Secret. Consider hardening `sshd` (disable root login and password
> auth) once key-based login is confirmed working.

---

## 3. Install Docker Engine and the Docker Compose plugin

The full stack (`backend`, `web`, `postgres`, `pgbouncer`, `redis`, `caddy`, `prometheus`,
`grafana`) runs via Docker Compose (Section 14.5).

- [ ] Install Docker Engine from Docker's official apt repository.
- [ ] Install the `docker-compose-plugin` (provides the `docker compose` subcommand).
- [ ] Enable and start the Docker service so it survives reboots.
- [ ] Confirm `deploy` can run Docker (group membership from Section 1).

```bash
# Reference only — official convenience path
apt-get update
apt-get install -y ca-certificates curl gnupg
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# Verify
docker --version
docker compose version
```

---

## 4. Install Caddy

Caddy is the edge reverse proxy providing automatic TLS (Let's Encrypt) for `api.`, `ws.`,
the web domain, and the IP-restricted `grafana.` host (Section 12.7 / 13.2). Install Caddy on
the host (or run it as a compose service per Section 14.5 — follow the approach the compose
file uses; this checklist installs the host package for the initial bootstrap).

- [ ] Install Caddy from its official apt repository.
- [ ] Enable and start the Caddy service.
- [ ] Ensure ports 80 and 443 are open in any firewall/security group so ACME issuance works.

```bash
# Reference only
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy
systemctl enable --now caddy
```

> The actual reverse-proxy configuration lives in the repository `Caddyfile`
> (`infra/caddy/`). DNS records for `<DOMAIN>`, `api.<DOMAIN>`, `ws.<DOMAIN>`, and
> `grafana.<DOMAIN>` must point at the VPS before Let's Encrypt can issue certificates.

---

## 5. Clone the repository to `/app`

The deploy pipeline pulls into a checkout on the VPS. Establish that checkout once, owned by
`deploy`.

- [ ] Create `/app` owned by `deploy`.
- [ ] Clone the repository into `/app` (as the `deploy` user).

```bash
# Reference only — run as root to create the directory
install -d -o deploy -g deploy /app

# Then, as the deploy user
sudo -iu deploy
git clone <REPO_URL> /app
```

---

## 6. Environment files (`.env`) — managed by the pipeline

**Do not hand-write production `.env` files on the VPS.** Each service reads its own
`.env.{service}` file that the **deploy pipeline writes from GitHub Secrets** at deploy time
(Section 14.5). Secrets are sourced from the classified categories (A VPS access, B Firebase,
E database, F storage, G monitoring, H backup encryption, I application security — Section
14.3) and never committed to the repo.

- [ ] Confirm **no** secret `.env` files are created manually here.
- [ ] Confirm the required GitHub Secrets are populated so the pipeline can render the env
      files (see the GitHub Secrets classification document).

> If a one-off local override is ever needed for debugging, create it as a temporary file
> outside source control and remove it afterward — the canonical source of truth is GitHub
> Secrets.

---

## 7. Kernel tuning for WebSocket performance (`sysctl`)

The realtime gateway holds many concurrent WebSocket connections. Raise socket buffer limits
and ensure low-latency delivery. Persist these in `/etc/sysctl.d/` so they survive reboots.

- [ ] Set `net.core.rmem_max` to 16 MB (16777216).
- [ ] Set `net.core.wmem_max` to 16 MB (16777216).
- [ ] Ensure low-latency send behavior (`tcp_nodelay` / disable Nagle for the proxy/app);
      the app sets `TCP_NODELAY` on sockets, recorded here for operator awareness.
- [ ] Apply the settings and verify the live values.

```bash
# Reference only — write a persistent sysctl drop-in
cat > /etc/sysctl.d/99-chitchat-websocket.conf <<'EOF'
# Max socket receive/send buffer sizes — 16 MB for high-concurrency WebSocket traffic
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
EOF

# Apply now (no reboot required)
sysctl --system

# Verify
sysctl net.core.rmem_max
sysctl net.core.wmem_max
```

> About `tcp_nodelay`: there is no kernel-wide `sysctl` toggle named `tcp_nodelay`. Nagle's
> algorithm is disabled **per-socket** via the `TCP_NODELAY` socket option, which the backend
> and Caddy set on their connections. It is listed here so operators understand that
> low-latency, no-Nagle behavior is expected for the WebSocket path. No host change is
> required for it beyond the buffer sizes above.

---

## Completion criteria

Provisioning is complete when all of the following hold:

- [ ] A non-root `deploy` user exists and belongs to both the `sudo` and `docker` groups.
- [ ] The GitHub Actions public key is in `deploy`'s `authorized_keys`, and key-based SSH
      login works.
- [ ] `docker --version` and `docker compose version` both succeed.
- [ ] `caddy` is installed and running; ports 80/443 are reachable; DNS points at the VPS.
- [ ] The repository is cloned at `/app`, owned by `deploy`.
- [ ] No secret `.env` files were hand-written; required GitHub Secrets are populated.
- [ ] `net.core.rmem_max` and `net.core.wmem_max` report `16777216`, persisted under
      `/etc/sysctl.d/`.

Once these pass, hand off to GitHub Actions: the `backend.yml` / `web.yml` pipelines will SSH
in as `deploy`, write the env files from Secrets, run `docker compose up --build -d`, run
migrations, and verify `/health`.
