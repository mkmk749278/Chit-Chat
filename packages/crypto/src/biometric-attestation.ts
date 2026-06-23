/**
 * `@chat-app/crypto` — biometric presence attestation (Signature Feature 2b, §4.5).
 *
 * The in-chat TOTP verification ({@link ./identity-verification}) proves the responder holds the
 * conversation's shared seed; the safety number ({@link ./safety-number}) proves no key was
 * substituted. NEITHER answers the question "is the actual human (e.g. Kumar) the one on the
 * device right now, rather than someone who borrowed his unlocked phone?". Biometric presence
 * attestation closes that gap WITHOUT trusting the borrowed device's software: the proof is a
 * signature made by a key that the platform releases ONLY after a successful, live, strong
 * biometric (Face ID / fingerprint) — a credential the borrower's face/finger cannot satisfy.
 *
 * Trust model (why this defends the "borrowed unlocked phone" threat where TOTP does not):
 *   - At enrolment the attester (Kumar) generates a Curve25519 attestation key pair. The PRIVATE
 *     key is sealed in the platform keystore behind a biometric gate (Secure Enclave / StrongBox
 *     where available); the PUBLIC key is shared once, in-band, over the existing E2E channel.
 *   - To verify, the verifier sends a fresh random {@link generateBioVerifyChallenge | challenge}.
 *     The attester's device prompts a live biometric and, only on success, signs a canonical
 *     message binding the challenge, BOTH uids, and a timestamp. The borrower cannot produce that
 *     signature because the keystore will not release the key without the owner's biometric.
 *   - The verifier checks the signature against the enrolled public key, that the challenge is the
 *     one it just issued (anti-replay), and that the timestamp is fresh ({@link verifyBioAttestation}).
 *
 * The signed message binds the challenge AND both uids AND the timestamp, so an attestation
 * captured in one conversation cannot be replayed into another, against a different verifier, or
 * at a later time (Correctness: anti-replay, anti-relay, anti-stale).
 *
 * This module is platform-agnostic and pure: challenge generation uses the host CSPRNG and the
 * signature is verified with the project's existing Curve25519 verifier ({@link verifyCurveSignature}),
 * so it is wire-compatible across web and mobile (Requirement C2) and does no I/O. The private key
 * and the biometric prompt live entirely behind the injected {@link BiometricAttestor} port — no
 * key material is referenced here. The verifier's stored copy of a peer's PUBLIC attestation key is
 * held behind the injected {@link BiometricEnrollmentStore} port.
 */

import { verifyCurveSignature } from './libsignal-puretsignal';

/** Length in bytes of a verification challenge nonce (256-bit, CSPRNG). */
export const BIOVERIFY_CHALLENGE_BYTES = 32;

/**
 * Default freshness window for a biometric attestation, in milliseconds (2 minutes). A response
 * whose `issuedAt` is more than this far from the verifier's clock (in either direction, to
 * tolerate skew) is rejected as stale, so a captured signature cannot be replayed later (§4.5).
 */
export const BIOVERIFY_FRESHNESS_MS = 120_000;

/**
 * Domain-separation context string mixed into every signed attestation message, so an attestation
 * signature can never be confused with any other signature this app's keys ever produce (e.g. a
 * signed prekey). Versioned so a future message-format change cannot collide with this one.
 */
const ATTESTATION_CONTEXT = 'chit-chat/bioverify/attestation/v1';

/**
 * The fields bound into a biometric attestation signature. The verifier and attester independently
 * construct the identical message from these, so the signature commits to ALL of them.
 */
export interface BioAttestationContext {
  /** The verifier's fresh random challenge (base64), echoed by the attester (anti-replay). */
  challenge: string;
  /** The uid of the party REQUESTING the proof (the verifier) — binds the proof to this verifier. */
  verifierUid: string;
  /** The uid of the party PROVIDING the proof (the attester) — binds the proof to this identity. */
  attesterUid: string;
  /** The attester's clock at signing time, unix ms — bounds replay to the freshness window. */
  issuedAt: number;
}

/** An attester's signed response to a challenge, carried over the E2E channel. */
export interface BioAttestationResponse {
  /** The challenge the attester signed (must equal the one the verifier issued). */
  challenge: string;
  /** The attester's signing time, unix ms (bound into the signature). */
  issuedAt: number;
  /** base64 Curve25519/XEdDSA signature over {@link buildAttestationMessage} of the context. */
  signature: string;
}

/** Inputs to {@link verifyBioAttestation}: the pending challenge plus the attester's response + key. */
export interface VerifyBioAttestationParams {
  /** The challenge the verifier issued for THIS request (the only acceptable one). */
  expectedChallenge: string;
  /** The verifier's own uid (bound into the signed message). */
  verifierUid: string;
  /** The attester's uid (bound into the signed message). */
  attesterUid: string;
  /** The attester's signed response. */
  response: BioAttestationResponse;
  /** The attester's ENROLLED public attestation key (raw bytes), from the verifier's store. */
  attesterPublicKey: Uint8Array;
  /** The verifier's current clock, unix ms (for the freshness check). */
  now: number;
  /** Override the freshness window; defaults to {@link BIOVERIFY_FRESHNESS_MS}. */
  freshnessMs?: number;
}

/**
 * The outcome of verifying a biometric attestation. Distinguished so the UI/diagnostics can tell a
 * forged/borrowed-device failure (`bad-signature`) from a replay (`challenge-mismatch`) or a late
 * answer (`stale`), rather than collapsing every failure into one opaque "unverified".
 */
export type BioVerifyOutcome = 'verified' | 'challenge-mismatch' | 'stale' | 'bad-signature';

/**
 * The minimal CSPRNG surface this module needs (`crypto.getRandomValues`) — native in the browser
 * and Node ≥ 20, and provided on React Native by `src/polyfills.ts`.
 */
interface RandomSource {
  getRandomValues(array: Uint8Array): Uint8Array;
}

/** Resolve the host CSPRNG, with a clear error if it is unavailable. */
function getRandom(): RandomSource {
  const cryptoObj = (globalThis as { crypto?: Partial<RandomSource> }).crypto;
  if (cryptoObj?.getRandomValues === undefined) {
    throw new Error(
      'biometric-attestation: crypto.getRandomValues is unavailable; cannot generate a challenge.',
    );
  }
  return cryptoObj as RandomSource;
}

/**
 * Generate a fresh {@link BIOVERIFY_CHALLENGE_BYTES}-byte challenge nonce, base64-encoded. Called by
 * the verifier at the start of each verification; its single-use, random nature is what makes a
 * captured attestation signature non-replayable.
 */
export function generateBioVerifyChallenge(): string {
  const bytes = new Uint8Array(BIOVERIFY_CHALLENGE_BYTES);
  getRandom().getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64');
}

/** Encode a non-negative safe integer as 8 big-endian bytes (for the timestamp field). */
function uint64BE(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  let v = Math.max(0, Math.floor(value));
  for (let i = 7; i >= 0; i -= 1) {
    buf[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return buf;
}

/** Concatenate `len(4 BE) ‖ bytes` for one field, so field boundaries are unambiguous. */
function lengthPrefixed(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  const n = bytes.length;
  out[0] = (n >>> 24) & 0xff;
  out[1] = (n >>> 16) & 0xff;
  out[2] = (n >>> 8) & 0xff;
  out[3] = n & 0xff;
  out.set(bytes, 4);
  return out;
}

/** Concatenate byte arrays into one buffer. */
function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Build the canonical, unambiguous byte message that the attester signs and the verifier checks.
 *
 * Construction: the version context, then each field length-prefixed —
 *   `ctx ‖ LP(challengeBytes) ‖ LP(verifierUid) ‖ LP(attesterUid) ‖ issuedAt(8 BE)`.
 * Length-prefixing every variable field means no two distinct contexts can ever serialize to the
 * same bytes (e.g. swapping characters between the two uids), so the signature commits to exactly
 * this `{challenge, verifierUid, attesterUid, issuedAt}` tuple and nothing else.
 *
 * Both peers MUST produce byte-identical output for the same context (it is the signed message), so
 * this function is fully deterministic and platform-independent.
 */
export function buildAttestationMessage(ctx: BioAttestationContext): Uint8Array {
  const enc = new TextEncoder();
  // The challenge travels as base64; sign over its RAW bytes so the message is canonical regardless
  // of base64 padding/whitespace variation.
  const challengeBytes = new Uint8Array(Buffer.from(ctx.challenge, 'base64'));
  return concatBytes([
    enc.encode(ATTESTATION_CONTEXT),
    lengthPrefixed(challengeBytes),
    lengthPrefixed(enc.encode(ctx.verifierUid)),
    lengthPrefixed(enc.encode(ctx.attesterUid)),
    uint64BE(ctx.issuedAt),
  ]);
}

/**
 * Verify a biometric attestation response (§4.5). Total — never throws — so a malformed or hostile
 * response can only ever resolve to a failure outcome, never break the caller:
 *   - `challenge-mismatch` — the response did not echo the challenge we issued (replay/confusion);
 *   - `stale`             — the signing time is outside the freshness window (captured/late answer);
 *   - `bad-signature`     — the signature is not a valid signature by the enrolled key over the
 *                           reconstructed message (forgery, or a borrowed device that could not pass
 *                           the owner's biometric and therefore could not sign);
 *   - `verified`          — all checks pass: the live owner's biometric released the key just now.
 *
 * The challenge is checked FIRST (cheap, and the strongest anti-replay signal), then freshness, then
 * the cryptographic signature last.
 */
export async function verifyBioAttestation(
  params: VerifyBioAttestationParams,
): Promise<BioVerifyOutcome> {
  const { expectedChallenge, verifierUid, attesterUid, response, attesterPublicKey, now } = params;
  const freshnessMs = params.freshnessMs ?? BIOVERIFY_FRESHNESS_MS;

  // Anti-replay: the attester must echo the exact challenge we issued for this request.
  if (
    typeof response.challenge !== 'string' ||
    response.challenge.length === 0 ||
    response.challenge !== expectedChallenge
  ) {
    return 'challenge-mismatch';
  }

  // Freshness: reject a signature that was made too long ago (or implausibly in the future), so a
  // captured response cannot be replayed in a later session. Skew is tolerated symmetrically.
  if (!Number.isFinite(response.issuedAt) || Math.abs(now - response.issuedAt) > freshnessMs) {
    return 'stale';
  }

  // Reconstruct the exact signed message and verify the signature against the ENROLLED public key.
  // A borrowed device cannot have produced this signature (the keystore withholds the key without
  // the owner's live biometric), so an invalid signature is the decisive "not the real person" gate.
  let signatureBytes: Uint8Array;
  try {
    signatureBytes = new Uint8Array(Buffer.from(response.signature, 'base64'));
  } catch {
    return 'bad-signature';
  }
  if (signatureBytes.length === 0 || attesterPublicKey.length === 0) {
    return 'bad-signature';
  }
  const message = buildAttestationMessage({
    challenge: expectedChallenge,
    verifierUid,
    attesterUid,
    issuedAt: response.issuedAt,
  });
  const ok = await verifyCurveSignature(attesterPublicKey, message, signatureBytes);
  return ok ? 'verified' : 'bad-signature';
}

// ---------------------------------------------------------------------------
// Injected ports (the device-specific seams the orchestrator depends on).
// ---------------------------------------------------------------------------

/**
 * The device's biometric-gated signing oracle (Signature Feature 2b). Implemented by the platform
 * adapter over the OS keystore + biometric prompt (e.g. `expo-local-authentication` +
 * `expo-secure-store` with `requireAuthentication`). The private key never leaves this port; the
 * orchestrator only ever asks it to expose the PUBLIC key (for enrolment) or to authenticate and
 * sign (for a verification response).
 *
 * The security property the implementation MUST provide: {@link authenticateAndSign} returns a
 * signature ONLY after a successful, live, strong biometric, and the key it signs with is otherwise
 * inaccessible. That is the whole basis of the "borrowed unlocked phone" defence — so a passcode-only
 * fallback MUST be disabled (the borrower may know the passcode).
 */
export interface BiometricAttestor {
  /** Whether strong biometric hardware is present AND the owner has enrolled a biometric. */
  isAvailable(): Promise<boolean>;
  /**
   * The device's PUBLIC attestation key (raw bytes), generating + sealing the key pair on first
   * call. Returns `null` when biometrics are unavailable, so the caller can degrade gracefully. The
   * public key is not secret and is shared in-band during enrolment.
   */
  getPublicKey(): Promise<Uint8Array | null>;
  /**
   * Prompt a live, strong biometric and, ONLY on success, sign `message` with the sealed private
   * key. `promptReason` is shown in the OS prompt. Returns the raw signature bytes, or `null` if
   * biometrics are unavailable or the user cancelled / failed authentication (no signature is
   * produced and nothing is leaked).
   */
  authenticateAndSign(message: Uint8Array, promptReason: string): Promise<Uint8Array | null>;
}

/**
 * Durable, device-local store for the PUBLIC attestation keys of peers the user has enrolled with
 * (Signature Feature 2b). Keyed by peer uid. Implemented by the platform adapter over the encrypted
 * vault. Holds only public keys — no secret material — so a peer's enrolment survives relaunch and a
 * later verification can check their signature.
 */
export interface BiometricEnrollmentStore {
  /** Persist (or replace) a peer's public attestation key. */
  savePeerAttestationKey(peerUid: string, publicKey: Uint8Array): Promise<void>;
  /** Load a peer's stored public attestation key, or `null` if they have not enrolled here. */
  loadPeerAttestationKey(peerUid: string): Promise<Uint8Array | null>;
}
