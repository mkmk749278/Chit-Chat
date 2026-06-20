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
import {
  getPbkdf2Provider,
  hashSecret,
  setPbkdf2Provider,
  type Pbkdf2Provider,
} from './secret-hash';
import { deriveShadowThreadId, hashAlias, type AliasEntry } from './shadow-chat';

/**
 * The recipient's routing decision for an invited shadow thread (Shadow Chat Invites, design
 * Component A / Component C). `'hidden'` keeps the thread a hidden shadow thread (the inviter is
 * ALWAYS `'hidden'`); `'merge'` is the recipient-only choice to surface the thread under the contact
 * in their main chat list while the underlying `ConversationState` stays an isolated shadow thread.
 */
export type RecipientRouting = 'hidden' | 'merge';

/** A device-local reference from an alias to the contact's shadow thread. */
export interface ShadowThreadRef {
  /** The contact's Firebase UID this shadow thread is with. */
  peerUid: string;
  /** The derived shadow thread id (from {@link deriveShadowThreadId}). */
  threadId: string;
  /**
   * Optional hash-only verifier for this shadow chat's per-chat PIN (design "Optional per-chat PIN",
   * Requirements 11.6, 12.5, 12.6). When a user sets a PIN on the chat, it is hashed via
   * `secret-hash.hashSecret` (PBKDF2-HMAC-SHA256) and ONLY the resulting self-describing verifier
   * string is stored here — never the plaintext PIN. Absent ⇒ the chat has no per-chat PIN and opens
   * directly (the default). The verifier is checked off the UI thread with `secret-hash.verifySecret`
   * at re-entry; it is independent of the App_Lock PIN and never transmitted off the device.
   */
  pinVerifier?: string;
}

/**
 * A device-local **invited** shadow thread — the shared-key rendezvous record introduced by Shadow
 * Chat Invites (design "Component C: ShadowSecretStore" and "Data Models → InvitedThreadRecord";
 * Requirements 2, 5, 6, 7, 8, 11, 15). Unlike a legacy alias-only {@link ShadowThreadRef} (whose
 * `threadId` is derived from the DEVICE-LOCAL `masterSecret` + alias), an invited thread's `threadId`
 * is derived from a **shared** per-thread `threadKey` that both peers hold, so the two sides converge
 * on the identical `threadId` with no handshake (design Correctness Property 1; the convergence fix).
 *
 * The shared `threadKey` is the only genuinely new secret at rest. It is wrapped by the same encrypted
 * vault that already holds the `masterSecret`/`aliasKey`, released ONLY in real mode, and NEVER
 * re-transmitted after Accept. The optional `alias` here is a purely LOCAL handle that maps to the
 * already-agreed `threadId`; it NEVER participates in the derivation for invited threads (design "Why
 * no alias discriminator in the derivation").
 */
export interface InvitedThreadRef extends ShadowThreadRef {
  /**
   * The SHARED 32-byte per-thread key (wrapped at rest by the vault). Seeds
   * {@link deriveShadowThreadId} for this invited thread and is NEVER re-transmitted after Accept.
   * Deleting it (via {@link ShadowSecretStore.revokeShadowThread}) makes `threadId` non-re-derivable.
   */
  threadKey: Uint8Array;
  /** Recipient-only routing decision; `'hidden'` (default; the inviter is always hidden) or `'merge'`. */
  routing: RecipientRouting;
  /** Lifecycle: `'awaiting-accept'` (inviter, pre-accept) → `'active'`, or `'declined'`. */
  state: 'awaiting-accept' | 'active' | 'declined';
  /** Correlates an accept/decline/revoke control message back to its invite (uuid v4). */
  inviteId: string;
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
 *
 * **Invited-thread records (Shadow Chat Invites, ADDITIVE).** The port additionally stores the
 * shared-key {@link InvitedThreadRef} records (the `InvitedThreadRecord` data model). These methods
 * are device-local only — they add NO wire/envelope/codec field and the `KeyStore` port shape stays
 * unchanged (the adapter backs them with the existing encrypted store). Adapters MUST persist each
 * `saveInvitedThread` and `deleteInvitedThread` atomically (all-or-nothing), mirroring the
 * `saveAliasEntry` contract, so an aborted invited-thread write leaves nothing partial behind and a
 * revoke never strands a record without its key (or vice-versa) (Requirements 7, 15).
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
  /**
   * Persist one invited-thread record (its shared `threadKey`, routing, state, inviteId, …) atomically
   * (Shadow Chat Invites). Upserts by `record.threadId`: a record with the same `threadId` is
   * replaced, never duplicated, so `markInvitedThreadActive` rewrites in place. The plaintext PIN is
   * never passed here — only the hash-only `pinVerifier` on the ref. Atomic per the port contract, so
   * an aborted write leaves the prior record unchanged.
   */
  saveInvitedThread(record: InvitedThreadRef): Promise<void>;
  /** Load every stored invited-thread record; `[]` when none. */
  loadInvitedThreads(): Promise<ReadonlyArray<InvitedThreadRef>>;
  /**
   * Atomic, LOCAL-ONLY delete (Shadow Chat Invites "Revoke", Requirements 7, 15). Removes the
   * {@link InvitedThreadRef} record for `threadId`, its shared `threadKey`, AND any {@link AliasEntry}
   * whose `ref.threadId === threadId`, in ONE all-or-nothing write. On any failure it MUST abort by
   * propagating, leaving nothing partial — never a keyless-record strand, and never an alias pointing
   * at a deleted thread. Deleting an absent record is a no-op (idempotent). Device-local only; no wire
   * change and the `KeyStore` port stays unchanged.
   */
  deleteInvitedThread(threadId: string): Promise<void>;
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
  /**
   * Off-UI-thread PBKDF2 provider seam used ONLY when {@link ShadowSecretStore.bindAlias} hashes an
   * optional per-chat PIN into its hash-only `pinVerifier` (design "Optional per-chat PIN" — PIN
   * hashing "runs off the UI thread (the existing off-thread `Pbkdf2Provider`) so the app never
   * freezes"; Requirements 11.6, 12.5). This is ADDITIVE and narrow: it neither changes the
   * {@link ShadowSecretPersistence} port shape nor the `secret-hash` module — when supplied, the
   * store installs this provider for the single `hashSecret` call (restoring the prior provider
   * immediately afterwards) so the expensive PBKDF2 derivation runs on the platform's background
   * thread. When omitted, PIN hashing uses whatever process-wide provider `secret-hash` already has
   * installed (on mobile the off-thread native provider bound at boot; otherwise the WebCrypto
   * default), so behaviour is unchanged for callers that do not inject one.
   */
  pbkdf2Provider?: Pbkdf2Provider;
}

/**
 * Device-local store for the shadow master secret, alias-HMAC key, and alias→thread mappings, gated
 * by {@link AppMode}. See the module doc for the full contract and fail-closed semantics.
 */
export class ShadowSecretStore {
  private readonly persistence: ShadowSecretPersistence;
  private readonly onPersistenceError?: (operation: ShadowSecretOperation, error: unknown) => void;
  private readonly pbkdf2Provider?: Pbkdf2Provider;

  /**
   * @param persistence - the narrow device-local persistence port (bound by the platform adapter to
   *   the encrypted `KeyStore`). All secrets and mappings are read/written ONLY through this port.
   * @param options - optional hooks; see {@link ShadowSecretStoreOptions}.
   */
  constructor(persistence: ShadowSecretPersistence, options: ShadowSecretStoreOptions = {}) {
    this.persistence = persistence;
    this.onPersistenceError = options.onPersistenceError;
    this.pbkdf2Provider = options.pbkdf2Provider;
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
   * 1.8, 8.2). In real mode it loads the context, derives the **alias-discriminated** `threadId` via
   * `deriveShadowThreadId(masterSecret, myUid, peerUid, alias)` — so a single contact pair can hold
   * any number of distinct shadow threads, one per distinct alias (design Component 1; Requirements
   * 1.8, 2.7–2.12) — computes the opaque `aliasHash` via `hashAlias`, optionally hashes a supplied
   * per-chat PIN into a hash-only `pinVerifier`, stores EXACTLY ONE hash-only `AliasEntry`, and
   * returns the ref.
   *
   * **Optional per-chat PIN (Requirements 11.6, 12.5, 12.6).** When a non-empty `pin` is supplied it
   * is hashed via `secret-hash.hashSecret` (PBKDF2-HMAC-SHA256) and ONLY the resulting verifier is
   * stored on `ref.pinVerifier` — never the plaintext PIN. The expensive derivation runs through the
   * injected off-UI-thread {@link ShadowSecretStoreOptions.pbkdf2Provider} seam (or the process-wide
   * provider when none is injected) so the UI never freezes. An omitted/empty `pin` leaves
   * `pinVerifier` absent — the default no-PIN chat that opens directly.
   *
   * Fails closed by ABORTING (Requirements 8.7, 9.7): any persistence-port error (loading the
   * context or saving the entry) propagates to the caller, leaving nothing partial persisted — the
   * threadId, aliasHash, and any pinVerifier are computed purely in memory and the single
   * `saveAliasEntry` is the only write, so an abort before/at that write leaves no partial mapping.
   * Returns `null` (binding nothing) when the shadow secrets are not provisioned. Throws if `alias`
   * is not a grammatically valid alias (before any write, so nothing partial is persisted).
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched.
   * @param alias - the raw alias text (e.g. `"/contact1"`); never persisted in plaintext, and also
   *   the per-chat discriminator mixed into the derived `threadId`.
   * @param peerUid - the contact's UID the shadow thread is with.
   * @param myUid - this device's own UID; the pair seeds the symmetric thread-id derivation.
   * @param pin - the optional, user-chosen per-chat PIN; when non-empty it is hashed (never stored
   *   in plaintext) into `ref.pinVerifier`. Omitted/empty ⇒ no per-chat PIN (the default).
   */
  async bindAlias(
    mode: AppMode | null,
    alias: string,
    peerUid: string,
    myUid: string,
    pin?: string,
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
    // Alias-discriminated derivation (Req 1.8, 2.7): mixing the alias in lets one contact pair hold
    // many distinct threads. Throws on a grammatically invalid alias BEFORE any write (fail-closed).
    const threadId = await deriveShadowThreadId(context.masterSecret, myUid, peerUid, alias);
    const aliasHash = await hashAlias(alias, context.aliasKey);
    if (aliasHash === null) {
      throw new Error('shadow-secret-store: cannot bind a grammatically invalid alias');
    }
    const ref: ShadowThreadRef = { peerUid, threadId };
    // Optional per-chat PIN: store ONLY the hash-only verifier, derived off the UI thread (Req 11.6,
    // 12.5). An omitted/empty PIN leaves the chat with no per-chat lock (the default).
    if (pin !== undefined && pin !== '') {
      ref.pinVerifier = await this.hashPin(pin);
    }
    // The ONLY write: store the opaque hash + ref. Never the plaintext/normalised alias or the
    // plaintext PIN (Req 9.2, 12.6).
    await this.persistence.saveAliasEntry({ aliasHash, ref });
    return ref;
  }

  /**
   * Set, change, or remove the optional per-chat PIN of an already-bound shadow thread, returning the
   * updated {@link ShadowThreadRef} (Requirements 12.5, 12.6, 12.7, 12.8). This is the "add/change/
   * remove later" companion to {@link bindAlias}'s creation-time PIN: it locates the bound entry by
   * its derived `threadId` and rewrites ONLY that entry's hash-only `pinVerifier`, leaving every other
   * field (`aliasHash`, `peerUid`, `threadId`) and every other entry untouched.
   *
   * **Hash-only, never plaintext (Requirement 12.6).** When `newPin` is a non-empty string it is
   * hashed via the existing off-UI-thread {@link hashPin} helper (PBKDF2-HMAC-SHA256 through the
   * injected {@link ShadowSecretStoreOptions.pbkdf2Provider} seam, or the process-wide provider when
   * none is injected) and ONLY the resulting verifier is stored on `ref.pinVerifier`; the plaintext
   * PIN is never persisted or transmitted. When `newPin` is `null` (or empty) the lock is removed by
   * clearing `ref.pinVerifier` to `undefined`, so the chat opens directly again (Requirement 12.1).
   *
   * **Real-mode only; inert under decoy/locked (Requirement 12.8).** In any non-`real` mode this is a
   * no-op: it returns `null` and persists nothing, so the per-chat-PIN control is inert under coercion
   * and reveals nothing. In `real` mode, if no bound entry has `ref.threadId === threadId` it returns
   * `null` and persists nothing.
   *
   * **Fails closed by ABORTING (Requirements 8.7, 9.7).** Like the other write/binding paths, any
   * persistence-port error (loading the entries or saving the updated entry) propagates to the caller,
   * leaving the prior verifier unchanged — the updated ref is computed purely in memory and the single
   * `saveAliasEntry` is the only write, so an abort before/at that write leaves the stored entry as it
   * was. It does not use `onPersistenceError` (that hook is for the fail-closed READ paths only).
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched. Only `real` acts.
   * @param threadId - the derived shadow thread id whose bound entry's per-chat PIN is being changed.
   * @param newPin - the new per-chat PIN: a non-empty string SETS/CHANGES the lock (stored hash-only),
   *   while `null` (or an empty string) REMOVES it. The plaintext is never stored or transmitted.
   */
  async setThreadPin(
    mode: AppMode | null,
    threadId: string,
    newPin: string | null,
  ): Promise<ShadowThreadRef | null> {
    if (mode !== 'real') {
      return null; // non-real mode is inert: change nothing, persist nothing (Req 12.8)
    }
    // Load entries directly (NOT via listAliasEntries) so a persistence error ABORTS by propagating,
    // rather than being swallowed to [] (Req 9.7 — write paths fail closed loudly).
    const entries = await this.persistence.loadAliasEntries();
    const entry = entries.find((candidate) => candidate.ref.threadId === threadId);
    if (entry === undefined) {
      return null; // no bound thread matches: persist nothing (Req 12.5 only acts on a bound thread)
    }
    // Touch ONLY this entry's pinVerifier; preserve aliasHash, peerUid, threadId, and every other
    // field verbatim. A non-empty PIN is hashed hash-only off the UI thread (Req 12.6, 12.7); a null
    // or empty PIN clears the lock to undefined (Req 12.1).
    const updatedRef: ShadowThreadRef = { ...entry.ref };
    if (newPin !== null && newPin !== '') {
      updatedRef.pinVerifier = await this.hashPin(newPin);
    } else {
      updatedRef.pinVerifier = undefined;
    }
    // The ONLY write: persist the same aliasHash with the updated ref. Atomic per the port contract,
    // so an abort here leaves the prior verifier unchanged (Req 9.7).
    await this.persistence.saveAliasEntry({ aliasHash: entry.aliasHash, ref: updatedRef });
    return updatedRef;
  }

  /**
   * Bind an **invited** shadow thread from a SHARED `threadKey` (Shadow Chat Invites, design
   * "Component C: ShadowSecretStore" → `bindInvitedThread`; Requirements 2, 5, 8, 11). Returns the
   * resulting {@link InvitedThreadRef} in real-PIN mode, or `null` (persisting nothing) in any
   * non-real mode (Req 8). Unlike {@link bindAlias} — which derives an alias-DISCRIMINATED `threadId`
   * from the device-local `masterSecret` — this derives the CONVERGED `threadId` via
   * `deriveShadowThreadId(threadKey, myUid, peerUid)` with **NO alias discriminator**, so both peers
   * (who share `threadKey`) compute the identical id with no handshake (design Correctness Property 1).
   *
   * The transmitted thread id is never trusted: the id is **recomputed** here from the shared key + UID
   * pair (the id is never on the wire — only the key is; design "Data Models → validation rules"). The
   * `alias`, when supplied, is persisted ONLY as a hash-only {@link AliasEntry} so `/alias` can re-open
   * the thread; it is purely a LOCAL handle and is NEVER mixed into the derivation. When a non-empty
   * `pin` is supplied it is hashed via the off-UI-thread {@link hashPin} path into a hash-only
   * `pinVerifier` — the plaintext PIN is never persisted.
   *
   * **32-byte key validation (fail-closed).** A `threadKey` that is not EXACTLY 32 bytes binds nothing
   * and returns `null`, persisting no record (the malformed-key case the design rejects up front).
   *
   * **Fails closed by ABORTING (Requirements 7, 8, 15).** Any persistence-port error (saving the
   * record or the alias entry) propagates to the caller, leaving nothing partial: the threadId,
   * aliasHash, and any pinVerifier are computed purely in memory and the writes are atomic per the
   * port contract. To keep an aborted bind from stranding a record without its alias (or vice-versa),
   * the alias entry is written FIRST and the invited-thread record SECOND — both are needed for a
   * usable bind, and either write failing aborts before the second, so no usable thread is left
   * half-bound.
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched. Only `real` binds.
   * @param threadKey - the SHARED 32-byte per-thread key; validated to be exactly 32 bytes.
   * @param peerUid - the contact's UID the invited thread is with.
   * @param myUid - this device's own UID; the pair seeds the symmetric, alias-free thread-id derivation.
   * @param options - `alias?` (local handle ⇒ an {@link AliasEntry}), `pin?` (hash-only `pinVerifier`),
   *   `routing` (recipient choice; the inviter passes `'hidden'`), `inviteId`, and the lifecycle `state`.
   */
  async bindInvitedThread(
    mode: AppMode | null,
    threadKey: Uint8Array,
    peerUid: string,
    myUid: string,
    options: {
      alias?: string;
      pin?: string;
      routing: RecipientRouting;
      inviteId: string;
      state: InvitedThreadRef['state'];
    },
  ): Promise<InvitedThreadRef | null> {
    if (mode !== 'real') {
      return null; // non-real mode binds nothing and persists nothing (Req 8)
    }
    // Validate the shared key is EXACTLY 32 bytes BEFORE any derivation or write (fail-closed): a
    // malformed key binds nothing and persists no record (design "Data Models → validation rules").
    if (threadKey.length !== 32) {
      return null;
    }
    // Converged derivation: NO alias discriminator, so both peers compute the identical threadId from
    // the shared key + UID pair (design Correctness Property 1). RECOMPUTE rather than trust any id.
    const threadId = await deriveShadowThreadId(threadKey, myUid, peerUid);
    const ref: InvitedThreadRef = {
      peerUid,
      threadId,
      threadKey,
      routing: options.routing,
      state: options.state,
      inviteId: options.inviteId,
    };
    // Optional per-chat PIN: store ONLY the hash-only verifier, derived off the UI thread; an
    // omitted/empty PIN leaves the chat with no per-chat lock (the default). Computed in memory
    // BEFORE any write so an abort leaves nothing partial.
    if (options.pin !== undefined && options.pin !== '') {
      ref.pinVerifier = await this.hashPin(options.pin);
    }
    // Optional LOCAL alias handle ⇒ a hash-only AliasEntry so `/alias` re-opens the thread. The
    // plaintext/normalised alias is NEVER persisted; only the opaque HMAC hash + ref. The hash is
    // computed in memory; an invalid alias fails closed (throws) BEFORE any write.
    let aliasEntry: AliasEntry<ShadowThreadRef> | null = null;
    if (options.alias !== undefined && options.alias !== '') {
      const context = await this.loadContext();
      if (context === null) {
        return null; // secrets not provisioned: cannot hash the alias handle, so bind nothing
      }
      const aliasHash = await hashAlias(options.alias, context.aliasKey);
      if (aliasHash === null) {
        throw new Error('shadow-secret-store: cannot bind a grammatically invalid alias');
      }
      aliasEntry = { aliasHash, ref };
    }
    // Writes (atomic per the port contract): alias entry FIRST (when present), then the record, so an
    // abort never leaves a usable thread half-bound. Each write failing propagates (Req 7, 8, 15).
    if (aliasEntry !== null) {
      await this.persistence.saveAliasEntry(aliasEntry);
    }
    await this.persistence.saveInvitedThread(ref);
    return ref;
  }

  /**
   * Promote a pending invited thread from `'awaiting-accept'` to `'active'` on `shadow-accept` (Shadow
   * Chat Invites, design "Component C" → `markInvitedThreadActive`; Requirements 5). Real-mode only
   * (decoy/null → `null`, revealing nothing). Locates the record by `inviteId`; returns `null` when no
   * such record exists. **Idempotent:** an already-`'active'` (or `'declined'`) record is returned
   * unchanged with no write, so a duplicate accept is a harmless no-op. Fails closed by ABORTING: any
   * persistence error propagates, leaving the prior record unchanged.
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched. Only `real` acts.
   * @param inviteId - correlates the inbound `shadow-accept` to its pending record.
   */
  async markInvitedThreadActive(
    mode: AppMode | null,
    inviteId: string,
  ): Promise<InvitedThreadRef | null> {
    if (mode !== 'real') {
      return null; // non-real mode is inert: change nothing, persist nothing (Req 8)
    }
    const records = await this.persistence.loadInvitedThreads();
    const record = records.find((candidate) => candidate.inviteId === inviteId);
    if (record === undefined) {
      return null; // no pending record for this invite: persist nothing
    }
    if (record.state === 'active') {
      return record; // idempotent: already promoted ⇒ no write
    }
    const promoted: InvitedThreadRef = { ...record, state: 'active' };
    // The ONLY write: upsert the same threadId with state='active'. Atomic per the port contract.
    await this.persistence.saveInvitedThread(promoted);
    return promoted;
  }

  /**
   * Discard a PENDING invited thread (its record + shared `threadKey`) on `shadow-decline` or
   * invite-expiry (Shadow Chat Invites, design "Component C" → `discardInvitedThread`; Requirements 5,
   * 8). Real-mode only — a no-op in decoy/null (reveals nothing). Locates the record by `inviteId` and
   * removes it (and any alias entry pointing at its thread) via the atomic
   * {@link ShadowSecretPersistence.deleteInvitedThread}, so nothing partial remains. **Idempotent:** a
   * missing record is a silent no-op. Fails closed by ABORTING: a persistence error propagates,
   * leaving the record intact (no partial delete).
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched. Only `real` acts.
   * @param inviteId - correlates the decline/expiry to its pending record.
   */
  async discardInvitedThread(mode: AppMode | null, inviteId: string): Promise<void> {
    if (mode !== 'real') {
      return; // non-real mode is inert: delete nothing (Req 8)
    }
    const records = await this.persistence.loadInvitedThreads();
    const record = records.find((candidate) => candidate.inviteId === inviteId);
    if (record === undefined) {
      return; // idempotent: nothing to discard
    }
    // Atomic local delete of record + key + any alias entry; propagates on failure (nothing partial).
    await this.persistence.deleteInvitedThread(record.threadId);
  }

  /**
   * "CLEAR SHADOW CHAT" — validate (real mode) that an invited-thread record for `threadId` exists and
   * return its {@link InvitedThreadRef} so the caller can purge the thread's MESSAGE history, while
   * KEEPING the record and its shared `threadKey` untouched so the chat keeps working afterwards
   * (Shadow Chat Invites, design "Component C" → `clearShadowThread`; Requirements 6). The store holds
   * secrets/mappings, NOT messages, so this touches no stored secret and performs no write — the
   * history purge runs through the message store + `KeyStore.purgeMessages` elsewhere. Real-mode only
   * (decoy/null → `null`, revealing nothing); idempotent; returns `null` when no record matches.
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched. Only `real` acts.
   * @param threadId - the converged shadow thread id whose record is validated.
   */
  async clearShadowThread(
    mode: AppMode | null,
    threadId: string,
  ): Promise<InvitedThreadRef | null> {
    if (mode !== 'real') {
      return null; // decoy/null: no-op, reveal nothing (Req 6)
    }
    const records = await this.persistence.loadInvitedThreads();
    const record = records.find((candidate) => candidate.threadId === threadId);
    if (record === undefined) {
      return null; // no such thread: nothing to clear
    }
    // KEEP the record + shared threadKey untouched (the chat keeps working). No write happens here.
    return record;
  }

  /**
   * "REVOKE SHADOW CHAT" — atomically DELETE the shared `threadKey`, the invited-thread record, and any
   * alias entry pointing at `threadId`, then return the `{ peerUid, inviteId }` the caller needs to
   * address the peer (Shadow Chat Invites, design "Component C" → `revokeShadowThread`; Requirements 7,
   * 15). After success the `threadId` is UNRECOVERABLE from this vault: its only HMAC key is gone, so
   * it cannot be re-derived or reopened (design Correctness Property 17).
   *
   * **Fails closed by ABORTING (Requirements 7, 15).** A persistence failure propagates, leaving the
   * record + key intact so a retry is safe — NEVER a partial delete that strands a keyless record. The
   * delete is a single atomic {@link ShadowSecretPersistence.deleteInvitedThread} write.
   *
   * **Idempotent.** A second revoke of an already-revoked (absent) thread returns `null` and changes
   * nothing. Real-mode only; decoy/null → `null` (reveals nothing, deletes nothing).
   *
   * @param mode - the resolved {@link AppMode}, or `null` when no PIN matched. Only `real` acts.
   * @param threadId - the converged shadow thread id to tear down.
   */
  async revokeShadowThread(
    mode: AppMode | null,
    threadId: string,
  ): Promise<{ peerUid: string; inviteId: string } | null> {
    if (mode !== 'real') {
      return null; // decoy/null: no-op, reveal nothing, delete nothing (Req 7)
    }
    const records = await this.persistence.loadInvitedThreads();
    const record = records.find((candidate) => candidate.threadId === threadId);
    if (record === undefined) {
      return null; // idempotent: already revoked / unknown ⇒ nothing to delete
    }
    // Capture the addressing info BEFORE the delete so a successful teardown still returns it. The
    // atomic delete propagates on failure, leaving the record + key intact (no keyless strand).
    const { peerUid, inviteId } = record;
    await this.persistence.deleteInvitedThread(threadId);
    return { peerUid, inviteId };
  }

  /**
   * Hash a per-chat PIN into the hash-only `pinVerifier` via `secret-hash.hashSecret`, routing the
   * expensive PBKDF2 derivation through the injected off-UI-thread {@link Pbkdf2Provider} seam when
   * one was supplied. The seam is installed for ONLY this single `hashSecret` call and the prior
   * process-wide provider is restored immediately afterwards (in a `finally`, even on throw), so the
   * `secret-hash` module is used unchanged and no global state leaks beyond the derivation. When no
   * provider was injected, the process-wide provider is used as-is (on mobile the native off-thread
   * provider installed at boot; otherwise the WebCrypto default).
   */
  private async hashPin(pin: string): Promise<string> {
    if (this.pbkdf2Provider === undefined) {
      return hashSecret(pin);
    }
    const previous = getPbkdf2Provider();
    setPbkdf2Provider(this.pbkdf2Provider);
    try {
      return await hashSecret(pin);
    } finally {
      setPbkdf2Provider(previous);
    }
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
