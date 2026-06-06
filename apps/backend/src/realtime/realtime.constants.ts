/**
 * RealtimeModule constants — WebSocket close codes and the gateway listen port.
 *
 * The close codes live in the application-private range (4000–4999, per RFC 6455)
 * so they never collide with protocol-level codes and clients can react to them
 * specifically (e.g. re-authenticate on 4401, back off on 4503).
 */

/**
 * Close code for an unauthenticated handshake — missing/malformed token or a token
 * Firebase rejected as invalid/expired/revoked (Requirements 3.1, 8.x). The client
 * should refresh its Firebase ID token and reconnect.
 */
export const WS_CLOSE_UNAUTHORIZED = 4401;

/**
 * Close code for "verification dependency unavailable" — Firebase was unreachable on
 * a cache miss or did not respond within the 5-second budget (Requirements 3.8, 8.5).
 * The client should back off and retry; already-cached valid tokens keep working.
 */
export const WS_CLOSE_VERIFICATION_UNAVAILABLE = 4503;

/**
 * Close code for a handshake rejected by the rate limiter — the per-uid handshake
 * surface exceeded its configured fixed-window limit (Requirements 5.2, 5.4). Mirrors
 * HTTP 429 ("Too Many Requests") in the application-private range so the client can
 * back off and retry once the window resets. No registry/`presence` entry is created
 * on this path.
 */
export const WS_CLOSE_RATE_LIMITED = 4429;

/**
 * Rate-limit configuration for the WebSocket handshake surface (Requirement 5.2). The
 * limiter keys on `ws-handshake:{uid}`, so this caps how many handshakes a single
 * authenticated user may complete per window. Phase 0 wires the limiter to protect the
 * surface against abuse; the precise values are tuned in later phases (design §"Rate
 * limiting"). Both values sit within the limiter's permitted ranges
 * (`1..1000000` / `1..86400`).
 */
export const WS_HANDSHAKE_RATE_LIMIT = 30;
export const WS_HANDSHAKE_RATE_WINDOW_SECONDS = 60;

/** The `{scope}` portion of the handshake rate-limit key (`ws-handshake:{uid}`). */
export const WS_HANDSHAKE_RATE_LIMIT_SCOPE = 'ws-handshake';

/**
 * Heartbeat cadence in milliseconds (Requirements 3.2, 3.6; design §12.1 + "WebSocket
 * heartbeat liveness"). Every {@link WS_HEARTBEAT_INTERVAL_MS} the gateway pings every
 * registered connection and terminates any socket that did not answer the previous
 * ping with a `pong`. Because a missed pong is detected on the *next* tick, a dead
 * socket is terminated within one interval of the missed pong — comfortably inside the
 * 5-second registry-cleanup window once the close fires (Requirement 3.3).
 */
export const WS_HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * WebSocket listen port. Caddy reverse-proxies the `ws.` subdomain here (§9.4).
 *
 * Read from `WS_PORT` (default 3001) at module-load time because the
 * `@WebSocketGateway()` decorator binds the port when the class is defined, before
 * DI is available to inject {@link AppConfigService}. `main.ts` resolves the same
 * value the same way, so the REST :3000 + WS :3001 contract stays consistent.
 */
export const WS_PORT = Number(process.env.WS_PORT ?? 3001);
