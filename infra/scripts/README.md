# infra/scripts

Deploy and migration scripts invoked by the GitHub Actions pipelines
(`backend.yml`, `web.yml`). Authored in task 13.3 (design §14.2 / §14.5,
Requirement 10).

> **Secret masking.** GitHub Actions automatically masks every value registered
> as a repository/organization Secret wherever it would otherwise appear in
> workflow logs. These scripts add defence-in-depth: every secret is read from an
> environment variable (sourced from GitHub Secrets, never hardcoded), no script
> ever echoes a secret value, `set -x` is never enabled while secrets are in
> scope, and per-service `.env.{service}` files are created with `0600`
> permissions before any value is written (Requirements 10.3, 10.4).

## Scripts

| Script | Purpose |
| --- | --- |
| `lib.sh` | Shared helpers: strict-mode setup, non-secret logging, `require_present` (asserts env vars by name only), and `write_env_file` (writes `0600` env files without printing values). |
| `deploy.sh <backend\|web>` | VPS deploy entrypoint: `git pull --ff-only`, write `.env.{service}` files from injected secrets, `docker compose up --build -d <service>`, run migrations (backend), then verify `/health`. |
| `migrate.sh` | Runs `docker compose exec -T backend npm run migration:run` inside the running backend container (Requirement 10.7). |
| `health-check.sh` | Polls `/health` up to 5 times at 10-second intervals; exits non-zero (failing the pipeline) if it never reports healthy (Requirement 10.7). |

All scripts are `bash`, use `set -euo pipefail`, and are safe to re-run.

## Usage

The pipelines export secrets as environment variables (from GitHub Secrets) and
run, on the VPS checkout:

```sh
# Backend deploy: writes .env.backend/.env.postgres/.env.pgbouncer, restarts the
# backend, runs migrations, then polls https://api.<DOMAIN>/health.
DOMAIN="example.com" bash infra/scripts/deploy.sh backend

# Web deploy: writes .env.web, restarts the web service, then polls
# https://<DOMAIN>/health.
DOMAIN="example.com" bash infra/scripts/deploy.sh web
```

`migrate.sh` and `health-check.sh` can also be invoked directly:

```sh
bash infra/scripts/migrate.sh
HEALTH_URL="https://api.example.com/health" bash infra/scripts/health-check.sh
```

### Environment variables

- **Secrets (from GitHub Secrets, see `.github/SECRETS.md`)** — backend:
  `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`,
  `DATABASE_URL`, `PGBOUNCER_URL`, `REDIS_URL`, `SENTRY_DSN_BACKEND`,
  `JWT_SECRET`, `ENCRYPTION_KEY` (required) plus optional `SHADOW_MASTER_KEY_SALT`,
  `B2_*`, `MONITORING_CIDRS`, `PORT`, `WS_PORT`; web: `SENTRY_DSN_WEB`,
  `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`.
- **Deploy controls** — `DOMAIN` (or `HEALTH_URL`) for the health probe;
  optional `COMPOSE_DIR` (default `infra/docker`), `SKIP_GIT_PULL`,
  `HEALTH_ATTEMPTS`, `HEALTH_INTERVAL`, `HEALTH_EXPECT`.
