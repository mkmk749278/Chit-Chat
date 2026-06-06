#!/usr/bin/env bash
# infra/scripts/migrate.sh — run database migrations inside the backend container
# (task 13.3; design §14.2). Invoked by deploy.sh after the backend is started,
# and reusable standalone by the pipeline.
#
# Requirements:
#   10.7 — when deployment completes, the deploy pipeline runs database migrations
#          (then verifies /health, handled by health-check.sh).
#   10.4 — no secret value is echoed. The migration runner reads the database
#          connection from the container's own `.env.backend` (already written
#          with 0600 perms by deploy.sh); this script prints only status text.
#
# The TypeORM `migration:run` script (apps/backend/package.json) halts and reports
# the failing migration on error (Requirement 6.6); a non-zero exit here fails the
# pipeline step, leaving the previous deployment untouched.
#
# Usage (from the repository root on the VPS):
#   bash infra/scripts/migrate.sh
#
# Environment:
#   COMPOSE_DIR (optional) — compose directory. Default: <repo-root>/infra/docker

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-${REPO_ROOT}/infra/docker}"

[ -d "${COMPOSE_DIR}" ] || fail "compose directory not found: ${COMPOSE_DIR}"

log "running database migrations (docker compose exec backend npm run migration:run)"

# `-T` disables pseudo-TTY allocation so this works over non-interactive SSH in
# the pipeline. The backend container loads DATABASE_URL/PGBOUNCER_URL from its
# env_file, so no secret is passed on the command line or printed here.
docker compose --project-directory "${COMPOSE_DIR}" -f "${COMPOSE_DIR}/docker-compose.yml" \
  exec -T backend npm run migration:run

log "database migrations applied"
