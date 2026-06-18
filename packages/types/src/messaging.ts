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

/** Client → server frames. */
export type ClientToServerFrame =
  | { kind: 'send'; envelope: CiphertextEnvelope }
  /**
   * Ephemeral typing notification (Req 5.3): tells the server to relay a "typing" hint to
   * `recipientUid`. Carries no content and is NEVER persisted or queued for store-and-forward.
   */
  | { kind: 'typing'; recipientUid: string };

/** Server → client frames. */
export type ServerToClientFrame =
  | { kind: 'deliver'; envelope: CiphertextEnvelope }
  | { kind: 'ack'; recipientUid: string; seq: number; status: 'received'; nodes?: number }
  /** Ephemeral typing hint relayed from a peer (Req 5.3); `fromUid` is the peer who is typing. */
  | { kind: 'typing'; fromUid: string };
