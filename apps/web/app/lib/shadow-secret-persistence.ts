/**
 * Web `ShadowSecretPersistence` adapter — in-memory (session) only (Shadow Chat, task 12.2).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Component 6: ShadowSecretStore" /
 * "Durable encrypted persistence (UPDATED)" and `.kiro/specs/shadow-chat/requirements.md` →
 * Requirement 9 (Device-local secret and mapping persistence), specifically 9.5, 9.8, and 9.9.
 *
 * The mobile client persists the shadow master secret, the alias-HMAC key, and the alias→thread
 * mappings durably in the encrypted SQLCipher vault so they survive restarts (task 12.1). The web
 * client, by deliberate design, keeps ALL key material in JavaScript memory ONLY — exactly like the
 * web `InMemoryKeyStore` — so the shadow secrets live for the session and are wiped on tab close /
 * sign-out, never written to `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, cookies, or
 * any other persistent web-storage API (Requirement 9.5: "as in-memory state on the Web_App"). This
 * module is the concrete web binding of the narrow {@link ShadowSecretPersistence} port from
 * `@chat-app/crypto`; the port's shape is used UNCHANGED.
 *
 * **What it stores (Requirement 9.8, 9.9).** The master secret, the alias key, and the full set of
 * hash-only {@link AliasEntry}s — including each entry's optional per-chat PIN `pinVerifier` (the
 * hash-only PBKDF2 verifier that may ride on the {@link ShadowThreadRef}). The plaintext alias and
 * the plaintext per-chat PIN are NEVER passed to or held by this store — only the opaque `aliasHash`
 * and the `ref` (which itself carries only the peer UID, the derived threadId, and, when set, the
 * `pinVerifier`).
 *
 * **Atomic-write contract (Requirement 9.7).** Every write path is all-or-nothing: the new value is
 * fully validated and defensively cloned into a standalone object FIRST, and only then committed with
 * a single in-place assignment / `Map.set`. If validation throws, no field and no map entry has been
 * mutated, so an aborted write leaves nothing partial or plaintext behind. Defensive cloning also
 * keeps each committed write isolated — a caller that later mutates the array/object it passed in
 * cannot retroactively corrupt the stored copy.
 *
 * **Session-end wipe.** {@link InMemoryShadowSecretPersistence.destroy} zeroes the secret bytes and
 * clears the alias map within the same event-handling cycle; {@link registerShadowSecretSessionEndWipe}
 * wires it to the page-unload lifecycle, mirroring the web `KeyStore`'s `registerSessionEndWipe`.
 */

import {
  ShadowSecretStore,
  type AliasEntry,
  type InvitedThreadRef,
  type ShadowSecretPersistence,
  type ShadowSecretStoreOptions,
  type ShadowThreadRef,
} from '@chat-app/crypto';

/** Overwrite a byte array in place so its contents are not left in memory after a wipe. */
function zero(bytes: Uint8Array | null): void {
  if (bytes) {
    bytes.fill(0);
  }
}

/**
 * Deep-clone a {@link ShadowThreadRef}, copying every own enumerable property so the stored copy is
 * isolated from the caller's. The spread preserves any optional `pinVerifier` (and any other field
 * the ref carries) verbatim, so the in-memory store round-trips the full {@link AliasEntry} the
 * design specifies (Requirement 9.9) without this adapter needing to know each field by name.
 */
function cloneRef(ref: ShadowThreadRef): ShadowThreadRef {
  return { ...ref };
}

/** Deep-clone an {@link AliasEntry} (opaque hash + cloned ref) into a standalone, isolated object. */
function cloneEntry(entry: AliasEntry<ShadowThreadRef>): AliasEntry<ShadowThreadRef> {
  return { aliasHash: entry.aliasHash, ref: cloneRef(entry.ref) };
}

/**
 * Deep-clone an {@link InvitedThreadRef} (Shadow Chat Invites), copying the 32-byte shared
 * `threadKey` into a fresh `Uint8Array` so the stored copy is fully isolated from the caller's — a
 * later mutation/zeroing of the passed-in key cannot corrupt the stored record, and vice-versa.
 */
function cloneInvited(record: InvitedThreadRef): InvitedThreadRef {
  return { ...record, threadKey: record.threadKey.slice() };
}

/**
 * In-memory (session) implementation of the shared {@link ShadowSecretPersistence} port for the
 * Web_App. All state lives in the private fields below and nowhere else; no method reaches for any
 * persistent store. See the module doc for the storage scope, the atomic-write contract, and the
 * session-end wipe semantics.
 */
export class InMemoryShadowSecretPersistence implements ShadowSecretPersistence {
  /** The shadow master secret, or `null` until provisioned. Memory only; never transmitted. */
  private masterSecret: Uint8Array | null = null;

  /** The alias-HMAC key, or `null` until provisioned. Memory only; never transmitted. */
  private aliasKey: Uint8Array | null = null;

  /** Hash-only alias entries keyed by their opaque `aliasHash` so a re-bind replaces, never dupes. */
  private readonly entries = new Map<string, AliasEntry<ShadowThreadRef>>();

  /** Invited shadow threads (Shadow Chat Invites) keyed by `threadId`; holds the shared `threadKey`. */
  private readonly invited = new Map<string, InvitedThreadRef>();

  /** Set once {@link destroy} runs; further writes are rejected so wiped secrets cannot return. */
  private destroyed = false;

  /** @inheritdoc */
  async loadMasterSecret(): Promise<Uint8Array | null> {
    if (this.destroyed || this.masterSecret === null) {
      return null;
    }
    // Hand back a copy so callers cannot mutate (or zero) the stored secret in place.
    return this.masterSecret.slice();
  }

  /** @inheritdoc */
  async saveMasterSecret(masterSecret: Uint8Array): Promise<void> {
    this.assertLive();
    // Clone first, then a single atomic assignment: an aborted/invalid call leaves the prior value.
    const next = this.toStoredBytes(masterSecret, 'masterSecret');
    this.masterSecret = next;
  }

  /** @inheritdoc */
  async loadAliasKey(): Promise<Uint8Array | null> {
    if (this.destroyed || this.aliasKey === null) {
      return null;
    }
    return this.aliasKey.slice();
  }

  /** @inheritdoc */
  async saveAliasKey(aliasKey: Uint8Array): Promise<void> {
    this.assertLive();
    const next = this.toStoredBytes(aliasKey, 'aliasKey');
    this.aliasKey = next;
  }

  /** @inheritdoc */
  async loadAliasEntries(): Promise<ReadonlyArray<AliasEntry<ShadowThreadRef>>> {
    if (this.destroyed) {
      return [];
    }
    // Return isolated clones so the registry/store cannot mutate the stored entries (incl. pinVerifier).
    return [...this.entries.values()].map(cloneEntry);
  }

  /** @inheritdoc */
  async saveAliasEntry(entry: AliasEntry<ShadowThreadRef>): Promise<void> {
    this.assertLive();
    // Validate + clone into a standalone entry BEFORE any mutation, so an invalid write is rejected
    // with nothing partial persisted (Requirement 9.7). The single Map.set below is the commit.
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('shadow-secret-persistence: alias entry must be an object');
    }
    if (typeof entry.aliasHash !== 'string' || entry.aliasHash.length === 0) {
      throw new TypeError('shadow-secret-persistence: alias entry requires a non-empty aliasHash');
    }
    if (entry.ref === null || typeof entry.ref !== 'object') {
      throw new TypeError('shadow-secret-persistence: alias entry requires a ref object');
    }
    const stored = cloneEntry(entry);
    this.entries.set(stored.aliasHash, stored);
  }

  /** @inheritdoc */
  async saveInvitedThread(record: InvitedThreadRef): Promise<void> {
    this.assertLive();
    // Validate + clone into a standalone record BEFORE the single Map.set commit (atomic; Req 15).
    if (record === null || typeof record !== 'object') {
      throw new TypeError('shadow-secret-persistence: invited thread must be an object');
    }
    if (typeof record.threadId !== 'string' || record.threadId.length === 0) {
      throw new TypeError('shadow-secret-persistence: invited thread requires a non-empty threadId');
    }
    if (!(record.threadKey instanceof Uint8Array) || record.threadKey.length !== 32) {
      throw new TypeError('shadow-secret-persistence: invited thread requires a 32-byte threadKey');
    }
    this.invited.set(record.threadId, cloneInvited(record));
  }

  /** @inheritdoc */
  async loadInvitedThreads(): Promise<ReadonlyArray<InvitedThreadRef>> {
    if (this.destroyed) {
      return [];
    }
    return [...this.invited.values()].map(cloneInvited);
  }

  /** @inheritdoc */
  async deleteInvitedThread(threadId: string): Promise<void> {
    this.assertLive();
    // All-or-nothing local delete of the record + its shared threadKey + any AliasEntry pointing at
    // the threadId, so a revoke never strands a keyless record (Req 7, 15). Zero the key bytes first.
    const existing = this.invited.get(threadId);
    if (existing !== undefined) {
      zero(existing.threadKey);
      this.invited.delete(threadId);
    }
    for (const [aliasHash, entry] of [...this.entries.entries()]) {
      if (entry.ref.threadId === threadId) {
        this.entries.delete(aliasHash);
      }
    }
  }

  /**
   * Synchronously wipe all in-memory shadow secrets and alias mappings: the master secret and alias
   * key bytes are overwritten with zeros before being released, and the alias map is cleared, so once
   * this returns nothing is retrievable from this store within the same event-handling cycle. Marks
   * the store destroyed so later writes are rejected.
   */
  destroy(): void {
    zero(this.masterSecret);
    zero(this.aliasKey);
    this.masterSecret = null;
    this.aliasKey = null;
    this.entries.clear();
    // Zero every shared invited-thread key before releasing the records (session-end wipe).
    for (const record of this.invited.values()) {
      zero(record.threadKey);
    }
    this.invited.clear();
    this.destroyed = true;
  }

  /** Defensively copy and validate raw secret bytes for storage. */
  private toStoredBytes(value: Uint8Array, name: string): Uint8Array {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError(`shadow-secret-persistence: ${name} must be a Uint8Array`);
    }
    return value.slice();
  }

  /** Reject writes after a wipe so destroyed secrets cannot be repopulated in place. */
  private assertLive(): void {
    if (this.destroyed) {
      throw new Error('ShadowSecretPersistence has been destroyed; no further writes are permitted');
    }
  }
}

/** The provisioned web shadow-secret pieces returned by {@link createWebShadowSecretStore}. */
export interface WebShadowSecretStore {
  /** The in-memory persistence adapter (held so the boot path can wipe it on session end). */
  readonly persistence: InMemoryShadowSecretPersistence;
  /** The real-PIN-gated {@link ShadowSecretStore} bound to {@link persistence}. */
  readonly store: ShadowSecretStore;
}

/**
 * Provision the web client's {@link ShadowSecretStore} at boot, bound to a fresh in-memory
 * {@link InMemoryShadowSecretPersistence}. This is the web app's boot/provisioning entry point for
 * shadow-secret persistence (task 12.2): the running app constructs it once on launch so the store
 * is ready to release shadow context / alias entries in real-PIN mode, reading from the same durable
 * (for the session) in-memory state for the lifetime of the page.
 *
 * @param options - optional {@link ShadowSecretStoreOptions} (e.g. the fail-closed read-path
 *   `onPersistenceError` reporter) forwarded to the {@link ShadowSecretStore}.
 */
export function createWebShadowSecretStore(
  options: ShadowSecretStoreOptions = {},
): WebShadowSecretStore {
  const persistence = new InMemoryShadowSecretPersistence();
  const store = new ShadowSecretStore(persistence, options);
  return { persistence, store };
}

/** Removes the session-end wipe listeners registered by {@link registerShadowSecretSessionEndWipe}. */
export type UnregisterShadowSecretSessionEndWipe = () => void;

/**
 * Wire {@link InMemoryShadowSecretPersistence.destroy} to the page-unload / tab-close lifecycle so
 * the web client's in-memory shadow secrets are wiped within the same event-handling cycle the
 * browser tears the session down — matching the web `KeyStore`'s `registerSessionEndWipe` and the
 * "in-memory on web, wiped on session end" persistence model (Requirement 9.5).
 *
 * Both `pagehide` (reliable on mobile browsers / bfcache) and `beforeunload` (desktop tab/window
 * close and navigation) are registered; the handler calls `destroy()` synchronously so the wipe
 * completes before the page goes away. Sign-out is handled by the caller invoking `destroy()`
 * directly; this helper only covers the unload/tab-close events.
 *
 * @returns a function that removes the listeners (e.g. when a new sign-in replaces the store).
 */
export function registerShadowSecretSessionEndWipe(
  persistence: Pick<InMemoryShadowSecretPersistence, 'destroy'>,
  target: Window = window,
): UnregisterShadowSecretSessionEndWipe {
  const wipe = (): void => {
    persistence.destroy();
  };

  target.addEventListener('pagehide', wipe);
  target.addEventListener('beforeunload', wipe);

  return () => {
    target.removeEventListener('pagehide', wipe);
    target.removeEventListener('beforeunload', wipe);
  };
}
