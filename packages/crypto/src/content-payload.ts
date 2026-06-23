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
  /**
   * Biometric presence attestation control payloads (Signature Feature 2b, §4.5). They ride inside
   * the existing E2E ciphertext exactly like the verify-* controls, so the server never learns a
   * presence check is happening. See {@link ./biometric-attestation}.
   */
  /** Attester → peer: enrol by sharing the device's PUBLIC attestation key (base64), once (§4.5). */
  | { type: 'bioverify-enroll'; attestKey: string }
  /** Verifier → attester: request a live biometric proof, carrying the fresh base64 challenge (§4.5). */
  | { type: 'bioverify-request'; challenge: string }
  /**
   * Attester → verifier: the response to a challenge. When the attester's biometric succeeded it
   * carries the echoed `challenge`, the signing time `issuedAt`, and the base64 `signature`. When
   * biometrics are unavailable or the user cancelled, `available` is `false` and no signature is
   * sent — so the verifier can distinguish "could not attest" from "attested but failed" (§4.5).
   */
  | {
      type: 'bioverify-response';
      challenge: string;
      issuedAt: number;
      signature: string;
      available: boolean;
    }
  /**
   * Shadow Chat invite control payloads (Shadow Chat Invites, design "Component B"; Req 9, 12).
   * They ride inside the existing E2E ciphertext exactly like the verify-* / duress-alert controls, so
   * the (frozen, server-blind) backend never learns an invite is happening. They are intercepted by
   * Messaging BEFORE conversation routing — none of them ever becomes a conversation row — and an
   * older peer that predates this feature decodes any of them to `{ type: 'unsupported' }` and
   * harmlessly ignores it (totality of {@link decodeContentPayload}).
   */
  /**
   * Inviter → recipient: open a two-party shadow thread. Carries the SHARED 32-byte thread key as a
   * base64 string (Req 9.1; key strategy B). `inviteId` correlates Accept/Decline back to this
   * invite; the optional `label` is a human-readable thread name shown on the request card.
   */
  | { type: 'shadow-invite'; inviteId: string; key: string; label?: string }
  /** Recipient → inviter: the invite was accepted (the recipient's display routing stays LOCAL). */
  | { type: 'shadow-accept'; inviteId: string }
  /** Recipient → inviter: the invite was declined; no shadow state is created on either side. */
  | { type: 'shadow-decline'; inviteId: string }
  /**
   * EITHER peer → the other: revoke (tear down) an established shadow thread. Instructs the
   * recipient's device to delete the shared thread key + that thread's local history and close the
   * thread. Carries the `inviteId`/`threadId` reference so the peer can locate the exact thread; it
   * carries NO key and NO content. Same E2E / server-blind pattern as the other shadow-* controls.
   */
  | { type: 'shadow-revoke'; inviteId: string; threadId: string }
  /** A `{v:1}` payload whose `type` (or shape) this client version does not understand. */
  | { type: 'unsupported' };

/**
 * The result of decoding a content payload. Separates the discriminated message `payload`
 * (text/reaction/edit/delete/timer/attachment/…) from the optional shadow-routing `threadId`
 * (Shadow Chat, design Component 2). `threadId` present ⇒ the message belongs to a shadow thread;
 * `threadId` absent ⇒ a surface chat. The `payload` field is byte-for-byte the value the
 * pre-shadow {@link decodeContentPayload} returned for the same input, so all existing per-`type`
 * routing keeps working unchanged.
 */
export interface DecodedContentPayload {
  /** The existing discriminated content payload (text/reaction/edit/delete/timer/attachment/…). */
  payload: ContentPayload;
  /**
   * Present ⇒ this message belongs to a shadow thread; absent ⇒ a surface chat. Carried INSIDE
   * the encrypted body only, so the server never sees it (Shadow Chat, Req 3.1). Surfaced only
   * when the encoded envelope held a non-empty string of 1..255 characters; otherwise absent.
   */
  threadId?: string;
}

/** Lower/upper bounds for a routable shadow threadId carried on the content envelope (Req 6.1/6.4). */
const THREAD_ID_MAX_LENGTH = 255;

/** Whether `value` is a routable shadow threadId: a non-empty string of 1..255 characters. */
function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= THREAD_ID_MAX_LENGTH;
}

/**
 * Serialize a content payload to the string that will be encrypted as the libsignal plaintext.
 * Always emits the versioned envelope, so once both peers run Phase 2 every message — including
 * plain text — is wrapped (and a user who literally types JSON is safely inside `body`).
 *
 * When `threadId` is omitted (or is not a routable 1..255-char string) the output is BYTE-FOR-BYTE
 * identical to the pre-shadow encoder, so surface messages are completely unchanged on the wire
 * (Shadow Chat, Req 5.1, Property 6). When a valid `threadId` is supplied it is appended to the
 * envelope so it rides INSIDE the ciphertext, leaving `v` and every existing field intact
 * (Req 6.1).
 *
 * @param payload  - the discriminated content payload to serialize.
 * @param threadId - optional shadow thread id; included only when a non-empty 1..255-char string.
 */
export function encodeContentPayload(payload: ContentPayload, threadId?: string): string {
  // A `shadow-revoke` carries its thread reference under a DEDICATED `revokeThreadId` key so it never
  // collides with the envelope's reserved routing `threadId` (see decode + design Component B). All
  // other payloads serialize their fields verbatim.
  const body: Record<string, unknown> =
    payload.type === 'shadow-revoke'
      ? { type: 'shadow-revoke', inviteId: payload.inviteId, revokeThreadId: payload.threadId }
      : { ...payload };
  return isThreadId(threadId)
    ? JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, ...body, threadId })
    : JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, ...body });
}

/** Type guard: a finite, safe-integer sequence number. */
function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The exact byte length of a shadow thread key (a 256-bit / 32-byte CSPRNG secret, Req 9.1). */
const SHADOW_THREAD_KEY_BYTES = 32;

/**
 * Canonical base64 (RFC 4648, optionally padded). Matched strictly so a malformed `shadow-invite`
 * key cannot slip through `Buffer.from(.., 'base64')`'s lenient decoding (which silently drops
 * non-alphabet characters). Capturing the optional `=` padding lets {@link strictBase64ByteLength}
 * reject inputs whose length is not a valid base64 quantum.
 */
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Decode the byte length of a strictly-canonical base64 string, total (never throws): returns the
 * number of bytes `value` decodes to, or `null` if `value` is not a `string` or not canonical
 * base64. Used to enforce the exact 32-byte shadow-key invariant without trusting the platform
 * base64 decoder, so an arbitrary attacker-supplied `key` can only ever validate or be rejected.
 */
function strictBase64ByteLength(value: unknown): number | null {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !CANONICAL_BASE64.test(value)) {
    return null;
  }
  if (value.length === 0) {
    return 0;
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** Whether `value` is a non-empty string (the shape of every shadow control's `inviteId`). */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Parse a decrypted plaintext into a {@link DecodedContentPayload}. Total (never throws):
 *   - a recognized `{v:1,type,…}` envelope with valid fields → that typed payload;
 *   - a `{v:1}` envelope with an unknown type or invalid fields → `{ type: 'unsupported' }`;
 *   - anything else (bare string, non-JSON, legacy Phase 1 text) → `{ type: 'text', body: raw }`.
 *
 * The returned `payload` is byte-for-byte the value the pre-shadow decoder produced for the same
 * input — all existing per-`type` validation is preserved verbatim (Req 5.3, 6.5). The optional
 * shadow `threadId` is read ONCE at the envelope level and surfaced only when it is a non-empty
 * string of 1..255 characters; a missing, empty, non-string, or over-255 `threadId` routes to the
 * surface chat (`threadId` absent, Req 6.3/6.4). Decoding never throws (Req 6.6/6.7).
 */
export function decodeContentPayload(raw: string): DecodedContentPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not JSON at all — a legacy Phase 1 plain-text message.
    return { payload: { type: 'text', body: raw } };
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    (parsed as { v?: unknown }).v !== CONTENT_PAYLOAD_VERSION
  ) {
    // Valid JSON but not our envelope (e.g. a user typed a JSON-looking message on old code).
    return { payload: { type: 'text', body: raw } };
  }

  const env = parsed as Record<string, unknown>;
  const payload = decodeEnvelopePayload(env);
  // Surface the optional shadow threadId only when it is a routable 1..255-char string; otherwise
  // absent ⇒ surface chat. Read once at the envelope level, independently of per-type validation.
  return isThreadId(env.threadId) ? { payload, threadId: env.threadId } : { payload };
}

/**
 * Decode the discriminated content payload from a validated `{v:1,…}` envelope. Holds the existing
 * per-`type` validation verbatim, so the result is identical to the pre-shadow decoder and is
 * unaffected by the presence or absence of the envelope's optional `threadId` (Req 6.5).
 */
function decodeEnvelopePayload(env: Record<string, unknown>): ContentPayload {
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
    case 'bioverify-enroll':
      // The PUBLIC attestation key, base64; a non-string / empty key ⇒ unsupported (no enrolment).
      return typeof env.attestKey === 'string' && env.attestKey.length > 0
        ? { type: 'bioverify-enroll', attestKey: env.attestKey }
        : { type: 'unsupported' };
    case 'bioverify-request':
      return typeof env.challenge === 'string' && env.challenge.length > 0
        ? { type: 'bioverify-request', challenge: env.challenge }
        : { type: 'unsupported' };
    case 'bioverify-response':
      // A well-formed response always carries challenge/issuedAt/available; `signature` is required
      // as a string but may be empty when `available === false` (no proof was produced). Validating
      // the shape totally here means a malformed response decodes to `unsupported` and is ignored.
      return typeof env.challenge === 'string' &&
        env.challenge.length > 0 &&
        typeof env.issuedAt === 'number' &&
        Number.isFinite(env.issuedAt) &&
        env.issuedAt >= 0 &&
        typeof env.signature === 'string' &&
        typeof env.available === 'boolean'
        ? {
            type: 'bioverify-response',
            challenge: env.challenge,
            issuedAt: env.issuedAt,
            signature: env.signature,
            available: env.available,
          }
        : { type: 'unsupported' };
    case 'shadow-invite':
      // `key` must be canonical base64 decoding to EXACTLY 32 bytes (the shared thread key, Req 9.1);
      // `label` is optional. A non-32-byte / non-base64 key ⇒ unsupported (ignored, no thread).
      return isNonEmptyString(env.inviteId) &&
        strictBase64ByteLength(env.key) === SHADOW_THREAD_KEY_BYTES &&
        (env.label === undefined || typeof env.label === 'string')
        ? {
            type: 'shadow-invite',
            inviteId: env.inviteId,
            key: env.key as string,
            ...(typeof env.label === 'string' ? { label: env.label } : {}),
          }
        : { type: 'unsupported' };
    case 'shadow-accept':
      return isNonEmptyString(env.inviteId)
        ? { type: 'shadow-accept', inviteId: env.inviteId }
        : { type: 'unsupported' };
    case 'shadow-decline':
      return isNonEmptyString(env.inviteId)
        ? { type: 'shadow-decline', inviteId: env.inviteId }
        : { type: 'unsupported' };
    case 'shadow-revoke':
      // The thread-to-tear-down reference is carried under a DEDICATED `revokeThreadId` key, NOT the
      // envelope's reserved routing `threadId` (which the codec surfaces as DecodedContentPayload
      // .threadId for conversation routing). Keeping them distinct means a `shadow-revoke` is never
      // mis-read as a routable shadow message — it stays a control payload intercepted before routing
      // (design Component B/E) — while still validating the reference to the same 1..255-char bound.
      return isNonEmptyString(env.inviteId) && isThreadId(env.revokeThreadId)
        ? { type: 'shadow-revoke', inviteId: env.inviteId, threadId: env.revokeThreadId }
        : { type: 'unsupported' };
    default:
      // A type a newer client introduced; ignore rather than misrender (forward-compat).
      return { type: 'unsupported' };
  }
}
