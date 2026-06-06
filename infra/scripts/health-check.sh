#!/usr/bin/env bash
# infra/scripts/health-check.sh — poll the deployed `/health` endpoint after a
# deploy (task 13.3; design §14.2). Invoked by deploy.sh and reusable standalone.
#
# Requirements:
#   10.7 — after migrations, verify the `/health` endpoint, retrying up to 5
#          times at 10-second intervals until it reports healthy or the attempts
#          are exhausted (then the run fails).
#   10.4 — only the (non-secret) URL and status are logged.
#
# Exit status: 0 when the endpoint reports healthy within 5 attempts; non-zero
# otherwise, which fails the invoking pipeline step.
#
# Usage:
#   HEALTH_URL="https://api.example.com/health" bash infra/scripts/health-check.sh
#
# Environment:
#   HEALTH_URL (required) — full URL to poll.
#   HEALTH_ATTEMPTS  (optional, default 5)  — number of attempts.
#   HEALTH_INTERVAL  (optional, default 10) — seconds between attempts.
#   HEALTH_EXPECT    (optional) — substring the response body must contain
#                                 (e.g. '"status":"ok"'). When unset, any 2xx
#                                 response (curl --fail succeeding) is healthy.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=infra/scripts/lib.sh
. "${SCRIPT_DIR}/lib.sh"

HEALTH_URL="${HEALTH_URL:-}"
[ -n "${HEALTH_URL}" ] || fail "HEALTH_URL must be set"

ATTEMPTS="${HEALTH_ATTEMPTS:-5}"
INTERVAL="${HEALTH_INTERVAL:-10}"
EXPECT="${HEALTH_EXPECT:-}"

attempt=1
while [ "${attempt}" -le "${ATTEMPTS}" ]; do
  log "health check attempt ${attempt}/${ATTEMPTS}: ${HEALTH_URL}"

  # Capture the body so we can optionally assert on its content. `--fail` makes
  # curl exit non-zero on HTTP >= 400; `|| true` lets us inspect the result
  # without tripping `set -e`.
  body="$(curl -fsS --max-time 10 "${HEALTH_URL}" 2>/dev/null || true)"

  if [ -n "${body}" ]; then
    if [ -z "${EXPECT}" ] || printf '%s' "${body}" | grep -q "${EXPECT}"; then
      log "deployment is healthy"
      exit 0
    fi
  fi

  if [ "${attempt}" -lt "${ATTEMPTS}" ]; then
    log "not healthy yet; retrying in ${INTERVAL}s"
    sleep "${INTERVAL}"
  fi
  attempt=$((attempt + 1))
done

fail "/health did not report healthy after ${ATTEMPTS} attempts"
