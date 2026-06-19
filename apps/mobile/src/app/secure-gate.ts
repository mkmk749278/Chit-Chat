/**
 * `apps/mobile` — secure-gate: app-PIN lock (decoy/duress) + hidden-chat unlock, over the
 * encrypted vault.
 *
 * Signature Features 1 & 4 (`private-chat-app-requirements.md` §3, §6). This binds the pure crypto
 * cores (`secret-hash`, `lockout-policy`, `app-lock` from `@chat-app/crypto`) to the on-device
 * encrypted {@link PersistentVault}:
 *   - app PINs: a real PIN opens the full app, an optional decoy PIN opens a sanitised state (§6);
 *   - hidden chats: each hidden chat has its own salted unlock secret; typing it reveals just that
 *     chat (§3). Secrets are stored ONLY as salted PBKDF2 verifiers, never plaintext (§3.1 / D8).
 *   - rate-limiting: a shared failed-attempt log drives the 5-fail/10-min → 30-min lockout (§3.1).
 *
 * All secret material lives in the AES-encrypted vault document, so even the existence of a hidden
 * chat is not exposed in plaintext storage. The gate never returns which verifier matched beyond the
 * outcome, and gives timing-only feedback (no attempt counter), per §3.1.
 */

import {
  DEFAULT_LOCKOUT_POLICY,
  evaluateLockout,
  hashSecret,
  pruneFailures,
  resolveAppMode,
  verifySecret,
  type AppMode,
} from '@chat-app/crypto';

import type { PersistentVault } from '../crypto/persistent-store';

/** Result of an unlock attempt. */
export type UnlockResult =
  | { mode: AppMode }
  | { locked: true; msUntilUnlock: number }
  | { invalid: true };

/** Result of a hidden-chat reveal attempt. */
export type RevealResult =
  | { peerUid: string }
  | { locked: true; msUntilUnlock: number }
  | { invalid: true };

/** The secure-gate surface the controller delegates to. */
export interface SecureGate {
  /** Whether a real app PIN has been configured (so the app should lock on launch). */
  hasRealPin(): Promise<boolean>;
  /** Set or replace the real or decoy app PIN (stored as a salted verifier). */
  setPin(pin: string, kind: AppMode): Promise<void>;
  /** Attempt to unlock the app with `pin`, honouring the lockout policy. */
  unlock(pin: string): Promise<UnlockResult>;
  /** Mark a chat hidden with its own unlock secret (§3.1). */
  hideChat(peerUid: string, secret: string): Promise<void>;
  /** Remove a chat's hidden status (revealed from within the chat, §3.3). */
  unhideChat(peerUid: string): Promise<void>;
  /** The peer uids of currently-hidden chats (so the list can exclude them). */
  listHiddenPeers(): Promise<string[]>;
  /** Reveal exactly the hidden chat whose secret matches `secret`, honouring the lockout (§3.1). */
  revealHiddenChat(secret: string): Promise<RevealResult>;
}

/**
 * Build a {@link SecureGate} over `vault`. `now` is injected for deterministic testing of the
 * lockout timing.
 */
export function createSecureGate(vault: PersistentVault, now: () => number = () => Date.now()): SecureGate {
  /** Read the current failed-attempt log. */
  const readFailures = (): Promise<number[]> => vault.read((doc) => doc.unlockFailures ?? []);

  /** Append a failed attempt and prune the log so it can't grow without bound. */
  const recordFailure = async (): Promise<{ msUntilUnlock: number }> => {
    const at = now();
    return vault.mutate((doc) => {
      const failures = pruneFailures([...(doc.unlockFailures ?? []), at], at);
      doc.unlockFailures = failures;
      const state = evaluateLockout(failures, at);
      return { msUntilUnlock: state.msUntilUnlock };
    });
  };

  /** Clear the failed-attempt log after a successful unlock/reveal. */
  const clearFailures = async (): Promise<void> => {
    await vault.mutate((doc) => {
      doc.unlockFailures = [];
    });
  };

  /** Current lockout state from the persisted failures. */
  const currentLockout = async (): Promise<{ locked: boolean; msUntilUnlock: number }> => {
    const at = now();
    const state = evaluateLockout(await readFailures(), at);
    return { locked: state.locked, msUntilUnlock: state.msUntilUnlock };
  };

  return {
    async hasRealPin(): Promise<boolean> {
      return vault.read((doc) => typeof doc.appPins?.real === 'string' && doc.appPins.real.length > 0);
    },

    async setPin(pin: string, kind: AppMode): Promise<void> {
      const verifier = await hashSecret(pin);
      await vault.mutate((doc) => {
        const pins = doc.appPins ?? {};
        pins[kind] = verifier;
        doc.appPins = pins;
      });
    },

    async unlock(pin: string): Promise<UnlockResult> {
      const lock = await currentLockout();
      if (lock.locked) {
        return { locked: true, msUntilUnlock: lock.msUntilUnlock };
      }
      const verifiers = await vault.read((doc) => ({
        real: doc.appPins?.real ?? null,
        decoy: doc.appPins?.decoy ?? null,
      }));
      const mode = await resolveAppMode(pin, verifiers);
      if (mode === null) {
        const { msUntilUnlock } = await recordFailure();
        // Surface a lockout only once it actually trips; otherwise a plain invalid result (§6.2).
        return msUntilUnlock > 0 ? { locked: true, msUntilUnlock } : { invalid: true };
      }
      await clearFailures();
      return { mode };
    },

    async hideChat(peerUid: string, secret: string): Promise<void> {
      const verifier = await hashSecret(secret);
      await vault.mutate((doc) => {
        const hidden = doc.hiddenChats ?? {};
        hidden[peerUid] = verifier;
        doc.hiddenChats = hidden;
      });
    },

    async unhideChat(peerUid: string): Promise<void> {
      await vault.mutate((doc) => {
        if (doc.hiddenChats !== undefined) {
          delete doc.hiddenChats[peerUid];
        }
      });
    },

    async listHiddenPeers(): Promise<string[]> {
      return vault.read((doc) => Object.keys(doc.hiddenChats ?? {}));
    },

    async revealHiddenChat(secret: string): Promise<RevealResult> {
      const lock = await currentLockout();
      if (lock.locked) {
        return { locked: true, msUntilUnlock: lock.msUntilUnlock };
      }
      const entries = await vault.read((doc) => Object.entries(doc.hiddenChats ?? {}));
      // Check every hidden chat so the work (and timing) doesn't depend on which one matched (§3.1).
      let match: string | null = null;
      for (const [peerUid, verifier] of entries) {
        // eslint-disable-next-line no-await-in-loop -- small set; constant-ish work over all candidates
        if (await verifySecret(secret, verifier)) {
          match = peerUid;
        }
      }
      if (match === null) {
        const { msUntilUnlock } = await recordFailure();
        return msUntilUnlock > 0 ? { locked: true, msUntilUnlock } : { invalid: true };
      }
      await clearFailures();
      return { peerUid: match };
    },
  };
}
