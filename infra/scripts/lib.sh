#!/usr/bin/env bash
# infra/scripts/lib.sh — shared helpers for the deploy/migrate scripts (task 13.3).
#
# Requirements: 10.3 (every secret sourced from GitHub Secrets and injected as an
# environment variable at deploy time), 10.4 (secret values never appear in log
# output), 10.7 (migrations run, then health is verified after deploy).
#
# SECRET MASKING NOTE
# -------------------
# GitHub Actions automatically masks any value registered as a repository/org
# Secret wherever it would appear in workflow logs. These scripts add a second
# layer of defence: they NEVER echo a secret value, NEVER enable `set -x` while a
# secret is in scope, and write secrets only into per-service `.env.{service}`
# files created with restrictive (0600) permissions. Callers must therefore pass
# secrets as environment variables — never as command-line arguments (argv is
# visible in process listings) and never inlined into log statements.

# Strict mode: abort on error, undefined variable, or failed pipe element.
set -euo pipefail

# ---------------------------------------------------------------------------
# log <message...>
#   Print a timestamped, NON-SECRET status line to stderr. Only pass literal,
#   non-sensitive text here. Secret values must never be passed to `log`.
# ---------------------------------------------------------------------------
log() {
  printf '[deploy %s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# ---------------------------------------------------------------------------
# fail <message...>
#   Emit an error line and exit non-zero so the invoking pipeline step fails.
# ---------------------------------------------------------------------------
fail() {
  printf '[deploy %s] ERROR: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# require_present <NAME...>
#   Verify each named environment variable is set and non-empty WITHOUT printing
#   its value. Only the variable NAMES (never the values) are ever logged.
#   Collects every missing name so the operator sees the full gap at once.
# ---------------------------------------------------------------------------
require_present() {
  local missing=()
  local name
  for name in "$@"; do
    # Indirect expansion; ${!name:-} yields empty when unset (safe under `set -u`).
    if [ -z "${!name:-}" ]; then
      missing+=("${name}")
    fi
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    fail "missing required environment variable(s): ${missing[*]}"
  fi
}

# ---------------------------------------------------------------------------
# write_env_file <target_path> <NAME...>
#   Write a docker-compose `.env.{service}` file containing `NAME=value` lines,
#   one per supplied variable that is present in the environment. The file is
#   created with a 0600 mode (owner read/write only) BEFORE any value is written,
#   so secret material is never world-readable and never reaches stdout/stderr.
#
#   Values are taken verbatim from the environment via indirect expansion; the
#   function prints only the count of variables written and the NAMES — never a
#   value. Variables that are absent are skipped (optional config stays optional).
# ---------------------------------------------------------------------------
write_env_file() {
  local target="$1"
  shift

  # Restrict permissions up front so the file is never momentarily world-readable.
  local prev_umask
  prev_umask="$(umask)"
  umask 077

  # Truncate/create with restrictive perms. `: >` avoids echoing any content.
  : > "${target}"
  chmod 600 "${target}"

  local name
  local written=()
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then
      # Append `NAME=value` literally. printf writes ONLY to the file (no stdout),
      # so the secret value never appears in log output.
      printf '%s=%s\n' "${name}" "${!name}" >> "${target}"
      written+=("${name}")
    fi
  done

  umask "${prev_umask}"

  # Log names only — counts and identifiers are safe; values are not printed.
  log "wrote ${#written[@]} variable(s) to $(basename "${target}"): ${written[*]:-<none>}"
}
