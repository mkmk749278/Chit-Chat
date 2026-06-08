/**
 * Environment configuration contract and fail-fast validation (Requirement 1.4).
 *
 * The ConfigModule validates the process environment at startup. If one or more
 * variables in the required configuration set are absent, validation throws an
 * error that lists the name of EVERY missing variable (not just the first), so the
 * Backend_API terminates before it accepts any request.
 *
 * The required set mirrors the backend-relevant GitHub Secrets the design enumerates
 * (design.md §14.3):
 *   - Category B (Firebase):        FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *   - Category E (database/cache):  DATABASE_URL, PGBOUNCER_URL, REDIS_URL
 *   - Category I (app security):    JWT_SECRET, ENCRYPTION_KEY
 *
 * SENTRY_DSN_BACKEND (Category G) is OPTIONAL: when blank the SentryService stays
 * disabled, so the backend boots without a Sentry project. PORT and WS_PORT are also
 * optional and fall back to the bootstrap defaults (3000/3001).
 */

/**
 * The names of every environment variable that MUST be present for the Backend_API
 * to start. Absence of any of these is a fatal, fail-fast startup error.
 */
export const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'PGBOUNCER_URL',
  'REDIS_URL',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'JWT_SECRET',
  'ENCRYPTION_KEY',
] as const;

/** A required environment variable name. */
export type RequiredEnvVar = (typeof REQUIRED_ENV_VARS)[number];

/** Default REST/HTTP port when `PORT` is not supplied (matches main.ts bootstrap). */
export const DEFAULT_HTTP_PORT = 3000;

/** Default WebSocket port when `WS_PORT` is not supplied (matches main.ts bootstrap). */
export const DEFAULT_WS_PORT = 3001;

/**
 * The validated, typed application configuration produced from the environment.
 * Required string values are guaranteed present (validation throws otherwise);
 * the ports are always resolved to a positive integer.
 */
export type AppConfig = Readonly<Record<RequiredEnvVar, string>> & {
  /** Resolved REST/HTTP listen port. */
  readonly PORT: number;
  /** Resolved WebSocket listen port. */
  readonly WS_PORT: number;
  /**
   * Optional Sentry DSN for backend error reporting. Blank when unset, in which
   * case `SentryService` stays disabled and all capture calls are no-ops — so the
   * backend boots fine without a Sentry project (Category G is optional for boot).
   */
  readonly SENTRY_DSN_BACKEND: string;
  /**
   * Optional comma/whitespace-separated CIDR allowlist that restricts the
   * Prometheus `/metrics` endpoint to the monitoring network (Requirement 12.7,
   * 13.6). Empty when unset, in which case the private/loopback defaults apply.
   */
  readonly MONITORING_CIDRS: string;
};

/**
 * Thrown when one or more required environment variables are absent. Carries the
 * full list of missing variable names so callers/tests can assert on every gap.
 */
export class MissingEnvironmentError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'The backend cannot start until every required variable is set.',
    );
    this.name = 'MissingEnvironmentError';
  }
}

/**
 * Thrown when an optional variable is present but cannot be parsed (e.g. a non-numeric
 * `PORT`). Kept distinct from {@link MissingEnvironmentError} so a malformed value is
 * not misreported as a missing one.
 */
export class InvalidEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidEnvironmentError';
  }
}

/**
 * Returns true when an environment value counts as "absent": undefined, or a string
 * that is empty or only whitespace. A blank value is treated as missing because it
 * cannot configure a real dependency.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim().length === 0);
}

/**
 * Parses an optional port value, falling back to `fallback` when absent. Accepts only
 * an integer in the valid TCP port range (1..65535).
 *
 * @throws {InvalidEnvironmentError} when the value is present but not a valid port.
 */
function parsePort(name: string, value: string | undefined, fallback: number): number {
  if (isAbsent(value)) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new InvalidEnvironmentError(
      `Environment variable ${name} must be an integer between 1 and 65535, received "${value}".`,
    );
  }
  return parsed;
}

/**
 * Validates the raw process environment and produces the typed {@link AppConfig}.
 *
 * This is the function wired into `@nestjs/config`'s `validate` hook, so it runs once
 * during module initialization — before the application begins accepting requests.
 *
 * Behavior (Requirement 1.4):
 *   - Scans the entire required set and collects EVERY missing variable.
 *   - If any are missing, throws {@link MissingEnvironmentError} listing all of them,
 *     aborting startup.
 *   - Resolves optional PORT/WS_PORT (with defaults), throwing
 *     {@link InvalidEnvironmentError} when a supplied value is malformed.
 *
 * @param raw - the raw environment record (defaults to `process.env`).
 * @returns the validated, typed configuration.
 */
export function validateEnv(raw: Record<string, unknown> = process.env): AppConfig {
  const missing = REQUIRED_ENV_VARS.filter((name) => isAbsent(raw[name]));
  if (missing.length > 0) {
    throw new MissingEnvironmentError(missing);
  }

  const config: Record<string, unknown> = {
    PORT: parsePort('PORT', raw.PORT as string | undefined, DEFAULT_HTTP_PORT),
    WS_PORT: parsePort('WS_PORT', raw.WS_PORT as string | undefined, DEFAULT_WS_PORT),
    // Optional: blank when unset so the monitoring-network guard falls back to its
    // private/loopback default allowlist.
    MONITORING_CIDRS: isAbsent(raw.MONITORING_CIDRS)
      ? ''
      : String(raw.MONITORING_CIDRS).trim(),
    // Optional: blank when unset so Sentry stays disabled rather than blocking boot.
    SENTRY_DSN_BACKEND: isAbsent(raw.SENTRY_DSN_BACKEND)
      ? ''
      : String(raw.SENTRY_DSN_BACKEND).trim(),
  };

  for (const name of REQUIRED_ENV_VARS) {
    // Safe: every required name passed the absence check above.
    config[name] = String(raw[name]).trim();
  }

  return config as AppConfig;
}
