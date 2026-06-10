/**
 * `apps/mobile` — backend endpoint configuration.
 *
 * The mobile client talks to the deployed backend over TLS: REST on `api.luminchat.app`
 * (device registration, prekey claim, directory) and the authenticated WebSocket on
 * `ws.luminchat.app` (message relay). These hosts are reverse-proxied by Caddy to the
 * backend's `:3000` / `:3001` (design §9.4).
 */

/** Base URL for the REST API (TLS-only). */
export const API_BASE_URL = 'https://api.luminchat.app';

/** Device-registration endpoint (`POST /api/devices/register`). */
export const REGISTER_URL = `${API_BASE_URL}/api/devices/register`;

/** Authenticated WebSocket endpoint (`wss://`); the token rides the bearer subprotocol. */
export const WS_URL = 'wss://ws.luminchat.app';
