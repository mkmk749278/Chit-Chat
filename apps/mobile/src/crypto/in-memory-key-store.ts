/**
 * `apps/mobile` — in-memory {@link KeyStore} (Phase 1 first functional wiring).
 *
 * Backs the shared {@link KeyStore} port entirely in process memory: identity material,
 * the server-issued deviceId, per-conversation sequence counters, message rows, and
 * libsignal session records. This is the simplest correct backing that lets the mobile
 * client run the REAL identity / registration / messaging stack end-to-end on a device
 * WITHOUT a native storage module (no SQLCipher build/sign risk for the first device test).
 *
 * Tradeoff (documented, intentional for v1): nothing survives an app restart. On the next
 * launch the device regenerates its identity and re-registers (a new deviceId). For a
 * persistent, encrypted-at-rest store the same port is later backed by SQLCipher
 * (`op-sqlite` / `expo-sqlite` with an encryption key) — no shared-core change needed.
 *
 * Private key material is held only here, never logged, and dropped on {@link destroy}
 * (Requirements 7.1, 7.2, 8.1).
 */

import type {
  IdentityRecord,
  KeyStore,
  MessageRow,
  SignalAddress,
} from '@chat-app/crypto';
import type { MessageStatus } from '@chat-app/types';

/** Stable map key for a remote address (Phase 1 is single-device per user). */
const addressKey = (address: SignalAddress): string => `${address.uid}:${address.deviceId}`;

/**
 * Build an in-memory {@link KeyStore}. Each call returns an independent store; the mobile
 * controller creates one per signed-in session and {@link KeyStore.destroy}s it on sign-out.
 */
export function createInMemoryKeyStore(): KeyStore {
  let identity: IdentityRecord | null = null;
  let deviceId: string | null = null;
  const sessions = new Map<string, Uint8Array>();
  const sequences = new Map<string, number>();
  const messages = new Map<string, MessageRow>();

  return {
    async saveIdentity(record: IdentityRecord): Promise<void> {
      identity = record;
    },
    async loadIdentity(uid: string): Promise<IdentityRecord | null> {
      return identity !== null && identity.uid === uid ? identity : null;
    },
    async saveDeviceId(id: string): Promise<void> {
      deviceId = id;
    },
    async loadDeviceId(): Promise<string | null> {
      return deviceId;
    },

    async loadSession(address: SignalAddress): Promise<Uint8Array | null> {
      return sessions.get(addressKey(address)) ?? null;
    },
    async saveSession(address: SignalAddress, record: Uint8Array): Promise<void> {
      sessions.set(addressKey(address), record);
    },
    async consumeOneTimePreKey(keyId: number): Promise<void> {
      // Drop the consumed one-time prekey from the held identity so it is never reused.
      if (identity !== null) {
        identity = {
          ...identity,
          oneTimePreKeys: identity.oneTimePreKeys.filter((k) => k.keyId !== keyId),
        };
      }
    },

    async nextSeq(recipientUid: string): Promise<number> {
      const next = (sequences.get(recipientUid) ?? 0) + 1;
      sequences.set(recipientUid, next);
      return next;
    },

    async appendMessage(row: MessageRow): Promise<void> {
      messages.set(row.id, { ...row });
    },
    async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
      const row = messages.get(id);
      if (row !== undefined) {
        row.status = status;
      }
    },

    destroy(): void {
      identity = null;
      deviceId = null;
      sessions.clear();
      sequences.clear();
      messages.clear();
    },
  };
}
