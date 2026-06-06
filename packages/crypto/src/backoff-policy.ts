/**
 * `BackoffPolicy` — pure exponential-backoff math for the Phase 1 client (shared core).
 *
 * Both the `Device_Registrar` (HTTP 503 / 10 s timeout retries) and the `Realtime_Client`
 * (close-code-driven reconnection) compute reconnect/retry delays from the same policy:
 * a 500 ms base, doubling per attempt, capped at 30 s per interval, with randomised jitter.
 * Registration additionally stops once a cumulative 5-minute retry budget elapses, retaining
 * the unsent prekey bundle (Requirements 3.6, 3.8, 3.9, 4.5, 4.6, 4.10, 4.11).
 *
 * The policy is intentionally pure: randomness is supplied by an injected RNG (`() => number`
 * in `[0, 1)`) and elapsed time is supplied by the caller. This keeps the backoff math
 * unit- and property-testable without timers or a real clock (design §"Determinism").
 */

/** Default exponential-backoff base interval: 500 ms (Requirements 3.6, 4.5, 4.6). */
export const DEFAULT_BASE_MS = 500;

/** Default per-interval cap: 30 s (Requirements 3.6, 4.5, 4.6). */
export const DEFAULT_CAP_MS = 30_000;

/**
 * Default cumulative retry budget for device registration: 5 minutes (Requirements 3.6, 3.9).
 * Reconnection (Requirement 4.x) has no cumulative budget — it retries indefinitely — so this
 * value is only consulted through the registration-budget helpers.
 */
export const REGISTRATION_BUDGET_MS = 300_000;

/** A source of randomness returning a value in the half-open interval `[0, 1)`, like `Math.random`. */
export type Rng = () => number;

/** Construction options for {@link BackoffPolicy}. All fields are optional and default to the constants above. */
export interface BackoffPolicyOptions {
  /** Base interval in milliseconds for attempt 0. Defaults to {@link DEFAULT_BASE_MS}. */
  baseMs?: number;
  /** Maximum interval in milliseconds for any single attempt. Defaults to {@link DEFAULT_CAP_MS}. */
  capMs?: number;
  /** Cumulative registration retry budget in milliseconds. Defaults to {@link REGISTRATION_BUDGET_MS}. */
  budgetMs?: number;
  /**
   * Injected randomness used for jitter. Must return a number in `[0, 1)`. Defaults to `Math.random`.
   * Inject a deterministic generator in tests to make jitter reproducible.
   */
  rng?: Rng;
}

/**
 * Clamps a value into the inclusive `[lo, hi]` interval. `NaN` clamps to `lo` so a misbehaving
 * RNG can never push a delay outside the policy's bounds.
 */
function clamp(value: number, lo: number, hi: number): number {
  if (Number.isNaN(value) || value < lo) {
    return lo;
  }
  return value > hi ? hi : value;
}

/**
 * Computes the deterministic exponential target (pre-jitter) for `attempt`: `base * 2^attempt`,
 * saturated at `cap`. Attempt 0 yields exactly `base`. Large attempts overflow to `Infinity`,
 * which `Math.min` collapses back to `cap`, so the result is always within `[base, cap]`.
 */
function exponentialTarget(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(capMs, baseMs * 2 ** attempt);
}

/**
 * Stateless exponential-backoff policy with jitter and a cumulative registration budget.
 *
 * A single instance is safe to share across the registrar and the realtime client because it
 * holds no mutable per-attempt state — the caller passes the `attempt` number and the
 * cumulative `elapsedMs` on each call.
 */
export class BackoffPolicy {
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly budgetMs: number;
  private readonly rng: Rng;

  constructor(options: BackoffPolicyOptions = {}) {
    const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
    const capMs = options.capMs ?? DEFAULT_CAP_MS;
    const budgetMs = options.budgetMs ?? REGISTRATION_BUDGET_MS;

    if (!Number.isFinite(baseMs) || baseMs <= 0) {
      throw new TypeError('baseMs must be a positive, finite number of milliseconds');
    }
    if (!Number.isFinite(capMs) || capMs < baseMs) {
      throw new TypeError('capMs must be a finite number of milliseconds greater than or equal to baseMs');
    }
    if (!Number.isFinite(budgetMs) || budgetMs < 0) {
      throw new TypeError('budgetMs must be a non-negative, finite number of milliseconds');
    }
    if (typeof options.rng !== 'undefined' && typeof options.rng !== 'function') {
      throw new TypeError('rng must be a function returning a number in [0, 1)');
    }

    this.baseMs = baseMs;
    this.capMs = capMs;
    this.budgetMs = budgetMs;
    this.rng = options.rng ?? Math.random;
  }

  /**
   * Computes the jittered delay (in milliseconds) to wait before the given retry/reconnect attempt.
   *
   * The exponential target is `min(cap, base * 2^attempt)`; jitter then spreads the delay across the
   * band `[base, target]` using the injected RNG. The returned value is always within the inclusive
   * interval `[base, cap]` — never below the base and never above the cap — regardless of attempt
   * number or RNG output (Property 11; Requirements 3.6, 4.5, 4.6, 4.10, 4.11).
   *
   * @param attempt - zero-based attempt index (0 is the first retry). Must be a non-negative integer.
   * @throws {TypeError} if `attempt` is negative, non-finite, or not an integer.
   */
  delayForAttempt(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 0) {
      throw new TypeError('attempt must be a non-negative integer');
    }

    const target = exponentialTarget(attempt, this.baseMs, this.capMs);
    // Equal-jitter within the band [base, target]: stay at or above the base (Property 11) while
    // still randomising the wait to avoid synchronised retry storms across clients.
    const jittered = this.baseMs + this.rng() * (target - this.baseMs);
    return clamp(jittered, this.baseMs, this.capMs);
  }

  /**
   * Reports whether the cumulative registration retry budget (default 5 minutes) has been reached.
   * Registration retry loops call this to stop and surface a service-unavailable state while
   * retaining the generated prekey bundle (Requirements 3.6, 3.9).
   *
   * @param elapsedMs - cumulative time spent retrying so far, in milliseconds.
   * @returns `true` once `elapsedMs` is at or beyond the budget (the loop should stop).
   * @throws {TypeError} if `elapsedMs` is negative or non-finite.
   */
  isRegistrationBudgetExhausted(elapsedMs: number): boolean {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
      throw new TypeError('elapsedMs must be a non-negative, finite number of milliseconds');
    }
    return elapsedMs >= this.budgetMs;
  }

  /**
   * Convenience for registration retry loops: returns the jittered delay for `attempt` when there is
   * still budget remaining, or `null` when the cumulative budget is exhausted and the loop must stop.
   *
   * @param attempt - zero-based attempt index (see {@link delayForAttempt}).
   * @param elapsedMs - cumulative time spent retrying so far, in milliseconds.
   * @returns the delay to wait, or `null` to signal "stop retrying" (Requirements 3.6, 3.9).
   */
  nextRegistrationDelay(attempt: number, elapsedMs: number): number | null {
    if (this.isRegistrationBudgetExhausted(elapsedMs)) {
      return null;
    }
    return this.delayForAttempt(attempt);
  }
}
