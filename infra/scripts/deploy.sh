#!/usr/bin/env bash
# infra/scripts/deploy.sh — VPS deploy entrypoint invoked by the GitHub Actions
# pipelines backend.yml / web.yml (task 13.3; design §14.2, §14.5).
#
# Requirements:
#   10.3 — every secret is sourced from GitHub Secrets and injected as an
#          environment variable at deploy time (this script reads only env vars).
#   10.4 — secret values are excluded from log output (no value is ever echoed;
#          `.env.{service}` files are written with 0600 perms; `set -x` is never
#          enabled while secrets are in scope).
#   10.7 — after the service is (re)built and started, database migrations run
#          (backend only), then `health-check.sh` verifies `/health`.
#
# GitHub Actions auto-masks every registered secret in workflow logs; this script
# adds defence-in-depth by never printing secret values itself.
#
# Usage (run from the repository root on the VPS, with secrets exported as env
# vars by the pipeline):
#   bash infra/scripts/deploy.sh backend
#   bash infra/scripts/deploy.sh web
#
# Environment:
#   SERVICE secrets         — see write_env_file calls below (sourced from Secrets).
#   COMPOSE_DIR  (optional) — path to the compose directory.
#                             Default: <repo-root>/infra/docker
#   SKIP_GIT_PULL (optional) — set to "1" to skip `git pull` (e.g. local testing).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

SERVICE="${1:-}"
if [ "${SERVICE}" != "backend" ] && [ "${SERVICE}" != "web" ]; then
  fail "usage: deploy.sh <backend|web> (received: '${SERVICE:-<empty>}')"
fi

# Repository root is two levels up from infra/scripts.
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-${REPO_ROOT}/infra/docker}"

[ -d "${COMPOSE_DIR}" ] || fail "compose directory not found: ${COMPOSE_DIR}"

# ---------------------------------------------------------------------------
# 1. Pull the latest code (fast-forward only so a dirty/diverged tree fails
#    loudly rather than silently deploying the wrong commit).
# ---------------------------------------------------------------------------
if [ "${SKIP_GIT_PULL:-0}" = "1" ]; then
  log "skipping git pull (SKIP_GIT_PULL=1)"
else
  log "pulling latest code in ${REPO_ROOT}"
  git -C "${REPO_ROOT}" pull --ff-only
fi

# ---------------------------------------------------------------------------
# 2. Write per-service .env.{service} files from the injected secrets.
#    Only NAMES are logged; values are written straight into 0600 files.
# ---------------------------------------------------------------------------
if [ "${SERVICE}" = "backend" ]; then
  # Backend secrets: Firebase (B), database/cache (E), monitoring (G), storage
  # (F), application security (I). Mirrors apps/backend REQUIRED_ENV_VARS plus
  # the storage/shadow-key extras. Required ones are asserted present first so
  # the deploy fails fast (and prints only the missing NAMES) before container
  # restart.
  require_present \
    FIREBASE_PROJECT_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY \
    DATABASE_URL PGBOUNCER_URL REDIS_URL \
    SENTRY_DSN_BACKEND JWT_SECRET ENCRYPTION_KEY

  write_env_file "${COMPOSE_DIR}/.env.backend" \
    FIREBASE_PROJECT_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY \
    DATABASE_URL PGBOUNCER_URL REDIS_URL \
    SENTRY_DSN_BACKEND \
    JWT_SECRET ENCRYPTION_KEY SHADOW_MASTER_KEY_SALT \
    B2_KEY_ID B2_APPLICATION_KEY B2_BUCKET_NAME B2_VIEWONCE_BUCKET_NAME \
    MONITORING_CIDRS PORT WS_PORT

  # Dependent services that the backend stack needs. These are optional here:
  # only written when their secrets are present so re-deploying a single service
  # never clobbers an existing file with empties.
  write_env_file "${COMPOSE_DIR}/.env.postgres" \
    POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  write_env_file "${COMPOSE_DIR}/.env.pgbouncer" \
    DATABASE_URL
else
  # Web secrets: public API/WS origins plus the web Sentry DSN (G).
  write_env_file "${COMPOSE_DIR}/.env.web" \
    SENTRY_DSN_WEB NEXT_PUBLIC_API_URL NEXT_PUBLIC_WS_URL
fi

# ---------------------------------------------------------------------------
# 3. Build and (re)start only the target service. `up --build -d` rebuilds the
#    image from the freshly pulled code and restarts the container detached.
# ---------------------------------------------------------------------------
log "building and starting '${SERVICE}' via docker compose"
docker compose --project-directory "${COMPOSE_DIR}" -f "${COMPOSE_DIR}/docker-compose.yml" \
  up --build -d "${SERVICE}"

# ---------------------------------------------------------------------------
# 4. Backend only: run database migrations inside the running container before
#    health is verified (Req 10.7). Delegated to migrate.sh.
# ---------------------------------------------------------------------------
if [ "${SERVICE}" = "backend" ]; then
  COMPOSE_DIR="${COMPOSE_DIR}" bash "${SCRIPT_DIR}/migrate.sh"
fi

# ---------------------------------------------------------------------------
# 5. Verify the deployment is healthy (Req 10.7). The health URL is derived from
#    DOMAIN unless HEALTH_URL is supplied explicitly.
# ---------------------------------------------------------------------------
if [ -z "${HEALTH_URL:-}" ]; then
  [ -n "${DOMAIN:-}" ] || fail "set HEALTH_URL or DOMAIN so health can be verified"
  if [ "${SERVICE}" = "backend" ]; then
    HEALTH_URL="https://api.${DOMAIN}/health"
  else
    HEALTH_URL="https://${DOMAIN}/health"
  fi
fi

HEALTH_URL="${HEALTH_URL}" bash "${SCRIPT_DIR}/health-check.sh"

log "deploy of '${SERVICE}' completed successfully"
