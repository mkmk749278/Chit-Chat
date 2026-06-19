/**
 * Mobile search-bar alias interception adapter (Shadow Chat, task 8.2).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Alias interception (UI adapter, pure-core
 * calls only)" and cross-cutting requirement **C2** (web and mobile resolve a typed search input
 * through ONE shared pure path). This module is the THIN mobile glue around that shared path and is
 * deliberately the MIRROR of `apps/web/app/lib/shadow-search.ts`: both construct the IDENTICAL
 * shared `createShadowSearchHandler` from `@chat-app/crypto`, so the `/alias` decision logic exists
 * in exactly one place and behaves identically on both platforms. No alias/threadId logic is
 * reimplemented here.
 *
 * It is intentionally free of any React Native import so the decision/wiring stays pure and
 * unit-testable under the mobile `node --test` runner (see `shadow-search.test.ts`).
 *
 * Mobile platform binding notes:
 *   - {@link createInMemoryShadowSecretPersistence} keeps the shadow secrets in RAM only. The design
 *     specifies the encrypted SQLCipher `KeyStore` as the durable backing on mobile; binding that
 *     durable adapter (and the alias-PROVISIONING flow that writes a master secret / alias key) is
 *     out of task 8's scope — and the task-8 constraint forbids changing the `KeyStore` port — so
 *     until provisioning lands the store is simply unprovisioned and EVERY alias input correctly
 *     falls through to an ordinary search, indistinguishably (Requirements 1.5, 8.6). The shared
 *     decision path is fully wired and ready for that durable store to be dropped in.
 *   - {@link deriveSurfaceChatList} / {@link isEventNotifiable} provide the task-8.3 default-view
 *     exclusion straight off the shared `ConversationRegistry`.
 */

import {
  createShadowSearchHandler,
  type AliasEntry,
  type AppMode,
  type ConversationEvent,
  type ConversationRegistry,
  type SearchResolution,
  type ShadowSecretPersistence,
  type ShadowSecretStore,
  type ShadowThreadRef,
  type SurfaceListEntry,
} from '@chat-app/crypto';

/**
 * A process-memory {@link ShadowSecretPersistence} for the mobile client. Holds the shadow master
 * secret, alias-HMAC key, and hash-only alias entries in RAM only — never the network (design
 * C1/§9.5). Alias entries are keyed by their opaque `aliasHash`; the plaintext alias is never held.
 * (Durable encrypted-`KeyStore` backing is the documented follow-up; see the module doc.)
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
      entries.set(entry.aliasHash, entry);
    },
  };
}

/** Dependencies for {@link createMobileShadowSearchHandler}. */
export interface MobileShadowSearchDeps {
  /** The real-PIN-gated device-local shadow secret store (mobile: in-memory-backed for now). */
  readonly store: ShadowSecretStore;
  /** The shared per-thread conversation registry; a shadow hit opens its thread here. */
  readonly registry: ConversationRegistry;
  /** The current resolved app mode (or `null` when locked / no PIN). Read per-invocation. */
  readonly getMode: () => AppMode | null;
  /** Navigate to / select the now-open shadow thread (mobile screen push). */
  readonly onOpenShadowThread: (ref: ShadowThreadRef) => void;
  /** Run the ordinary chat search/reveal with the original query (the standard, non-shadow path). */
  readonly onOrdinarySearch: (query: string) => void;
}

/**
 * Build the mobile search-bar submit handler. A one-line delegation to the shared
 * {@link createShadowSearchHandler} so web and mobile resolve through the identical decision path
 * (C2). Returns the {@link SearchResolution} so the caller/tests can assert the branch taken; a
 * non-shadow outcome is observationally identical to an ordinary search (Requirements 1.5, 8.6).
 */
export function createMobileShadowSearchHandler(
  deps: MobileShadowSearchDeps,
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
 * The default mobile chat list, driven ENTIRELY by the shared registry's surface view (task 8.3).
 * By construction this can never contain a shadow thread (Requirements 7.5, 7.6, 8.3).
 */
export function deriveSurfaceChatList(registry: ConversationRegistry): SurfaceListEntry[] {
  return registry.listSurfaceConversations();
}

/**
 * Whether the mobile client may show a notification / preview for `event` (task 8.3). Delegates to
 * the registry so a `threadId`-tagged (shadow) event is never notifiable (Requirements 7.5, 7.6,
 * 8.3).
 */
export function isEventNotifiable(registry: ConversationRegistry, event: ConversationEvent): boolean {
  return registry.isNotifiable(event);
}
