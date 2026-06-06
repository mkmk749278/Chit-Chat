/**
 * DevicesModule constants — the `POST /api/devices/register` rate-limit configuration.
 *
 * Mirrors the WebSocket handshake limiter (RealtimeModule) so both Phase 0 entry points
 * are protected against abuse in the same fixed-window style (Requirement 5.2). The
 * limiter keys on `register:{uid}`, capping how many registrations a single authenticated
 * user may perform per window. Phase 0 wires the limiter to protect the surface; the
 * precise values are tuned in later phases (design §"Rate limiting"). Both values sit
 * within the limiter's permitted ranges (`1..1000000` / `1..86400`).
 */

/** Max device registrations allowed per window for a single authenticated uid. */
export const REGISTER_RATE_LIMIT = 30;

/** Length of the device-registration rate-limit window, in seconds. */
export const REGISTER_RATE_WINDOW_SECONDS = 60;

/** The `{scope}` portion of the registration rate-limit key (`register:{uid}`). */
export const REGISTER_RATE_LIMIT_SCOPE = 'register';
