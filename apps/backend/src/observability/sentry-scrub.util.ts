/**
 * Framework-agnostic scrubbing for Sentry error reports (Requirements 12.5, 13.2,
 * 8.5).
 *
 * This module holds the security-sensitive logic that guarantees token and secret
 * values never leave the process inside a Sentry event. It is deliberately
 * decoupled from the Sentry SDK and from NestJS so it can be unit/property tested
 * against plain objects without booting either.
 *
 * Three independent defences are applied to every outbound event (see
 * {@link scrubEvent}):
 *   1. Key-based redaction — the *value* of any object key whose name looks like a
 *      token/secret (e.g. `authorization`, `token`, `password`, `privateKey`,
 *      `dsn`) is replaced with {@link REDACTED}, wherever it appears in the event
 *      tree (headers, request data, `extra`, breadcrumbs, …).
 *   2. Bearer-token redaction — any `Bearer <token>` substring inside a free-text
 *      string (message, exception value, stack frame, …) is collapsed to
 *      `Bearer [REDACTED]`.
 *   3. Literal-secret redaction — the *actual* configured secret values (the
 *      Sentry DSN, Firebase private key, DB/Redis URLs, JWT/encryption keys, …)
 *      are matched verbatim anywhere in any string and replaced with
 *      {@link REDACTED}, so a secret that leaked into a message or stack trace can
 *      never be transmitted.
 */

/** Replacement string written in place of any redacted token/secret value. */
export const REDACTED = '[REDACTED]';

/**
 * Matches object key names that may carry a token or secret value. A matching
 * key has its value redacted outright regardless of the value's content.
 * Case-insensitive.
 */
export const SENTRY_SENSITIVE_KEY_PATTERN =
  /(authorization|token|secret|password|passwd|api[-_]?key|credential|cookie|session|bearer|private[-_]?key|dsn|jwt|encryption[-_]?key)/i;

/**
 * Matches an HTTP `Bearer <token>` credential embedded in free text. Global +
 * case-insensitive so every occurrence in a string is replaced.
 */
export const BEARER_TOKEN_PATTERN = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * Environment variables whose *literal values* must be scrubbed from any event.
 * These are the backend's secret-bearing configuration (design.md §14.3) — if any
 * of their values appears verbatim in a message, exception, or stack frame it is
 * replaced with {@link REDACTED}.
 */
export const SECRET_BEARING_ENV_VARS = [
  'SENTRY_DSN_BACKEND',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_CLIENT_EMAIL',
  'DATABASE_URL',
  'PGBOUNCER_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
] as const;

/**
 * Minimum length a configured value must have before it is treated as a literal
 * secret to search for. Guards against redacting trivially short values (which
 * would otherwise blank out large swathes of unrelated text).
 */
const MIN_SECRET_LENGTH = 6;

/** Maximum recursion depth when walking an event tree (defence against deep/cyclic input). */
const MAX_DEPTH = 12;

/**
 * Collect the distinct literal secret values to scrub from the given environment.
 *
 * Returns the trimmed, sufficiently-long values of every {@link SECRET_BEARING_ENV_VARS}
 * entry, plus the newline-normalised form of `FIREBASE_PRIVATE_KEY` (CI/`.env`
 * commonly store it with escaped `\n`). Sorted longest-first so that, when one
 * secret contains another, the longer match is redacted before the shorter one.
 */
export function collectSecretValues(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const values = new Set<string>();

  for (const name of SECRET_BEARING_ENV_VARS) {
    const raw = env[name];
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) {
      values.add(trimmed);
    }
    // Private keys are frequently stored with literal `\n`; the running process
    // normalises them to real newlines, so guard against both representations.
    const normalised = trimmed.replace(/\\n/g, '\n');
    if (normalised !== trimmed && normalised.length >= MIN_SECRET_LENGTH) {
      values.add(normalised);
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

/** Escape a string so it can be embedded safely inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact secrets from a single string: first collapse any `Bearer <token>`
 * credential, then replace every verbatim occurrence of a known secret value.
 */
export function scrubString(value: string, secretValues: readonly string[]): string {
  let result = value.replace(BEARER_TOKEN_PATTERN, `Bearer ${REDACTED}`);

  for (const secret of secretValues) {
    if (secret.length === 0) {
      continue;
    }
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }

  return result;
}

/**
 * Recursively scrub an arbitrary value:
 *   - strings are passed through {@link scrubString};
 *   - arrays are scrubbed element-wise;
 *   - objects have any sensitive-keyed value redacted outright and the rest
 *     recursed into;
 *   - all other primitives are returned unchanged.
 *
 * Cycles are broken with a `WeakSet`, and recursion is bounded by {@link MAX_DEPTH}.
 */
function scrubUnknown(
  input: unknown,
  secretValues: readonly string[],
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (typeof input === 'string') {
    return scrubString(input, secretValues);
  }

  if (input === null || typeof input !== 'object') {
    return input;
  }

  if (depth >= MAX_DEPTH) {
    return REDACTED;
  }

  if (seen.has(input)) {
    return '[Circular]';
  }
  seen.add(input);

  if (Array.isArray(input)) {
    return input.map((item) => scrubUnknown(item, secretValues, seen, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    if (SENTRY_SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = scrubUnknown(val, secretValues, seen, depth + 1);
  }
  return output;
}

/**
 * Scrub a Sentry event tree in place of any token or secret value (Requirement
 * 12.5, 13.2). Returns a new, sanitised copy of the event; the input is not
 * mutated.
 *
 * @param event - the event-like object Sentry is about to send.
 * @param secretValues - literal secret values to redact (from {@link collectSecretValues}).
 */
export function scrubEvent<T extends Record<string, unknown>>(
  event: T,
  secretValues: readonly string[] = [],
): T {
  return scrubUnknown(event, secretValues, new WeakSet<object>(), 0) as T;
}
