/**
 * Web `KeyStore` adapter — in-memory only (Phase 1, design Client Component 6).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 6: Key_Store (platform adapter)", and
 *   `.kiro/specs/phase1-client-messaging/requirements.md` → Requirement 7.
 *
 * The Web_App holds identity material and session state in JavaScript memory ONLY.
 * This adapter backs the shared `KeyStore` port (from `@chat-app/crypto`) purely with
 * JS `Map`s and a couple of scalar fields. It NEVER touches `localStorage`,
 * `sessionStorage`, IndexedDB, Cache Storage, Web SQL, or cookies — there is no call
 * to any persistent web-storage API anywhere in this module (Requirement 7.2, 8.1).
 *
 * `destroy()` synchronously wipes every byte of in-memory identity/session/message
 * material so that, within the same event-handling cycle (page unload, tab close, or
 * sign-out), nothing remains retrievable from JS memory (Requirement 7.4). Use
 * {@link registerSessionEndWipe} to wire `destroy()` to the browser unload events.
 *
 * There is deliberately NO key-backup, key-recovery, or export method on this class —
 * forward secrecy by construction, per product decision D9 (Requirement 7.5).
 */

import type {
  IdentityRecord,
  KeyStore,
  MessageRow,
  SignalAddress,
} from '@chat-app/crypto';
import type { MessageStatus } from '@chat-app/types';

/**
 * Joins a {@link SignalAddress} into a stable map key. `\u0000` cannot appear in a
 * Firebase UID or a server-issued deviceId, so it is an unambiguous separator.
 */
function addressKey(addr: SignalAddress): string {
  return `${addr.uid}\u0000${addr.deviceId}`;
}

/** Overwrite a byte array in place so its contents are not left in memory after a wipe. */
function zero(bytes: Uint8Array | undefined | null): void {
  if (bytes) {
    bytes.fill(0);
  }
}

/**
 * In-memory implementation of the shared {@link KeyStore} port for the Web_App.
 *
 * All state lives in the private fields below and nowhere else. No constructor
 * argument and no method reaches for a persistent store; the only durable lifetime is
 * that of this object instance in the page's JS heap.
 */
export class InMemoryKeyStore implements KeyStore {
  /** Identity material keyed by signed-in UID. Holds PRIVATE halves — memory only. */
  private identities = new Map<string, IdentityRecord>();

  /** Server-issued deviceId, or `null` until registration succeeds. */
  private deviceId: string | null = null;

  /** Serialized libsignal session records keyed by remote {@link SignalAddress}. */
  private sessions = new Map<string, Uint8Array>();

  /** Per-conversation monotonic send counter, keyed by remote UID (5.3, 6.2). */
  private seqCounters = new Map<string, number>();

  /** Conversation/message rows for display, keyed by client-generated id. */
  private messages = new Map<string, MessageRow>();

  /** Per-conversation disappearing-message timer in ms, keyed by peer uid (Req 4.1). */
  private timers = new Map<string, number>();

  /** Set once {@link destroy} runs; further reads return nothing retrievable. */
  private destroyed = false;

  /** Find a stored row by its conversation + LOCAL `(direction, seq)`, or `undefined`. */
  private findRow(remoteUid: string, direction: 'in' | 'out', seq: number): MessageRow | undefined {
    for (const row of this.messages.values()) {
      if (row.remoteUid === remoteUid && row.direction === direction && row.seq === seq) {
        return row;
      }
    }
    return undefined;
  }

  /** @inheritdoc */
  async saveIdentity(record: IdentityRecord): Promise<void> {
    this.assertLive();
    // Single assignment of a defensively-cloned record keeps the write atomic: the
    // store either holds the complete identity set or the prior value, never a
    // partially-populated record (Requirements 2.7, 2.8).
    this.identities.set(record.uid, cloneIdentity(record));
  }

  /** @inheritdoc */
  async loadIdentity(uid: string): Promise<IdentityRecord | null> {
    if (this.destroyed) {
      return null;
    }
    const record = this.identities.get(uid);
    return record ? cloneIdentity(record) : null;
  }

  /** @inheritdoc */
  async saveDeviceId(deviceId: string): Promise<void> {
    this.assertLive();
    this.deviceId = deviceId;
  }

  /** @inheritdoc */
  async loadDeviceId(): Promise<string | null> {
    if (this.destroyed) {
      return null;
    }
    return this.deviceId;
  }

  /** @inheritdoc */
  async loadSession(addr: SignalAddress): Promise<Uint8Array | null> {
    if (this.destroyed) {
      return null;
    }
    const record = this.sessions.get(addressKey(addr));
    return record ? record.slice() : null;
  }

  /** @inheritdoc */
  async saveSession(addr: SignalAddress, record: Uint8Array): Promise<void> {
    this.assertLive();
    this.sessions.set(addressKey(addr), record.slice());
  }

  /** @inheritdoc */
  async consumeOneTimePreKey(keyId: number): Promise<void> {
    this.assertLive();
    // Drop the consumed one-time prekey from every stored identity, zeroing its
    // private half first so the spent key leaves no residue in memory.
    for (const record of this.identities.values()) {
      const remaining: IdentityRecord['oneTimePreKeys'] = [];
      for (const preKey of record.oneTimePreKeys) {
        if (preKey.keyId === keyId) {
          zero(preKey.privateKey);
          zero(preKey.publicKey);
        } else {
          remaining.push(preKey);
        }
      }
      record.oneTimePreKeys = remaining;
    }
  }

  /** @inheritdoc */
  async nextSeq(recipientUid: string): Promise<number> {
    this.assertLive();
    const next = (this.seqCounters.get(recipientUid) ?? 0) + 1;
    this.seqCounters.set(recipientUid, next);
    return next;
  }

  /** @inheritdoc */
  async appendMessage(row: MessageRow): Promise<void> {
    this.assertLive();
    this.messages.set(row.id, { ...row });
  }

  /** @inheritdoc */
  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    this.assertLive();
    const existing = this.messages.get(id);
    if (existing) {
      existing.status = status;
    }
  }

  /** @inheritdoc */
  async loadMessages(): Promise<MessageRow[]> {
    this.assertLive();
    // Web storage is process-memory only (wiped on tab close / sign-out by design), so this
    // returns history accumulated within the current session — not across relaunches.
    return [...this.messages.values()].map((row) => ({ ...row }));
  }

  /** @inheritdoc */
  async applyReaction(remoteUid: string, direction: 'in' | 'out', seq: number, emoji: string): Promise<void> {
    this.assertLive();
    const row = this.findRow(remoteUid, direction, seq);
    if (!row || row.deleted === true) {
      return;
    }
    const reactions = row.reactions ?? [];
    if (!reactions.includes(emoji)) {
      row.reactions = [...reactions, emoji];
    }
  }

  /** @inheritdoc */
  async applyEdit(remoteUid: string, direction: 'in' | 'out', seq: number, body: string): Promise<void> {
    this.assertLive();
    const row = this.findRow(remoteUid, direction, seq);
    if (!row || row.deleted === true) {
      return;
    }
    row.plaintext = body;
    row.edited = true;
  }

  /** @inheritdoc */
  async applyDelete(remoteUid: string, direction: 'in' | 'out', seq: number): Promise<void> {
    this.assertLive();
    const row = this.findRow(remoteUid, direction, seq);
    if (!row) {
      return;
    }
    row.plaintext = null;
    row.deleted = true;
    row.edited = false;
    delete row.reactions;
  }

  /** @inheritdoc */
  async setConversationTimer(remoteUid: string, ttlMs: number): Promise<void> {
    this.assertLive();
    this.timers.set(remoteUid, Math.max(0, ttlMs));
  }

  /** @inheritdoc */
  async loadConversationTimers(): Promise<Record<string, number>> {
    if (this.destroyed) {
      return {};
    }
    return Object.fromEntries(this.timers);
  }

  /**
   * Synchronously wipe ALL in-memory identity, session, sequence, and message
   * material. Private-key and session bytes are overwritten with zeros before their
   * containing maps are cleared, so once this returns — within the same
   * event-handling cycle that triggered it — no identity material or session state is
   * retrievable from this store (Requirement 7.4).
   */
  destroy(): void {
    for (const record of this.identities.values()) {
      zero(record.identityKeyPrivate);
      zero(record.identityKeyPublic);
      zero(record.signedPreKey?.privateKey);
      zero(record.signedPreKey?.publicKey);
      zero(record.signedPreKey?.signature);
      for (const preKey of record.oneTimePreKeys) {
        zero(preKey.privateKey);
        zero(preKey.publicKey);
      }
    }
    for (const session of this.sessions.values()) {
      zero(session);
    }

    this.identities.clear();
    this.sessions.clear();
    this.seqCounters.clear();
    this.messages.clear();
    this.timers.clear();
    this.deviceId = null;
    this.destroyed = true;
  }

  /** Reject writes after a wipe so destroyed material cannot be repopulated in place. */
  private assertLive(): void {
    if (this.destroyed) {
      throw new Error('KeyStore has been destroyed; no further writes are permitted');
    }
  }
}

/**
 * Deep-clone an {@link IdentityRecord}, copying every `Uint8Array` so the store's copy
 * is isolated from the caller's. This keeps `saveIdentity` atomic (the caller cannot
 * mutate stored bytes after the fact) and lets {@link InMemoryKeyStore.destroy} zero
 * the store's own arrays without disturbing anything the caller still holds.
 */
function cloneIdentity(record: IdentityRecord): IdentityRecord {
  return {
    uid: record.uid,
    registrationId: record.registrationId,
    identityKeyPublic: record.identityKeyPublic.slice(),
    identityKeyPrivate: record.identityKeyPrivate.slice(),
    signedPreKey: {
      keyId: record.signedPreKey.keyId,
      publicKey: record.signedPreKey.publicKey.slice(),
      privateKey: record.signedPreKey.privateKey.slice(),
      signature: record.signedPreKey.signature.slice(),
    },
    oneTimePreKeys: record.oneTimePreKeys.map((preKey) => ({
      keyId: preKey.keyId,
      publicKey: preKey.publicKey.slice(),
      privateKey: preKey.privateKey.slice(),
    })),
    createdAt: record.createdAt,
  };
}

/** Removes the session-end wipe listeners registered by {@link registerSessionEndWipe}. */
export type UnregisterSessionEndWipe = () => void;

/**
 * Wire a {@link KeyStore.destroy} call to the page-unload / tab-close lifecycle so the
 * Web_App's in-memory keys are wiped within the same event-handling cycle the browser
 * tears the session down (Requirement 7.4).
 *
 * Both `pagehide` and `beforeunload` are registered: `pagehide` is the reliable
 * signal on mobile browsers and bfcache transitions, while `beforeunload` covers
 * desktop tab/window close and navigation. The handler calls `destroy()` synchronously
 * — no async work, no persistence — so the wipe completes before the page goes away.
 *
 * Sign-out is handled by the caller invoking `store.destroy()` directly as part of the
 * sign-out flow; this helper only covers the unload/tab-close events.
 *
 * @returns a function that removes the listeners (e.g. on a new sign-in that replaces
 *          the store instance).
 */
export function registerSessionEndWipe(
  store: Pick<KeyStore, 'destroy'>,
  target: Window = window,
): UnregisterSessionEndWipe {
  const wipe = (): void => {
    store.destroy();
  };

  target.addEventListener('pagehide', wipe);
  target.addEventListener('beforeunload', wipe);

  return () => {
    target.removeEventListener('pagehide', wipe);
    target.removeEventListener('beforeunload', wipe);
  };
}
