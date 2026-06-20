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
 *   - {@link createInMemoryShadowSecretPersistence} keeps the shadow secrets in RAM only. The
 *     PRODUCTION durable backing is the encrypted SQLCipher vault bound in `chat-controller.ts`
 *     (`createVaultShadowSecretPersistence`); this in-memory adapter remains for tests and as a
 *     fallback. The app wires the controller's durable store so a shadow chat created via the
 *     long-press flow survives restarts (Requirements 9.8, 9.9).
 *   - {@link MobileShadowSearchDeps.requestPinAndVerify} is the platform side of the shared core's
 *     per-chat PIN re-entry seam: it shows the mobile PIN prompt and runs `verifySecret` off the UI
 *     thread (Requirements 12.2–12.4, 12.7). It is passed straight through to
 *     `createShadowSearchHandler`, so the PIN-gating DECISION still lives in the one shared path.
 *   - {@link deriveSurfaceChatList} / {@link isEventNotifiable} provide the task-8.3 default-view
 *     exclusion straight off the shared `ConversationRegistry`.
 */

import {
  createShadowSearchHandler,
  type AliasEntry,
  type AppMode,
  type ConversationEvent,
  type ConversationRegistry,
  type InvitedThreadRef,
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

/** Dependencies for {@link createMobileShadowSearchHandler}. */
export interface MobileShadowSearchDeps {
  /** The real-PIN-gated device-local shadow secret store (durable vault-backed in production). */
  readonly store: ShadowSecretStore;
  /** The shared per-thread conversation registry; a shadow hit opens its thread here. */
  readonly registry: ConversationRegistry;
  /** The current resolved app mode (or `null` when locked / no PIN). Read per-invocation. */
  readonly getMode: () => AppMode | null;
  /** Navigate to / select the now-open shadow thread (mobile screen push). */
  readonly onOpenShadowThread: (ref: ShadowThreadRef) => void;
  /** Run the ordinary chat search/reveal with the original query (the standard, non-shadow path). */
  readonly onOrdinarySearch: (query: string) => void;
  /**
   * OPTIONAL per-chat PIN re-entry seam (Shadow Chat, Requirements 12.2–12.4, 12.7). Passed STRAIGHT
   * THROUGH to the shared {@link createShadowSearchHandler} `requestPinAndVerify` seam, so the
   * PIN-gating decision stays in the ONE shared path (C2). The core invokes it ONLY when a real-mode
   * alias match carries a `pinVerifier`; the mobile implementation shows the PIN-prompt modal and
   * runs `secret-hash.verifySecret(pin, ref.pinVerifier)` off the UI thread behind the existing
   * `runBusy` / `async-submit` spinner, resolving `true` once the entered PIN verifies, else `false`
   * (including on cancel). When omitted, a PIN-protected thread is denied (fail closed) and a thread
   * with no `pinVerifier` always opens directly (Requirements 12.1, 12.2).
   */
  readonly requestPinAndVerify?: (ref: ShadowThreadRef) => Promise<boolean>;
}

/**
 * Build the mobile search-bar submit handler. A thin delegation to the shared
 * {@link createShadowSearchHandler} so web and mobile resolve — and PIN-gate — through the IDENTICAL
 * decision path (C2). Returns the {@link SearchResolution} so callers/tests can assert the branch
 * taken; a non-shadow outcome is observationally identical to an ordinary search (Requirements 1.5,
 * 8.6), and a PIN-protected thread opens only after {@link MobileShadowSearchDeps.requestPinAndVerify}
 * confirms the PIN off the UI thread, else yields the generic denial with no shadow-specific signal
 * (Requirements 12.3, 12.4).
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
    ...(deps.requestPinAndVerify !== undefined ? { requestPinAndVerify: deps.requestPinAndVerify } : {}),
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
