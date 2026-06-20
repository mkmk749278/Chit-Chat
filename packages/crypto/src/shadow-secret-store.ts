/**
 * `@chat-app/crypto` — `ShadowSecretStore` (Shadow Chat, design Component 6).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Component 6: ShadowSecretStore" and the
 * "Decoy and Real PIN Gating" / "Device-Local Secret and Mapping Persistence" requirements
 * (Requirements 1.7, 1.8, 8.2, 8.3, 8.5, 8.7, 9.1, 9.2, 9.4, 9.5, 9.6, 9.7).
 *
 * The store is the device-local custodian of the shadow **master secret**, the **alias-HMAC key**,
 * and the **alias→thread mappings** (`AliasEntry`s). It releases the secrets and the mappings ONLY
 * in real-PIN mode ({@link AppMode} `real`); in `decoy` mode, in `null` mode (no PIN matched), and
 * in any error condition it behaves as if no shadow data exists, so a coerced or observing party
 * cannot even prove the feature is configured (design Correctness Property 10, Requirements 8.2,
 * 8.3, 8.5, 8.6, 9.4, 9.6).
 *
 * **Narrow injected persistence port (not the `KeyStore` port).** Mirroring how `messaging.ts`
 * depends on narrow ports (`MessagingStore`, `MessagingRealtime`, …) rather than the whole
 * `KeyStore`, this module persists strictly through the small {@link ShadowSecretPersistence} port
 * defined below. The `KeyStore` port is intentionally left UNCHANGED; the platform adapter binds
 * `ShadowSecretPersistence` to the existing encrypted `KeyStore` (SQLCipher on mobile, the in-memory
 * Map-backed store on web), so the master secret, the alias key, and the alias entries live only in
 * the encrypted store and are NEVER transmitted to the Backend_Server or any other network endpoint
 * (Requirements 9.1, 9.5).
 *
 * **Fail-closed semantics (Requirements 8.7, 9.7).** Read paths and write paths fail closed in two
 * complementary ways:
 *   - `getShadowContext` / `listAliasEntries` are read paths whose contract is to return `null` /
 *     `[]`. On ANY persistence-port error (or absent/empty secrets) they release NOTHING — they
 *     swallow the error to `null` / `[]` so the result is observationally identical to decoy/null
 *     mode — and surface the error out-of-band through the injected `onPersistenceError` reporter so
 *     the app can react without leaking that shadow data exists.
 *   - `putAlias` / `bindAlias` are write/binding paths. On ANY persistence-port error they ABORT by
 *     propagating the error to the caller, leaving nothing partial or plaintext persisted (the
 *     backing adapter MUST treat each write atomically). They do not return a partial result.
 *
 * Pure orchestration; no I/O and no cryptography of its own. It reuses `app-lock.ts`
 * (`AppMode` / `resolveAppMode`) and `shadow-chat.ts` (`deriveShadowThreadId`, `hashAlias`,
 * `AliasEntry`) UNCHANGED.
 */

import type { AppMode } from './app-lock';
import { deriveShadowThreadId, hashAlias, type AliasEntry } from './shadow-chat';

/** A device-local reference from an alias to the contact's shadow thread. */
export interface ShadowThreadRef {
  /** The contact's Firebase UID this shadow thread is with. */
  peerUid: string;
  /** The derived shadow thread id (from {@link deriveShadowThreadId}). */
  threadId: string;
}

/** The pair of device-local secrets released only in real-PIN mode. */
export interface ShadowContext {
  /** Seeds {@link deriveShadowThreadId}; real-PIN gated, never leaves the device. */
  masterSecret: Uint8Array;
  /** HMAC key for {@link hashAlias} / `matchAlias`; real-PIN gated, never leaves the device. */
  aliasKey: Uint8Array;
}

/**
 * The narrow device-local persistence port for shadow secrets and alias mappings. It stores exactly
 * three things — the master secret, the alias key, and the set of {@link AliasEntry}s — and is the
 * ONLY sink the {@link ShadowSecretStore} ever writes secrets to (Requirements 9.1, 9.5). The
 * platform adapter backs this with the existing encrypted `KeyStore`; the `KeyStore` port itself is
 * not modified.
 *
 * Adapters MUST persist each `saveAliasEntry` atomically (all-or-nothing) so an aborted write leaves
 * no partial or plaintext mapping behind (Requirement 9.7). A load returns `null` when the secret
 * has not been provisioned; `loadAliasEntries` returns `[]` when none are stored.
 */
export interface ShadowSecretPersistence {
  /** Load the stored shadow master secret, or `null` when not provisioned. */
  loadMasterSecret(): Promise<Uint8Array | null>;
  /** Persist the shadow master secret into the encrypted store. */
  saveMasterSecret(masterSecret: Uint8Array): Promise<void>;
  /** Load the stored alias-HMAC key, or `null` when not provisioned. */
  loadAliasKey(): Promise<Uint8Array | null>;
  /** Persist the alias-HMAC key into the encrypted store. */
  saveAliasKey(aliasKey: Uint8Array): Promise<void>;
  /** Load every stored alias entry (hash-only mappings); `[]` when none. */
  loadAliasEntries(): Promise<ReadonlyArray<AliasEntry<ShadowThreadRef>>>;
  /** Persist one alias entry (hash + ref) atomically; the plaintext alias is never passed here. */
  saveAliasEntry(entry: AliasEntry<ShadowThreadRef>): Promise<void>;
}

/** The persistence operations whose failure is reported through {@link ShadowSecretStoreOptions}. */
export type ShadowSecretOperation = 'getShadowContext' | 'listAliasEntries';

/** Optional construction hooks for the {@link ShadowSecretStore}. */
export interface ShadowSecretStoreOptions {
  /**
   * Out-of-band error signal for the fail-closed READ paths (`getShadowContext` / `listAliasEntries`).
   * Those methods return `null` / `[]` on a persistence error so the visible result stays identical
   * to decoy/null mode; this hook lets the app observe that a persistence error happened WITHOUT
   * the return value revealing that shadow data exists (Requirements 8.7, 9.7). Never receives a
   * secret value. Write paths (`putAlias` / `bindAlias`) do not use this hook — they propagate.
   */
  onPersistenceError?: (operation: ShadowSecretOperation, error: unknown) => void;
}

/**
 * Device-local store for the shadow master secret, alias-HMAC key, and alias→thread mappings, gated
 * by {@link AppMode}. See the module doc for the full contract and fail-closed semantics.
 */
export class ShadowSecretStore {
  private readonly persistence: ShadowSecretPersistence;
  private readonly onPersistenceError?: (operation: ShadowSecretOperation, error: unknown) => void;

  /**
   * @param persistence - the narrow device-local persistence port (bound by the platform adapter to
   *   the encrypted `KeyStore`). All secrets and mappings are read/written ONLY through this port.
   * @param options - optional hooks; see {@link ShadowSecretStoreOptions}.
   */
  constructor(persistence: ShadowSecretPersistence, options: ShadowSecretStoreOptions = {}) {
    this.persistence = persistence;
    this.onPersistenceError = options.onPersistenceError;
  }

  /**
   * Release the shadow context (`{ masterSecret, aliasKey }`) ONLY in real-PIN mode; return `null`
   * for `decoy` mode, for `null` mode, and whenever the secrets are not fully provisioned
   * (Requirements 8.2, 8.5, 9.4, 9.6). Fails closed: on any persistence-port error this releases no
   * context (returns `null`) and surfaces the error through `onPersistenceError` rather than
   * throwing, so the observable result is identical to decoy/null mode (Requirement 8.7).
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched.
   */
  async getShadowContext(mode: AppMode | null): Promise<ShadowContext | null> {
    if (mode !== 'real') {
      return null;
    }
    try {
      return await this.loadContext();
    } catch (error) {
      this.onPersistenceError?.('getShadowContext', error);
      return null;
    }
  }

  /**
   * List the stored alias entries ONLY in real-PIN mode; return `[]` for `decoy`/`null` mode so no
   * alias resolves and no shadow thread is listed (Requirements 8.3, 9.4, 9.6). Fails closed: on any
   * persistence-port error this returns `[]` and surfaces the error through `onPersistenceError`
   * rather than throwing (Requirement 8.7).
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched.
   */
  async listAliasEntries(mode: AppMode | null): Promise<ReadonlyArray<AliasEntry<ShadowThreadRef>>> {
    if (mode !== 'real') {
      return [];
    }
    try {
      return await this.persistence.loadAliasEntries();
    } catch (error) {
      this.onPersistenceError?.('listAliasEntries', error);
      return [];
    }
  }

  /**
   * Persist one alias→thread mapping as a hash-only {@link AliasEntry} (Requirement 9.2). This is a
   * real-mode BINDING operation: callers (the binding flow / {@link bindAlias}) invoke it only after
   * resolving `AppMode === 'real'`. The plaintext/normalised alias is NEVER passed here — only the
   * opaque `aliasHash` (produced by `hashAlias`) and the `ref` are stored.
   *
   * Fails closed by ABORTING (Requirement 9.7): on any persistence-port error the error propagates to
   * the caller and nothing partial or plaintext is left persisted (the backing adapter writes
   * atomically). The write path does not swallow errors — propagation IS the surfacing.
   */
  async putAlias(entry: AliasEntry<ShadowThreadRef>): Promise<void> {
    // Abort on error: let it propagate so the caller knows the binding did not persist.
    await this.persistence.saveAliasEntry(entry);
  }

  /**
   * Bind an `alias` to a contact's shadow thread in real-PIN mode and return the resulting
   * {@link ShadowThreadRef}, or `null` (persisting nothing) in any non-real mode (Requirements 1.7,
   * 1.8, 8.2). In real mode it loads the context, derives the `threadId` via `deriveShadowThreadId`,
   * computes the opaque `aliasHash` via `hashAlias`, stores the hash-only `AliasEntry`, and returns
   * the ref.
   *
   * Fails closed by ABORTING (Requirements 8.7, 9.7): any persistence-port error (loading the
   * context or saving the entry) propagates to the caller, leaving nothing partial persisted — the
   * threadId is derived purely in memory and the single `saveAliasEntry` is the only write, so an
   * abort before/at that write leaves no partial mapping. Returns `null` (binding nothing) when the
   * shadow secrets are not provisioned. Throws if `alias` is not a grammatically valid alias.
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched.
   * @param alias - the raw alias text (e.g. `"/contact1"`); never persisted in plaintext.
   * @param peerUid - the contact's UID the shadow thread is with.
   * @param myUid - this device's own UID; the pair seeds the symmetric thread-id derivation.
   */
  async bindAlias(
    mode: AppMode | null,
    alias: string,
    peerUid: string,
    myUid: string,
  ): Promise<ShadowThreadRef | null> {
    if (mode !== 'real') {
      return null; // non-real mode binds nothing and persists nothing (Req 8.2, 8.6)
    }
    // Load context directly (NOT via getShadowContext) so a persistence error ABORTS the binding
    // by propagating, rather than being swallowed to null (Req 9.7 — write paths fail closed loudly).
    const context = await this.loadContext();
    if (context === null) {
      return null; // secrets not provisioned: nothing to bind against
    }
    const threadId = await deriveShadowThreadId(context.masterSecret, myUid, peerUid);
    const aliasHash = await hashAlias(alias, context.aliasKey);
    if (aliasHash === null) {
      throw new Error('shadow-secret-store: cannot bind a grammatically invalid alias');
    }
    const ref: ShadowThreadRef = { peerUid, threadId };
    // The ONLY write: store the opaque hash + ref. Never the plaintext/normalised alias (Req 9.2).
    await this.persistence.saveAliasEntry({ aliasHash, ref });
    return ref;
  }

  /**
   * Load and validate the device-local secrets. Returns `null` when either secret is missing or
   * empty (treated as "not provisioned"), so a half-configured store releases no usable context.
   * Propagates persistence-port errors to the caller; the public read methods catch and fail closed.
   */
  private async loadContext(): Promise<ShadowContext | null> {
    const [masterSecret, aliasKey] = await Promise.all([
      this.persistence.loadMasterSecret(),
      this.persistence.loadAliasKey(),
    ]);
    if (
      masterSecret === null ||
      aliasKey === null ||
      masterSecret.length === 0 ||
      aliasKey.length === 0
    ) {
      return null;
    }
    return { masterSecret, aliasKey };
  }
}
