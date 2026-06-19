/**
 * `@chat-app/crypto` — versioned E2E content payload (Phase 2, design "E2E content payload";
 * Requirement 3, and the carrier for Req 4 timers / Req 7 attachments later).
 *
 * Phase 1 encrypted a bare UTF-8 string as the libsignal plaintext. To carry richer message
 * kinds (reactions, edits, deletes, disappearing-message timers, …) WITHOUT changing the wire
 * envelope or letting the server see anything new, the plaintext that gets encrypted is now a
 * small versioned JSON document — the "content payload". The server still relays an opaque
 * `CiphertextEnvelope`; the payload only ever exists decrypted, on-device (Requirement C1).
 *
 * Target references (reaction/edit/delete) use the SENDER's frame of reference: `targetSeq`
 * plus `targetOutbound` = "the referenced message is one the payload SENDER sent". The
 * receiver flips `targetOutbound` to its own local direction when applying the change (that
 * flip lives in the Messaging integration, which knows sender vs. receiver). Edits and deletes
 * always reference the sender's own message, so `targetOutbound` is `true` for them.
 *
 * Backward compatibility: a peer still running Phase 1 sends a bare string. {@link
 * decodeContentPayload} therefore treats anything that is NOT a recognized `{v:1,…}` envelope
 * as `{ type: 'text', body: <raw> }`, so no message is ever lost or misrendered during the
 * rollout. A future/unknown payload type decodes to `{ type: 'unsupported' }` so an older
 * client ignores it instead of rendering garbage. Decoding is TOTAL — it never throws — so a
 * malformed inbound payload can never break `onEnvelope`.
 */

/** The current content-payload schema version. */
export const CONTENT_PAYLOAD_VERSION = 1;

/** A decoded content payload. Discriminated on `type`. */
export type ContentPayload =
  /** A text message. `viewOnce` marks it for delete-on-display on the recipient (Req 4.3). */
  | { type: 'text'; body: string; viewOnce?: boolean }
  | { type: 'reaction'; targetSeq: number; targetOutbound: boolean; emoji: string }
  | { type: 'edit'; targetSeq: number; targetOutbound: boolean; body: string }
  | { type: 'delete'; targetSeq: number; targetOutbound: boolean }
  /** Set the conversation's disappearing-message timer; `ttlMs === 0` disables it (Req 4.1). */
  | { type: 'timer'; ttlMs: number }
  /**
   * An end-to-end encrypted attachment (Req 7). Carries the routing/handle metadata plus the
   * per-attachment AES-GCM key + iv (base64) needed to fetch from the blob store and decrypt
   * locally — the key travels ONLY here, inside the ciphertext, never to the blob store (7.2).
   */
  | {
      type: 'attachment';
      /** Opaque blob-store handle for the ciphertext (Req 7.1). */
      blobId: string;
      /** base64 AES-256 content key (Req 7.2). */
      key: string;
      /** base64 AES-GCM nonce. */
      iv: string;
      /** MIME type of the decrypted content (e.g. `image/jpeg`). */
      mediaType: string;
      /** Ciphertext byte length, for progress/bounds. */
      size: number;
      /** Optional original file name. */
      name?: string;
    }
  /**
   * In-chat identity-verification control payloads (Signature Feature 2, §4). They ride inside
   * the existing E2E ciphertext so the server never learns a verification is happening.
   */
  /** Requester → responder: begin a verification, carrying the fresh base64 session seed (§4.2). */
  | { type: 'verify-request'; seed: string }
  /** Responder → requester: the rotating code the responder submitted (the requester classifies it). */
  | { type: 'verify-response'; code: string }
  /** Requester → responder: the verification outcome, so both sides converge on the badge (§4.3). */
  | { type: 'verify-result'; ok: boolean }
  /**
   * Responder → a pre-configured trusted contact: a silent duress alert fired when the duress code
   * was used (§4.2, §4.3). Carries only the uid of the peer who ran the verification; no content.
   */
  | { type: 'duress-alert'; peerUid: string }
  /** A `{v:1}` payload whose `type` (or shape) this client version does not understand. */
  | { type: 'unsupported' };

/**
 * Serialize a content payload to the string that will be encrypted as the libsignal plaintext.
 * Always emits the versioned envelope, so once both peers run Phase 2 every message — including
 * plain text — is wrapped (and a user who literally types JSON is safely inside `body`).
 */
export function encodeContentPayload(payload: ContentPayload): string {
  return JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, ...payload });
}

/** Type guard: a finite, safe-integer sequence number. */
function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Parse a decrypted plaintext into a {@link ContentPayload}. Total (never throws):
 *   - a recognized `{v:1,type,…}` envelope with valid fields → that typed payload;
 *   - a `{v:1}` envelope with an unknown type or invalid fields → `{ type: 'unsupported' }`;
 *   - anything else (bare string, non-JSON, legacy Phase 1 text) → `{ type: 'text', body: raw }`.
 */
export function decodeContentPayload(raw: string): ContentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all — a legacy Phase 1 plain-text message.
    return { type: 'text', body: raw };
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== CONTENT_PAYLOAD_VERSION
  ) {
    // Valid JSON but not our envelope (e.g. a user typed a JSON-looking message on old code).
    return { type: 'text', body: raw };
  }

  const env = parsed as Record<string, unknown>;
  switch (env.type) {
    case 'text':
      return typeof env.body === 'string'
        ? env.viewOnce === true
          ? { type: 'text', body: env.body, viewOnce: true }
          : { type: 'text', body: env.body }
        : { type: 'unsupported' };
    case 'reaction':
      return isSeq(env.targetSeq) &&
        typeof env.targetOutbound === 'boolean' &&
        typeof env.emoji === 'string' &&
        env.emoji.length > 0
        ? { type: 'reaction', targetSeq: env.targetSeq, targetOutbound: env.targetOutbound, emoji: env.emoji }
        : { type: 'unsupported' };
    case 'edit':
      return isSeq(env.targetSeq) &&
        typeof env.targetOutbound === 'boolean' &&
        typeof env.body === 'string'
        ? { type: 'edit', targetSeq: env.targetSeq, targetOutbound: env.targetOutbound, body: env.body }
        : { type: 'unsupported' };
    case 'delete':
      return isSeq(env.targetSeq) && typeof env.targetOutbound === 'boolean'
        ? { type: 'delete', targetSeq: env.targetSeq, targetOutbound: env.targetOutbound }
        : { type: 'unsupported' };
    case 'timer':
      return typeof env.ttlMs === 'number' && Number.isFinite(env.ttlMs) && env.ttlMs >= 0
        ? { type: 'timer', ttlMs: env.ttlMs }
        : { type: 'unsupported' };
    case 'attachment':
      return typeof env.blobId === 'string' &&
        env.blobId.length > 0 &&
        typeof env.key === 'string' &&
        env.key.length > 0 &&
        typeof env.iv === 'string' &&
        env.iv.length > 0 &&
        typeof env.mediaType === 'string' &&
        env.mediaType.length > 0 &&
        typeof env.size === 'number' &&
        Number.isFinite(env.size) &&
        env.size >= 0 &&
        (env.name === undefined || typeof env.name === 'string')
        ? {
            type: 'attachment',
            blobId: env.blobId,
            key: env.key,
            iv: env.iv,
            mediaType: env.mediaType,
            size: env.size,
            ...(typeof env.name === 'string' ? { name: env.name } : {}),
          }
        : { type: 'unsupported' };
    case 'verify-request':
      return typeof env.seed === 'string' && env.seed.length > 0
        ? { type: 'verify-request', seed: env.seed }
        : { type: 'unsupported' };
    case 'verify-response':
      return typeof env.code === 'string' && env.code.length > 0
        ? { type: 'verify-response', code: env.code }
        : { type: 'unsupported' };
    case 'verify-result':
      return typeof env.ok === 'boolean'
        ? { type: 'verify-result', ok: env.ok }
        : { type: 'unsupported' };
    case 'duress-alert':
      return typeof env.peerUid === 'string' && env.peerUid.length > 0
        ? { type: 'duress-alert', peerUid: env.peerUid }
        : { type: 'unsupported' };
    default:
      // A type a newer client introduced; ignore rather than misrender (forward-compat).
      return { type: 'unsupported' };
  }
}
