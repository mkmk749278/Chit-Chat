/**
 * Web search-bar alias interception adapter (Shadow Chat, task 8.1).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Alias interception (UI adapter, pure-core
 * calls only)" and cross-cutting requirement **C2** (web and mobile resolve a typed search input
 * through ONE shared pure path). This module is the THIN web glue around that shared path: it does
 * NOT reimplement any alias/threadId logic — all of it lives in `@chat-app/crypto`
 * (`resolveSearchInput` / `createShadowSearchHandler`). The web search bar (see `ChatSearchBar`)
 * calls the handler this module builds; the identical handler is used on mobile.
 *
 * What this file adds on top of the shared core is purely the WEB platform binding:
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
  type AliasEntry,
  type AppMode,
  type ConversationEvent,
  type ConversationRegistry,
  type SearchResolution,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
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
  };
}

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
}

/**
 * Build the web search-bar submit handler. It is a one-line delegation to the shared
 * {@link createShadowSearchHandler} so web and mobile resolve through the identical decision path
 * (C2). Returns the {@link SearchResolution} so the caller/tests can assert which branch was taken;
 * a non-shadow outcome is observationally identical to an ordinary search (Requirements 1.5, 8.6).
 */
export function createWebShadowSearchHandler(
  deps: WebShadowSearchDeps,
): (input: string) => Promise<SearchResolution> {
  return createShadowSearchHandler({
    store: deps.store,
    registry: deps.registry,
    getMode: deps.getMode,
    onOpenShadowThread: deps.onOpenShadowThread,
    onOrdinarySearch: deps.onOrdinarySearch,
  });
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
