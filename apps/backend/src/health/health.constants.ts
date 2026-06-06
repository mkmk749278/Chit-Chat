/**
 * Tunables for the health endpoint (Requirement 11).
 *
 * The per-dependency ping budget (Requirement 11.1/11.4) and the overall response
 * bound (Requirement 11.5) are expressed here so the controller, service, and tests
 * all agree on the same numbers.
 */

/**
 * Per-dependency ping budget in milliseconds. A dependency that does not answer a
 * ping within this window is reported `down` (Requirements 11.1, 11.4).
 */
export const HEALTH_PING_TIMEOUT_MS = 2_000;

/**
 * Hard upper bound, in milliseconds, on how long `health()` may take to produce a
 * response regardless of dependency state (Requirement 11.5). Because both pings run
 * concurrently and are each capped at {@link HEALTH_PING_TIMEOUT_MS}, the natural
 * worst case is ~2 s; this bound is the contractual ceiling the design promises.
 */
export const HEALTH_RESPONSE_BUDGET_MS = 5_000;
