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
 *
 * ## Optional per-chat PIN re-entry (design "Opening a shadow thread … optional PIN branch"; tasks
 * 13/14, Requirements 12.2, 12.3, 12.4, 12.7)
 *
 * A matched shadow thread MAY carry an optional, hash-only `pinVerifier` (see
 * {@link ShadowThreadRef.pinVerifier}). {@link resolveSearchInput} stays a pure decision and simply
 * surfaces that verifier on the `shadow` outcome; the gating itself lives in the ONE shared
 * {@link createShadowSearchHandler} (C2 — web and mobile branch identically). On a real-mode alias
 * match the handler branches on `pinVerifier`:
 *   - **absent (the default)** ⇒ open the thread directly, exactly as before;
 *   - **present** ⇒ the handler requires a successful off-UI-thread verification through the injected
 *     {@link ShadowSearchHandlerDeps.requestPinAndVerify} seam BEFORE opening. A correct PIN opens
 *     the thread; a wrong PIN (or any verification error, or a missing seam) yields the GENERIC
 *     {@link SearchResolution} `{ kind: 'denied' }`, which carries NO threadId, peerUid, or any other
 *     shadow-identifying field, so a failed PIN is indistinguishable from any other generic failure
 *     and never opens the thread.
 *
 * The verification itself (the `secret-hash.verifySecret(pin, ref.pinVerifier)` call) and the
 * PIN-prompt UI / busy-spinner are deliberately the platform's responsibility, injected through
 * `requestPinAndVerify`: the platform shows its prompt modal, runs `verifySecret` OFF the UI thread
 * (via the off-thread `Pbkdf2Provider` it binds at boot) inside the existing busy/spinner pattern,
 * and resolves a single boolean. The core only orchestrates the branch and must not block — it
 * `await`s the seam and then opens or denies. Keeping the branch in this one shared handler is what
 * makes web and mobile go through an identical decision path (C2).
 */

import type { AppMode } from './app-lock';
import type { ConversationRegistry } from './conversation-registry';
import { isAliasInput, matchAlias, type AliasEntry } from './shadow-chat';
import type { ShadowContext, ShadowThreadRef } from './shadow-secret-store';

/**
 * The discriminated outcome of resolving (and, for the handler, acting on) a typed search input.
 *
 *   - `shadow` — the input was a valid alias that matched a provisioned shadow thread in real mode.
 *     It carries the thread's `{ threadId, peerUid }` and, when the matched thread has an optional
 *     per-chat PIN, its hash-only `pinVerifier` (so the handler knows to require verification before
 *     opening). When the thread has no per-chat PIN, `pinVerifier` is absent and the thread opens
 *     directly.
 *   - `search` — "treat as an ordinary search"; returned for EVERY non-match case (not an alias,
 *     non-real mode, unprovisioned, no match, or any internal error), always carrying the original
 *     input as `query` so the ordinary search path is byte-for-byte identical regardless of why we
 *     fell through (Requirements 1.4, 1.5, 8.4, 8.6).
 *   - `denied` — a GENERIC failure outcome produced ONLY by {@link createShadowSearchHandler} when a
 *     matched thread's per-chat PIN failed verification (or could not be verified). It deliberately
 *     carries NO threadId, peerUid, query, or any other field, so a wrong per-chat PIN is
 *     indistinguishable from any other generic failure and reveals nothing shadow-specific
 *     (Requirements 12.3, 12.4, 12.7). {@link resolveSearchInput} itself never returns `denied` (it
 *     stays a pure, PIN-agnostic decision); only the handler can, after running the injected verify
 *     seam.
 */
export type SearchResolution =
  | {
      readonly kind: 'shadow';
      readonly threadId: string;
      readonly peerUid: string;
      readonly pinVerifier?: string;
    }
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'denied' };

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
    // Surface the matched thread plus its OPTIONAL per-chat PIN verifier (when set), so the handler
    // can require off-thread verification before opening (Requirement 12.2). `resolveSearchInput`
    // stays a pure, PIN-agnostic decision — it never prompts, verifies, or denies; it only reports
    // whether a PIN is required by including `pinVerifier`. Omit the key entirely when absent so a
    // no-PIN match's shape is unchanged (`{ kind: 'shadow', threadId, peerUid }`).
    return ref.pinVerifier === undefined
      ? { kind: 'shadow', threadId: ref.threadId, peerUid: ref.peerUid }
      : { kind: 'shadow', threadId: ref.threadId, peerUid: ref.peerUid, pinVerifier: ref.pinVerifier };
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
  /**
   * OPTIONAL per-chat PIN prompt + verification seam (design "optional PIN branch"; tasks 13/14,
   * Requirements 12.2, 12.3, 12.4, 12.7). Invoked by the handler ONLY when a real-mode alias match
   * carries a per-chat `pinVerifier`. The platform implements it by: showing its PIN-prompt modal
   * (with the existing busy/spinner pattern so submit is disabled while in flight), running
   * `secret-hash.verifySecret(pin, ref.pinVerifier)` OFF the UI thread (via the off-thread
   * `Pbkdf2Provider` it binds at boot), and resolving `true` when the entered PIN verifies, else
   * `false` (including when the user cancels). The core merely `await`s this seam and must not block:
   * `true` opens the thread, `false` (or a thrown error) yields the generic `{ kind: 'denied' }`
   * with no shadow-specific signal.
   *
   * This is the single platform-specific verification seam — keeping it injected (rather than
   * forking the handler per platform) is what lets web and mobile share ONE PIN-gating decision path
   * (C2). When OMITTED, the handler cannot verify a per-chat PIN and therefore fails CLOSED: a
   * PIN-protected thread is denied (never opened). Threads with no per-chat PIN are unaffected and
   * always open directly, so adapters that do not yet wire a prompt keep working unchanged.
   */
  readonly requestPinAndVerify?: (ref: ShadowThreadRef) => Promise<boolean>;
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
 * **Optional per-chat PIN branch (Requirements 12.2, 12.3, 12.4, 12.7).** When the shadow match
 * carries a `pinVerifier`, the thread is opened ONLY after the injected
 * {@link ShadowSearchHandlerDeps.requestPinAndVerify} seam resolves `true` (the platform prompts and
 * verifies off the UI thread). A correct PIN opens the thread and the handler returns the original
 * `{ kind: 'shadow', … }`; a wrong PIN, a thrown verification error, or a missing seam yields the
 * generic `{ kind: 'denied' }` (no shadow-identifying info) and opens nothing. A match WITHOUT a
 * `pinVerifier` opens directly, exactly as before. No `onOrdinarySearch` is invoked for a denial —
 * the prompt the platform already showed surfaces the generic failure.
 *
 * The handler is intentionally thin: all match logic lives in the pure {@link resolveSearchInput},
 * the PIN prompt/verification lives behind the injected seam, and the only side effects are the
 * registry open + the injected callbacks.
 */
export function createShadowSearchHandler(
  deps: ShadowSearchHandlerDeps,
): (input: string) => Promise<SearchResolution> {
  return async (input: string): Promise<SearchResolution> => {
    const resolution = await resolveSearchInput(input, deps.getMode(), deps.store);
    if (resolution.kind === 'search') {
      // Ordinary search path (the only non-shadow kind resolveSearchInput can produce).
      deps.onOrdinarySearch(resolution.query);
      return resolution;
    }
    if (resolution.kind !== 'shadow') {
      // Defensive: resolveSearchInput never yields `denied` (only the handler does, below), but keep
      // the switch total so a future resolution kind cannot silently open a thread.
      return resolution;
    }

    const ref: ShadowThreadRef =
      resolution.pinVerifier === undefined
        ? { peerUid: resolution.peerUid, threadId: resolution.threadId }
        : {
            peerUid: resolution.peerUid,
            threadId: resolution.threadId,
            pinVerifier: resolution.pinVerifier,
          };

    // No per-chat PIN (the default): open directly — unchanged behaviour.
    if (resolution.pinVerifier === undefined) {
      return openAndReturn(deps, ref, resolution);
    }

    // Per-chat PIN set: require a successful off-UI-thread verification through the injected seam
    // BEFORE opening. Fail CLOSED — a missing seam, a `false` result, or any thrown error all yield
    // the generic denial with no shadow-specific signal and open nothing (Requirements 12.3, 12.4).
    if (deps.requestPinAndVerify === undefined) {
      return { kind: 'denied' };
    }
    let verified = false;
    try {
      verified = await deps.requestPinAndVerify(ref);
    } catch {
      verified = false;
    }
    if (!verified) {
      return { kind: 'denied' };
    }
    return openAndReturn(deps, ref, resolution);
  };
}

/**
 * Perform the single shared open side-effect for a verified/PIN-free shadow match — open the thread
 * in the registry, then hand off to platform navigation — and return the original `shadow`
 * resolution. Factored out so the no-PIN and PIN-verified paths open through identical code.
 */
function openAndReturn(
  deps: ShadowSearchHandlerDeps,
  ref: ShadowThreadRef,
  resolution: Extract<SearchResolution, { kind: 'shadow' }>,
): SearchResolution {
  // Open (or no-op if already open) the thread locally, then hand off to platform navigation.
  deps.registry.openShadowThread(ref.threadId, ref.peerUid);
  deps.onOpenShadowThread(ref);
  return resolution;
}
