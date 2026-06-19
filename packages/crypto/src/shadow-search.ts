/**
 * `@chat-app/crypto` — shared search-bar alias resolution for Shadow Chat (design Component 1 +
 * "Alias interception (UI adapter, pure-core calls only)"; tasks 8.1, 8.2).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Algorithmic Pseudocode → Alias
 * interception (UI adapter)" and cross-cutting requirement **C2** (web and mobile resolve a typed
 * search input through ONE shared pure path). This module is that one path: both the web search-bar
 * adapter (`apps/web`) and the mobile search-bar adapter (`apps/mobile`) import and call
 * {@link resolveSearchInput} / {@link createShadowSearchHandler}, so the `/alias` interception logic
 * lives in exactly one place and behaves identically on both platforms.
 *
 * The decision is deliberately PURE and total in its observable behaviour:
 *   1. If the input is not an `/alias` (per {@link isAliasInput}), it is an ordinary search.
 *   2. If the current {@link AppMode} is not `real` (decoy / null / locked), it is an ordinary
 *      search — the decoy state never resolves a shadow thread and so cannot even prove the feature
 *      exists (Requirement 8.6, design Correctness Property 10).
 *   3. If the device has no provisioned shadow context, it is an ordinary search.
 *   4. Otherwise the alias is matched against the stored, hash-only {@link AliasEntry}s via the
 *      existing, non-short-circuiting {@link matchAlias}; a hit opens the shadow thread, and a miss
 *      (wrong alias OR non-existent alias) is an ordinary search.
 *
 * Crucially, every non-match path returns the IDENTICAL discriminated result shape
 * (`{ kind: 'search', query }`) carrying the original text, so a wrong alias, a non-existent alias,
 * a decoy-mode alias, and an ordinary search are observationally indistinguishable to the caller —
 * the adapter renders them all through the standard search path with no shadow-specific result,
 * hint, error, or visual difference (Requirements 1.3, 1.4, 1.5, 8.4, 8.6). Any internal error in
 * resolution also falls through to an ordinary search, so an error can never leak that a shadow
 * thread exists.
 *
 * This module performs NO navigation and holds NO state of its own: it calls the injected
 * {@link ShadowSearchStore} read surface (a narrow view of `ShadowSecretStore`) plus the pure
 * `shadow-chat.ts` primitives, and returns a decision. {@link createShadowSearchHandler} adds the
 * one shared side-effecting step both platforms need — opening the thread in the injected
 * {@link ConversationRegistry} — while leaving platform-specific navigation to a callback.
 */

import type { AppMode } from './app-lock';
import type { ConversationRegistry } from './conversation-registry';
import { isAliasInput, matchAlias, type AliasEntry } from './shadow-chat';
import type { ShadowContext, ShadowThreadRef } from './shadow-secret-store';

/**
 * The discriminated outcome of resolving a typed search input. `shadow` means the input was a valid
 * alias that matched a provisioned shadow thread in real mode; `search` means "treat as an ordinary
 * search" and is returned for EVERY non-match case (not an alias, non-real mode, unprovisioned, no
 * match, or any internal error), always carrying the original input as `query` so the ordinary
 * search path is byte-for-byte identical regardless of why we fell through.
 */
export type SearchResolution =
  | { readonly kind: 'shadow'; readonly threadId: string; readonly peerUid: string }
  | { readonly kind: 'search'; readonly query: string };

/**
 * The narrow READ surface of the device-local `ShadowSecretStore` that alias resolution needs. It is
 * deliberately a structural subset of `ShadowSecretStore` (which already implements both methods),
 * so the platform adapter can pass the real store directly while this module stays decoupled from
 * its construction/persistence details.
 */
export interface ShadowSearchStore {
  /** Release `{ masterSecret, aliasKey }` only in real-PIN mode; `null` otherwise (real-PIN gated). */
  getShadowContext(mode: AppMode | null): Promise<ShadowContext | null>;
  /** The stored hash-only alias→thread mappings; `[]` in any non-real mode. */
  listAliasEntries(mode: AppMode | null): Promise<ReadonlyArray<AliasEntry<ShadowThreadRef>>>;
}

/**
 * Resolve a typed search `input` under the current `mode` to either an open-shadow-thread decision
 * or an ordinary-search decision, using the one shared decision path described in the module doc.
 * Pure with respect to its own state (it only reads through the injected {@link ShadowSearchStore}
 * and the pure `shadow-chat.ts` primitives) and total: it never throws and never reveals — any
 * error in the underlying store or matcher is absorbed into the indistinguishable `search` outcome.
 *
 * @param input - the raw text typed into the chat search bar.
 * @param mode - the resolved {@link AppMode}, or `null` when the app is locked / no PIN matched.
 * @param store - the device-local shadow secret store (real-PIN gated read surface).
 * @returns a {@link SearchResolution}; `shadow` only for a real-mode alias hit, else `search`.
 */
export async function resolveSearchInput(
  input: string,
  mode: AppMode | null,
  store: ShadowSearchStore,
): Promise<SearchResolution> {
  const fallthrough: SearchResolution = { kind: 'search', query: input };

  // (1) Not an alias command → ordinary search. Cheap, and avoids touching the secret store at all
  // for the overwhelmingly common ordinary-search case.
  if (!isAliasInput(input)) {
    return fallthrough;
  }
  // (2) Only the real PIN mode may ever resolve a shadow thread (decoy / null never do).
  if (mode !== 'real') {
    return fallthrough;
  }

  try {
    // (3) No provisioned shadow context → ordinary search (and listAliasEntries would be empty).
    const context = await store.getShadowContext(mode);
    if (context === null) {
      return fallthrough;
    }
    // (4) Total, non-short-circuiting match: a wrong alias and a non-existent alias both yield null.
    const entries = await store.listAliasEntries(mode);
    const ref = await matchAlias(input, entries, context.aliasKey);
    if (ref === null) {
      return fallthrough;
    }
    return { kind: 'shadow', threadId: ref.threadId, peerUid: ref.peerUid };
  } catch {
    // Fail closed to the indistinguishable ordinary-search outcome: an internal error must never
    // surface a shadow-specific signal (Requirements 8.4, 8.6).
    return fallthrough;
  }
}

/** Construction dependencies for {@link createShadowSearchHandler}. */
export interface ShadowSearchHandlerDeps {
  /** The device-local shadow secret store (real-PIN gated read surface). */
  readonly store: ShadowSearchStore;
  /** The per-thread conversation registry; a shadow hit opens its thread here. */
  readonly registry: ConversationRegistry;
  /** The current resolved {@link AppMode} (or `null` when locked / no PIN). Read per-invocation. */
  readonly getMode: () => AppMode | null;
  /**
   * Platform navigation for a resolved shadow thread: select/navigate to the now-open thread. Called
   * AFTER the thread has been opened in the registry, so the screen can render it immediately. This
   * is the only platform-specific seam — web routes/selects, mobile pushes its conversation screen.
   */
  readonly onOpenShadowThread: (ref: ShadowThreadRef) => void;
  /**
   * The ordinary search path, invoked for every non-shadow outcome with the original query text. Web
   * and mobile each pass their existing search handler so the fall-through is identical to typing a
   * normal query (Requirements 1.5, 8.4, 8.6).
   */
  readonly onOrdinarySearch: (query: string) => void;
}

/**
 * Build the ONE shared search-bar handler both `apps/web` and `apps/mobile` use (C2). It resolves
 * the input through {@link resolveSearchInput}, and on a shadow hit performs the single shared
 * side-effect — `registry.openShadowThread(threadId, peerUid)` (the explicit, locally-initiated
 * creation point that makes subsequent inbound shadow events acceptable) — then delegates navigation
 * to {@link ShadowSearchHandlerDeps.onOpenShadowThread}. On any non-shadow outcome it invokes
 * {@link ShadowSearchHandlerDeps.onOrdinarySearch} with the original text. It returns the
 * {@link SearchResolution} so callers/tests can assert which branch was taken.
 *
 * The handler is intentionally thin: all decision logic lives in the pure {@link resolveSearchInput},
 * and the only side effects are the registry open + the two injected callbacks.
 */
export function createShadowSearchHandler(
  deps: ShadowSearchHandlerDeps,
): (input: string) => Promise<SearchResolution> {
  return async (input: string): Promise<SearchResolution> => {
    const resolution = await resolveSearchInput(input, deps.getMode(), deps.store);
    if (resolution.kind === 'shadow') {
      // Open (or no-op if already open) the thread locally, then hand off to platform navigation.
      deps.registry.openShadowThread(resolution.threadId, resolution.peerUid);
      deps.onOpenShadowThread({ threadId: resolution.threadId, peerUid: resolution.peerUid });
    } else {
      deps.onOrdinarySearch(resolution.query);
    }
    return resolution;
  };
}
