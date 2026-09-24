/**
 * Ciphertext envelope (wire format) and WebSocket frame types for 1:1 messaging.
 *
 * Source of truth: design.md → "Data Models" → "Ciphertext envelope (wire format)".
 *
 * The envelope carries only routing metadata and libsignal ciphertext. There is no
 * plaintext field anywhere on these types, so there is no code path by which message
 * plaintext can be serialized to the socket (Requirements 5.3, 5.7, 8.2).
 *
 * Pure type definitions with no runtime dependencies — importable by `apps/backend`,
 * `apps/web`, and `apps/mobile` alike.
 */

/** Routing metadata — no message content. */
export interface EnvelopeRouting {
  /** Firebase UID of the sender. */
  senderUid: string;
  /** Recipient_Identifier (Firebase UID). */
  recipientUid: string;
  /** Server-issued deviceId of the sending device. */
  senderDeviceId: string;
  /** Per-conversation strictly monotonic sequence number (5.3, 6.2). */
  seq: number;
}

/** libsignal ciphertext body. `type` is the libsignal message type, NOT plaintext. */
export interface CiphertextBody {
  /** 1 = SignalMessage (whisper), 3 = PreKeySignalMessage. */
  type: 1 | 3;
  /** base64 libsignal ciphertext — opaque to the server. */
  ciphertext: string;
}

/** The full wire frame for a 1:1 message. */
export interface CiphertextEnvelope extends EnvelopeRouting, CiphertextBody {}

/**
 * Realtime wire-protocol version this build speaks (Reliable delivery, protocol v2).
 *
 * v1 (legacy): the server relays `deliver` frames at-most-once — an envelope pushed to a socket
 * that dies before the client processes it is lost, and the offline queue is drained destructively
 * on connect.
 *
 * v2: every relayed envelope is held in the recipient's server-side inbox under a server-assigned
 * `id` until the client confirms it with a `delivered` frame (at-least-once). The inbox is replayed
 * on every (re)connect, so the client MUST dedupe by `id`. v2 also adds an application-level
 * `ping`/`pong` so a client can detect a zombie socket it would otherwise never see close.
 *
 * Negotiation is explicit and backward compatible in both directions: a v2 client adds
 * `?{@link REALTIME_PROTOCOL_QUERY_PARAM}=2` to the WebSocket URL (a non-secret capability flag —
 * the token still rides the subprotocol only); a v2 server answers with a `hello` frame. A v2 client
 * talking to a v1 server never receives `hello` and keeps v1 behaviour; a v1 client talking to a v2
 * server never sends the flag and is served v1 semantics.
 */
export const REALTIME_PROTOCOL_VERSION = 2;

/** Query-string key carrying the client's realtime protocol version on the WebSocket URL. */
export const REALTIME_PROTOCOL_QUERY_PARAM = 'v';

/** Client → server frames. */
export type ClientToServerFrame =
  | { kind: 'send'; envelope: CiphertextEnvelope }
  /**
   * Ephemeral typing notification (Req 5.3): tells the server to relay a "typing" hint to
   * `recipientUid`. Carries no content and is NEVER persisted or queued for store-and-forward.
   */
  | { kind: 'typing'; recipientUid: string }
  /**
   * Protocol v2: confirms the listed inbox entry ids were durably processed by this device, so the
   * server can drop them from the recipient's inbox. Only ever removes entries from the
   * authenticated caller's OWN inbox.
   */
  | { kind: 'delivered'; ids: string[] }
  /** Protocol v2: application-level liveness probe; the server answers with `pong`. */
  | { kind: 'ping' };

/** Server → client frames. */
export type ServerToClientFrame =
  /**
   * An envelope for this device. `id` (protocol v2) is the server inbox entry id: the client
   * acknowledges it with a `delivered` frame once processed, and uses it to drop duplicates (an
   * unacknowledged entry is replayed on every reconnect).
   */
  | { kind: 'deliver'; envelope: CiphertextEnvelope; id?: string }
  | { kind: 'ack'; recipientUid: string; seq: number; status: 'received'; nodes?: number }
  /** Ephemeral typing hint relayed from a peer (Req 5.3); `fromUid` is the peer who is typing. */
  | { kind: 'typing'; fromUid: string }
  /** Protocol v2: sent once after a v2 handshake, before any inbox replay. */
  | { kind: 'hello'; protocol: number }
  /** Protocol v2: answer to a client `ping`. */
  | { kind: 'pong' };
