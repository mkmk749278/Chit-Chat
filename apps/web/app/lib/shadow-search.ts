/**
 * Web search-bar alias interception adapter (Shadow Chat, task 8.1).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Alias interception (UI adapter, pure-core
 * calls only)" and cross-cutting requirement **C2** (web and mobile resolve a typed search input
 * through ONE shared pure path). This module is the THIN web glue around that shared path: it does
 * NOT reimplement any alias/threadId logic — all of it lives in `@chat-app/crypto`
 * (`createShadowSearchHandler` / `normalizeAlias` / `verifySecret` and the real-PIN-gated
 * `ShadowSecretStore`). The web search bar (see `ChatSearchBar`) calls the handler this module
 * builds; the mobile adapter builds the equivalent handler from the same shared core.
 *
 * What this file adds on top of the shared core is purely the WEB platform binding:
 *   - {@link createWebShadowSearchHandler}: a thin DELEGATION to the shared-core
 *     `createShadowSearchHandler`, passing through the OPTIONAL per-chat-PIN re-entry seam
 *     ({@link WebShadowSearchDeps.requestPinAndVerify}) so web and mobile resolve AND PIN-gate
 *     `/alias` through the identical decision path (C2). It only maps the core's generic `denied`
 *     outcome onto the web {@link WebSearchResolution} `shadow-locked` arm to preserve the web
 *     public API the app + tests depend on.
 *   - {@link bindWebShadowChat}: the long-press creation/binding orchestration (task 15.2) — the
 *     missing provisioning piece — over the shared-core `ShadowSecretStore.bindAlias`, so `/alias`
 *     now resolves to a real bound thread end-to-end on web.
 *   - {@link createInMemoryShadowSecretPersistence}: a process-memory `ShadowSecretPersistence`
 *     mirroring the web `InMemoryKeyStore` (the web client keeps key material in JS memory only,
 *     wiped on session end — design "Component 6 → SQLCipher on mobile, in-memory on web"). It backs
 *     the real `ShadowSecretStore`, so the web resolves aliases through the exact same real-PIN-gated
 *     store the design specifies, not a bespoke stub.
 *   - {@link deriveSurfaceChatList} / {@link isEventNotifiable}: the task-8.3 default-view exclusion,
 *     driven straight off the shared `ConversationRegistry` so shadow threads never appear in the web
 *     chat list, notifications, or previews.
 */

import {
  ShadowSecretStore,
  createShadowSearchHandler,
  normalizeAlias,
  verifySecret,
  type AliasEntry,
  type AppMode,
  type ConversationEvent,
  type ConversationRegistry,
  type InvitedThreadRef,
  type ShadowThreadRef,
  type ShadowSecretPersistence,
  type SurfaceListEntry,
} from '@chat-app/crypto';

/**
 * A process-memory {@link ShadowSecretPersistence} for the web client. Holds the shadow master
 * secret, the alias-HMAC key, and the hash-only alias entries in JS memory ONLY — never web storage
 * — so nothing survives a tab close and nothing is ever transmitted (design C1/§9.5, mirroring
 * `InMemoryKeyStore`). Alias entries are stored under their opaque `aliasHash`; the plaintext alias
 * is never passed to or held by this store.
 */
export function createInMemoryShadowSecretPersistence(): ShadowSecretPersistence {
  let masterSecret: Uint8Array | null = null;
  let aliasKey: Uint8Array | null = null;
  const entries = new Map<string, AliasEntry<ShadowThreadRef>>();
  const invited = new Map<string, InvitedThreadRef>();
  return {
    async loadMasterSecret() {
      return masterSecret;
    },
    async saveMasterSecret(value) {
      masterSecret = value;
    },
    async loadAliasKey() {
      return aliasKey;
    },
    async saveAliasKey(value) {
      aliasKey = value;
    },
    async loadAliasEntries() {
      return [...entries.values()];
    },
    async saveAliasEntry(entry) {
      // Keyed by the opaque hash so re-binding the same alias replaces (never duplicates) the entry.
      entries.set(entry.aliasHash, entry);
    },
    async saveInvitedThread(record) {
      invited.set(record.threadId, { ...record, threadKey: record.threadKey.slice() });
    },
    async loadInvitedThreads() {
      return [...invited.values()].map((r) => ({ ...r, threadKey: r.threadKey.slice() }));
    },
    async deleteInvitedThread(threadId) {
      invited.delete(threadId);
      for (const [aliasHash, entry] of [...entries.entries()]) {
        if (entry.ref.threadId === threadId) {
          entries.delete(aliasHash);
        }
      }
    },
  };
}

/**
 * The discriminated outcome of the WEB search-bar handler. It is a superset of the core
 * `SearchResolution` shape with one extra arm, `shadow-locked`, for the re-entry per-chat-PIN gate
 * (task 15.2 / design "Opening a shadow thread … optional PIN branch"):
 *   - `shadow`        — a real-mode alias matched a provisioned thread that EITHER has no per-chat
 *                       PIN OR whose PIN was verified; the thread has been opened + navigated to.
 *   - `shadow-locked` — a real-mode alias matched a PIN-protected thread but the PIN was not
 *                       satisfied (cancelled or wrong). NOTHING is opened; the prompt surfaces a
 *                       GENERIC failure so a wrong PIN reveals nothing shadow-specific (Req 12.4).
 *   - `search`        — every non-match case (not an alias, non-real mode, unprovisioned, no match,
 *                       or any internal error), carrying the original text so the ordinary search
 *                       path is byte-for-byte identical regardless of why we fell through (Req 1.5,
 *                       8.6).
 */
export type WebSearchResolution =
  | { readonly kind: 'shadow'; readonly threadId: string; readonly peerUid: string }
  | { readonly kind: 'shadow-locked' }
  | { readonly kind: 'search'; readonly query: string };

/** Dependencies for {@link createWebShadowSearchHandler}. */
export interface WebShadowSearchDeps {
  /** The real-PIN-gated device-local shadow secret store (web: in-memory-backed). */
  readonly store: ShadowSecretStore;
  /** The shared per-thread conversation registry; a shadow hit opens its thread here. */
  readonly registry: ConversationRegistry;
  /** The current resolved app mode (or `null` when locked / no PIN). Read per-invocation. */
  readonly getMode: () => AppMode | null;
  /** Navigate to / select the now-open shadow thread (web routing). */
  readonly onOpenShadowThread: (ref: ShadowThreadRef) => void;
  /** Run the ordinary chat search with the original query (the standard, non-shadow path). */
  readonly onOrdinarySearch: (query: string) => void;
  /**
   * The re-entry per-chat-PIN seam (task 15.2 / Req 12.2–12.4, 12.7). Invoked ONLY when a matched
   * thread carries a `pinVerifier`; the web prompt asks for the per-chat PIN and verifies it OFF the
   * main work (an async `verifySecret`, with a spinner / disabled submit while in flight — see
   * {@link verifyWebPin}). Resolves `true` once the PIN is verified (open the thread) or `false` when
   * cancelled / abandoned (a wrong PIN shows a generic failure and does not open). When omitted, a
   * PIN-protected thread fails closed (never opens), so the gate can never be bypassed.
   */
  readonly requestPinAndVerify?: (ref: ShadowThreadRef) => Promise<boolean>;
}

/**
 * Build the web search-bar submit handler. It DELEGATES to the ONE shared-core
 * {@link createShadowSearchHandler} (C2 — web and mobile resolve `/alias` and PIN-gate through the
 * identical path), then maps the core outcomes onto the web {@link WebSearchResolution} shape:
 *   - a non-shadow outcome → {@link WebShadowSearchDeps.onOrdinarySearch} with the original text and
 *     a `search` result (observationally identical to a normal search, Req 1.5/8.6);
 *   - a matched thread with NO per-chat PIN → open it in the registry, navigate, return `shadow`
 *     (Req 12.1 default — opens directly);
 *   - a matched thread WITH a per-chat PIN → the core awaits
 *     {@link WebShadowSearchDeps.requestPinAndVerify}; on success it opens + navigates and returns
 *     `shadow`; on failure/cancel/missing-seam the core's generic `denied` outcome is surfaced here
 *     as `shadow-locked` (the prompt shows a generic failure, Req 12.2–12.4, 12.7).
 *
 * Opening the thread is the single shared side-effect `registry.openShadowThread(threadId, peerUid)`
 * (the explicit, locally-initiated creation point that makes subsequent inbound shadow events
 * acceptable), performed inside the shared core. The returned {@link WebSearchResolution} lets
 * callers/tests assert the branch taken.
 */
export function createWebShadowSearchHandler(
  deps: WebShadowSearchDeps,
): (input: string) => Promise<WebSearchResolution> {
  // DELEGATE to the ONE shared-core handler (C2): web and mobile resolve `/alias` and PIN-gate
  // through the IDENTICAL `createShadowSearchHandler` path. `ShadowSecretStore` structurally
  // satisfies the core's narrow `ShadowSearchStore` read surface, so the real store is passed
  // straight through. The optional per-chat-PIN seam is forwarded only when supplied so a
  // PIN-protected thread fails closed (denied → never opened) when no prompt is wired.
  const coreHandler = createShadowSearchHandler({
    store: deps.store,
    registry: deps.registry,
    getMode: deps.getMode,
    onOpenShadowThread: deps.onOpenShadowThread,
    onOrdinarySearch: deps.onOrdinarySearch,
    ...(deps.requestPinAndVerify !== undefined
      ? { requestPinAndVerify: deps.requestPinAndVerify }
      : {}),
  });
  return async (input: string): Promise<WebSearchResolution> => {
    const resolution = await coreHandler(input);
    // Map the shared-core outcomes onto the web public {@link WebSearchResolution} shape, preserving
    // the exact observable behaviour the web app + tests depend on: the core's generic
    // `{ kind: 'denied' }` (a failed/absent per-chat-PIN verification) surfaces as the web's
    // `shadow-locked` arm, while `search` and `shadow` pass through unchanged (the `shadow` arm is
    // normalised to `{ threadId, peerUid }`, dropping any internal `pinVerifier`).
    if (resolution.kind === 'denied') {
      return { kind: 'shadow-locked' };
    }
    if (resolution.kind === 'shadow') {
      return { kind: 'shadow', threadId: resolution.threadId, peerUid: resolution.peerUid };
    }
    return resolution;
  };
}

/**
 * Verify a typed per-chat PIN against a thread's hash-only `pinVerifier`, OFF the main work
 * (Req 12.3, 12.7). A thin wrapper over the shared-core `secret-hash.verifySecret` (PBKDF2,
 * constant-time compare) returning a plain boolean; any internal error is absorbed to `false` so a
 * failure can never leak a shadow-specific signal. The caller (the web PIN prompt) shows a spinner /
 * disables submit while this Promise is in flight, mirroring the mobile `runBusy` busy pattern.
 */
export async function verifyWebPin(pin: string, pinVerifier: string): Promise<boolean> {
  try {
    return await verifySecret(pin, pinVerifier);
  } catch {
    return false;
  }
}

/** Whether `input` is a grammatically valid alias (`/` + one or more lowercase alphanumerics).
 * A thin, side-effect-free wrapper over the shared-core {@link normalizeAlias} used for INLINE
 * validation in the creation sheet so an invalid alias is refused before any binding is attempted
 * (Req 11.3). Binding itself re-validates in the core `bindAlias`, so this is purely a UX guard. */
export function isValidAlias(input: string): boolean {
  return normalizeAlias(input) !== null;
}

/** Dependencies for the long-press shadow-chat creation flow {@link bindWebShadowChat}. */
export interface WebShadowCreationDeps {
  /** The real-PIN-gated device-local shadow secret store (web: in-memory-backed). */
  readonly store: ShadowSecretStore;
  /** The shared per-thread conversation registry; the created thread is opened here. */
  readonly registry: ConversationRegistry;
  /** The current resolved app mode (or `null` when locked / no PIN). Read per-invocation. */
  readonly getMode: () => AppMode | null;
  /** This device's own UID; the `(myUid, peerUid)` pair seeds the symmetric thread-id derivation. */
  readonly myUid: string;
  /** Navigate to / select the now-open shadow thread after creation (web routing). */
  readonly onOpenShadowThread: (ref: ShadowThreadRef) => void;
}

/**
 * Provision a NEW shadow chat from the long-press creation sheet (task 15.2 — the missing
 * provisioning piece). In real-PIN mode it binds the `alias` (and the OPTIONAL per-chat `pin`) to a
 * fresh alias-discriminated shadow thread via the shared-core
 * `ShadowSecretStore.bindAlias('real', alias, peerUid, myUid, pin?)`, then opens that thread in the
 * registry and hands off to platform navigation — so typing the same `/alias` later now resolves to
 * a real bound thread end-to-end (Req 1.8, 11.4, 11.6).
 *
 * Surface non-disturbance (Req 11.7, 11.8): this performs NO send, advances NO surface sequence, and
 * mutates NO surface `ConversationState` or chat-list entry — the only writes are the device-local
 * hash-only `AliasEntry` (inside `bindAlias`) and the registry's explicit shadow-thread open. The
 * created thread stays hidden (re-enter only via its `/alias`).
 *
 * Real-mode gating is enforced by the core `bindAlias`, which returns `null` (persisting nothing) in
 * any non-`real` mode; this helper then opens nothing and returns `null` (Req 11.5). It propagates a
 * thrown error from an invalid alias / a persistence failure to the caller so the sheet can surface
 * it without partially provisioning.
 *
 * @returns the bound {@link ShadowThreadRef}, or `null` when not in real mode (nothing provisioned).
 */
export async function bindWebShadowChat(
  deps: WebShadowCreationDeps,
  peerUid: string,
  alias: string,
  pin?: string,
): Promise<ShadowThreadRef | null> {
  const ref = await deps.store.bindAlias(deps.getMode(), alias, peerUid, deps.myUid, pin);
  if (ref === null) {
    return null; // non-real mode (or unprovisioned): nothing bound, nothing opened (Req 11.5)
  }
  deps.registry.openShadowThread(ref.threadId, ref.peerUid);
  deps.onOpenShadowThread(ref);
  return ref;
}

/**
 * The default web chat list, driven ENTIRELY by the shared registry's surface view (task 8.3). By
 * construction this can never contain a shadow thread, so the chat list and its previews cannot
 * reveal that a shadow thread exists (Requirements 7.5, 7.6, 8.3).
 */
export function deriveSurfaceChatList(registry: ConversationRegistry): SurfaceListEntry[] {
  return registry.listSurfaceConversations();
}

/**
 * Whether the web client may show a notification / preview for `event` (task 8.3). Delegates to the
 * registry so a `threadId`-tagged (shadow) event is never notifiable (Requirements 7.5, 7.6, 8.3).
 */
export function isEventNotifiable(registry: ConversationRegistry, event: ConversationEvent): boolean {
  return registry.isNotifiable(event);
}
