/**
 * `@chat-app/crypto` — app-lock PIN resolution (real vs decoy / duress state).
 *
 * Signature Feature 4 — Decoy PIN / Duress App State (`private-chat-app-requirements.md` §6). The
 * app can hold two PINs: the **real PIN** opens the normal app (all chats), and an optional
 * **decoy PIN** opens a sanitised fake state (no hidden chats, no shadow chats, a plausible subset).
 * The two states are visually indistinguishable and there is no indicator of which is active (§6.1).
 *
 * This module is the pure resolution step: given an entered PIN and the stored salted verifiers, it
 * returns which mode to open — `real`, `decoy`, or `null` (neither matched). It deliberately does
 * NOT reveal which verifier matched beyond the mode, and checks the real PIN first so the resolution
 * is deterministic. Lockout/rate-limiting (§6.2) is layered by the caller via `lockout-policy`, and
 * the actual fake-state construction lives in the app; here we only classify the PIN.
 *
 * Verifiers are PBKDF2 salted hashes from `secret-hash` (never plaintext PINs, §6.2 / D8).
 */

import { verifySecret } from './secret-hash';

/** Which app state a PIN opens. */
export type AppMode = 'real' | 'decoy';

/** Stored salted PIN verifiers (from {@link hashSecret}); `null`/absent when not configured. */
export interface PinVerifiers {
  /** The real PIN verifier (opens the full app). */
  real: string | null;
  /** The optional decoy PIN verifier (opens the sanitised fake state, §6.1). */
  decoy?: string | null;
}

/**
 * Resolve an entered `pin` to an {@link AppMode}, or `null` when it matches neither verifier.
 *
 * The real PIN is checked first, so if (by misconfiguration) the same PIN were set for both, it
 * opens the real app. A `null` result is indistinguishable between "no PIN configured" and "wrong
 * PIN" — the caller shows the same generic failure either way (§6.2 "no flow reveals which is real").
 */
export async function resolveAppMode(pin: string, verifiers: PinVerifiers): Promise<AppMode | null> {
  if (pin.length === 0) {
    return null;
  }
  if (verifiers.real !== null && verifiers.real !== undefined && (await verifySecret(pin, verifiers.real))) {
    return 'real';
  }
  if (
    verifiers.decoy !== null &&
    verifiers.decoy !== undefined &&
    (await verifySecret(pin, verifiers.decoy))
  ) {
    return 'decoy';
  }
  return null;
}
