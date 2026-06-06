/**
 * `@chat-app/crypto` — `EnvelopeCodec` (Phase 1, design Component 5: Messaging).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Components and Interfaces" → Client Component 5 (Messaging), and
 *   "Data Models" → "Ciphertext envelope (wire format)".
 *
 * The codec assembles and disassembles the on-the-wire `CiphertextEnvelope` from its
 * two halves: the `EnvelopeRouting` metadata (sender/recipient UID, sending deviceId,
 * per-conversation sequence number) and the libsignal `CiphertextBody` (the libsignal
 * message `type` and base64 ciphertext).
 *
 * Crucially, there is NO parameter, field, or code path here for plaintext. `encode`
 * accepts only routing metadata and an already-encrypted ciphertext body, and `decode`
 * yields only those same two halves. This is the single construction point for the
 * outbound frame, so the type system guarantees plaintext can never be serialized to
 * the socket (Requirements 5.3, 5.7, 8.2).
 */

import type { CiphertextBody, CiphertextEnvelope, EnvelopeRouting } from '@chat-app/types';

/**
 * Builds and parses the `CiphertextEnvelope` wire frame from its routing metadata and
 * libsignal ciphertext body. There is no parameter or field for plaintext anywhere on
 * this interface (Requirements 5.3, 5.7, 8.2).
 */
export interface EnvelopeCodec {
  /**
   * Merge routing metadata and a libsignal ciphertext body into a wire envelope.
   * There is no parameter for plaintext — the body is already libsignal ciphertext.
   */
  encode(meta: EnvelopeRouting, body: CiphertextBody): CiphertextEnvelope;
  /** Split a wire envelope back into its routing metadata and ciphertext body. */
  decode(envelope: CiphertextEnvelope): { routing: EnvelopeRouting; body: CiphertextBody };
}

/**
 * The default, stateless `EnvelopeCodec`. Encoding and decoding copy only the known,
 * explicitly-named routing and body fields, so no foreign field (in particular,
 * nothing resembling plaintext) can ride along through the codec.
 */
class DefaultEnvelopeCodec implements EnvelopeCodec {
  encode(meta: EnvelopeRouting, body: CiphertextBody): CiphertextEnvelope {
    // Construct the envelope by explicitly naming every routing and body field.
    // There is deliberately no plaintext parameter or field to copy.
    return {
      senderUid: meta.senderUid,
      recipientUid: meta.recipientUid,
      senderDeviceId: meta.senderDeviceId,
      seq: meta.seq,
      type: body.type,
      ciphertext: body.ciphertext,
    };
  }

  decode(envelope: CiphertextEnvelope): { routing: EnvelopeRouting; body: CiphertextBody } {
    // Split back into the two halves, again by explicitly naming each field so the
    // result carries only routing metadata and the libsignal ciphertext body.
    return {
      routing: {
        senderUid: envelope.senderUid,
        recipientUid: envelope.recipientUid,
        senderDeviceId: envelope.senderDeviceId,
        seq: envelope.seq,
      },
      body: {
        type: envelope.type,
        ciphertext: envelope.ciphertext,
      },
    };
  }
}

/**
 * Create an `EnvelopeCodec`. The codec is stateless, so a single shared instance is
 * safe to reuse; the factory exists to match the ports-and-adapters style of the
 * shared core and to keep the concrete class private.
 */
export function createEnvelopeCodec(): EnvelopeCodec {
  return new DefaultEnvelopeCodec();
}
