/**
 * Status and auth-state types shared across the Phase 1 client messaging slice.
 *
 * Source of truth: design.md → "Components and Interfaces":
 *   - Client Component 1 (Auth_Service): `AuthState`
 *   - Client Component 4 (Realtime_Client): `ConnectionStatus`
 *   - Client Component 7 (UI / RenderableMessage): `MessageStatus`
 *
 * Pure type definitions with no runtime dependencies — importable by `apps/backend`,
 * `apps/web`, and `apps/mobile` alike.
 */

/**
 * Lifecycle status of a single message in the Conversation_Screen.
 *
 * - `sending`        — composed/queued, send in progress or pending reconnect (5.10, 6.5).
 * - `sent`           — acknowledged as received by the Backend_API (5.6, 6.5).
 * - `failed`         — not acknowledged within 30 s; delivery-error shown (5.11, 6.8).
 * - `received`       — inbound message decrypted and rendered (5.4).
 * - `delivery-error` — inbound envelope failed decryption; no plaintext rendered (5.5, 6.9).
 */
export type MessageStatus =
  | 'sending'
  | 'sent'
  | 'failed'
  | 'received'
  | 'delivery-error';

/**
 * Realtime_Client connection status surfaced to the Conversation_Screen (4.7, 6.6).
 *
 * - `connected`    — WebSocket is open.
 * - `disconnected` — WebSocket is closed or reconnecting.
 */
export type ConnectionStatus = 'connected' | 'disconnected';

/**
 * Auth_Service authentication state surfaced to the UI and consumers (1.4, 1.9).
 *
 * Discriminated on `status`:
 * - `signed-out`       — no valid Firebase ID token; show the Sign_In_Screen.
 * - `signed-in`        — token + uid available for the Device_Registrar / Realtime_Client.
 * - `reauth-required`  — token refresh exhausted; return to Sign_In_Screen.
 */
export type AuthState =
  | { status: 'signed-out' }
  | { status: 'signed-in'; uid: string; token: string }
  | { status: 'reauth-required' };
