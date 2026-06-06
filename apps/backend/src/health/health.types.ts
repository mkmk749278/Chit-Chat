/**
 * Public shape of the `/health` response (design Component 7: HealthController).
 *
 * The body is deliberately minimal: an overall status and a per-dependency
 * reachability indicator only. It carries no user data, credentials, secret values,
 * or connection strings (Requirement 11.3).
 */

/** Reachability of a single backing dependency. */
export type DependencyStatus = 'up' | 'down';

/** Overall service health derived from the per-dependency checks. */
export type HealthStatus = 'ok' | 'degraded';

/**
 * The `/health` response body.
 *
 * `status` is `ok` iff every dependency in `checks` is `up` (Requirement 11.1);
 * otherwise it is `degraded` and each `down` entry identifies an unreachable
 * dependency (Requirement 11.4).
 */
export interface HealthReport {
  status: HealthStatus;
  checks: {
    postgres: DependencyStatus;
    redis: DependencyStatus;
  };
  /** Whole seconds the process has been running. Operational signal only. */
  uptimeSeconds: number;
  /** Deployed application version. Non-sensitive build identifier. */
  version: string;
}
