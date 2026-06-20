import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { DefaultConversationRegistry } from './conversation-registry';
import { hashAlias, normalizeAlias, type AliasEntry } from './shadow-chat';
import type { ShadowContext, ShadowThreadRef } from './shadow-secret-store';
import {
  createShadowSearchHandler,
  resolveSearchInput,
  type SearchResolution,
  type ShadowSearchStore,
} from './shadow-search';
import type { AppMode } from './app-lock';

/**
 * Property tests for the shared search-bar alias resolution (Shadow Chat, tasks 8.1/8.2/8.4).
 *
 * Feature: shadow-chat. These exercise the design's indistinguishability guarantees through the ONE
 * shared decision path (`resolveSearchInput`), validating:
 *   - **Correctness Property 10 (decoy reveals nothing)** — in `decoy`/`null` mode ANY input (even a
 *     correctly-bound alias) resolves to the identical ordinary-search outcome (Requirements 1.4,
 *     1.5, 8.6).
 *   - **Correctness Property 4 (alias indistinguishability)** — in real mode, an input that is not a
 *     valid alias OR whose hash is not among the stored entries yields the identical ordinary-search
 *     outcome, and a correctly-bound alias resolves to its thread (Requirements 1.3, 1.4, 1.5).
 *
 * Each property runs >=100 randomised iterations; fast-check reports the counterexample on failure.
 */

const ALIAS_KEY = Uint8Array.from([2, 4, 6, 8, 10, 12, 14, 16]);
const MASTER = Uint8Array.from([1, 3, 5, 7, 9]);

/** A real-mode-provisioned store backed by the given entries; non-real modes release nothing. */
function storeWith(entries: ReadonlyArray<AliasEntry<ShadowThreadRef>>): ShadowSearchStore {
  const context: ShadowContext = { masterSecret: MASTER, aliasKey: ALIAS_KEY };
  return {
    async getShadowContext(mode: AppMode | null): Promise<ShadowContext | null> {
      return mode === 'real' ? context : null;
    },
    async listAliasEntries(mode: AppMode | null) {
      return mode === 'real' ? entries.slice() : [];
    },
  };
}

/** Arbitrary alias body (lowercase alphanumerics), so `/${body}` is always a valid alias. */
const aliasBodyArb = fc.stringMatching(/^[a-z0-9]{1,16}$/);

/** Arbitrary free-text search input (may or may not look like an alias). */
const anyInputArb = fc.string({ maxLength: 40 });

test('Property 10: in decoy/null mode, ANY input is an ordinary search carrying the original text', async () => {
  // Feature: shadow-chat, Correctness Property 10 (decoy reveals nothing).
  await fc.assert(
    fc.asyncProperty(
      aliasBodyArb,
      fc.constantFrom('decoy' as const, null),
      async (body, mode) => {
        // Provision a store where `/${body}` IS a real bound alias — yet decoy/null must not resolve.
        const aliasHash = await hashAlias(`/${body}`, ALIAS_KEY);
        assert.ok(aliasHash !== null);
        const entries: AliasEntry<ShadowThreadRef>[] = [
          { aliasHash, ref: { peerUid: 'peer', threadId: 'a'.repeat(64) } },
        ];
        const input = `/${body}`;
        const result = await resolveSearchInput(input, mode, storeWith(entries));
        assert.deepEqual(result, { kind: 'search', query: input });
      },
    ),
    { numRuns: 150 },
  );
});

test('Property 10: decoy and null are observationally identical for any input', async () => {
  // Feature: shadow-chat, Correctness Property 10 (decoy and null indistinguishable).
  await fc.assert(
    fc.asyncProperty(anyInputArb, async (input) => {
      const store = storeWith([]);
      const decoy = await resolveSearchInput(input, 'decoy', store);
      const nul = await resolveSearchInput(input, null, store);
      assert.deepEqual(decoy, nul);
      assert.deepEqual(decoy, { kind: 'search', query: input });
    }),
    { numRuns: 150 },
  );
});

test('Property 4: in real mode, an unbound or invalid input is indistinguishable from a search', async () => {
  // Feature: shadow-chat, Correctness Property 4 (alias indistinguishability).
  await fc.assert(
    fc.asyncProperty(anyInputArb, aliasBodyArb, async (input, boundBody) => {
      // The store binds exactly ONE alias (`/${boundBody}`). The arbitrary `input` is a "miss"
      // whenever it does not normalise to that same alias.
      const boundHash = await hashAlias(`/${boundBody}`, ALIAS_KEY);
      assert.ok(boundHash !== null);
      const entries: AliasEntry<ShadowThreadRef>[] = [
        { aliasHash: boundHash, ref: { peerUid: 'peer', threadId: 'b'.repeat(64) } },
      ];
      const result = await resolveSearchInput(input, 'real', storeWith(entries));

      const normalized = normalizeAlias(input);
      const isMatch = normalized !== null && normalized === `/${boundBody}`;
      if (isMatch) {
        assert.deepEqual(result, { kind: 'shadow', threadId: 'b'.repeat(64), peerUid: 'peer' });
      } else {
        assert.deepEqual(result, { kind: 'search', query: input });
      }
    }),
    { numRuns: 200 },
  );
});

test('Property 4: a correctly-bound alias always resolves to its own thread in real mode', async () => {
  // Feature: shadow-chat, Correctness Property 4 / Requirement 1.3.
  await fc.assert(
    fc.asyncProperty(aliasBodyArb, fc.hexaString({ minLength: 64, maxLength: 64 }), fc.string({ minLength: 1, maxLength: 12 }), async (body, threadId, peerUid) => {
      const aliasHash = await hashAlias(`/${body}`, ALIAS_KEY);
      assert.ok(aliasHash !== null);
      const entries: AliasEntry<ShadowThreadRef>[] = [{ aliasHash, ref: { peerUid, threadId } }];
      const result = await resolveSearchInput(`/${body}`, 'real', storeWith(entries));
      assert.deepEqual(result, { kind: 'shadow', threadId, peerUid });
    }),
    { numRuns: 150 },
  );
});


/**
 * Feature: shadow-chat, Correctness Property 11 (per-chat PIN gating) — task 14.2.
 *
 * For an arbitrary matched shadow `ref` and an arbitrary verification outcome, the shared
 * `createShadowSearchHandler` opens the thread IFF the thread has no per-chat `pinVerifier`, OR it
 * has one AND the injected off-thread verification seam resolves `true`. In every other case (wrong
 * PIN, thrown verifier error, or — for a PIN-protected thread — a missing seam) the handler returns
 * the GENERIC `{ kind: 'denied' }` carrying no shadow-identifying field and opens nothing. A
 * no-PIN thread never invokes the seam. Each property runs >=100 randomised iterations.
 */

/** Arbitrary optional hash-only PIN verifier (a present non-empty string, or absent). */
const pinVerifierArb = fc.option(fc.string({ minLength: 1, maxLength: 32 }), { nil: undefined });

test('Property 11: a no-PIN thread opens directly and never prompts; a PIN thread opens iff verify is true', async () => {
  await fc.assert(
    fc.asyncProperty(
      aliasBodyArb,
      fc.hexaString({ minLength: 64, maxLength: 64 }),
      fc.string({ minLength: 1, maxLength: 12 }),
      pinVerifierArb,
      fc.boolean(),
      async (body, threadId, peerUid, pinVerifier, verifyOutcome) => {
        const aliasHash = await hashAlias(`/${body}`, ALIAS_KEY);
        assert.ok(aliasHash !== null);
        const ref: ShadowThreadRef =
          pinVerifier === undefined
            ? { peerUid, threadId }
            : { peerUid, threadId, pinVerifier };
        const entries: AliasEntry<ShadowThreadRef>[] = [{ aliasHash, ref }];

        const registry = new DefaultConversationRegistry();
        const opened: ShadowThreadRef[] = [];
        const verifyCalls: ShadowThreadRef[] = [];
        const handler = createShadowSearchHandler({
          store: storeWith(entries),
          registry,
          getMode: () => 'real',
          onOpenShadowThread: (r) => opened.push(r),
          onOrdinarySearch: () => undefined,
          requestPinAndVerify: async (r) => {
            verifyCalls.push(r);
            return verifyOutcome;
          },
        });

        const result = await handler(`/${body}`);

        const shouldOpen = pinVerifier === undefined || verifyOutcome;
        if (shouldOpen) {
          assert.equal((result as Extract<SearchResolution, { kind: 'shadow' }>).kind, 'shadow');
          assert.deepEqual(opened, [ref]);
        } else {
          assert.deepEqual(result, { kind: 'denied' });
          assert.deepEqual(opened, []);
          // A denial creates no shadow thread in the registry.
          assert.deepEqual(registry.listSurfaceConversations(), []);
        }
        // The off-thread seam is consulted exactly when (and only when) a PIN is set, and always
        // receives the full matched ref including its pinVerifier.
        if (pinVerifier === undefined) {
          assert.deepEqual(verifyCalls, []);
        } else {
          assert.deepEqual(verifyCalls, [ref]);
        }
      },
    ),
    { numRuns: 150 },
  );
});

test('Property 11: a PIN-protected thread with a missing verification seam always fails closed', async () => {
  await fc.assert(
    fc.asyncProperty(
      aliasBodyArb,
      fc.hexaString({ minLength: 64, maxLength: 64 }),
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.string({ minLength: 1, maxLength: 32 }),
      async (body, threadId, peerUid, pinVerifier) => {
        const aliasHash = await hashAlias(`/${body}`, ALIAS_KEY);
        assert.ok(aliasHash !== null);
        const ref: ShadowThreadRef = { peerUid, threadId, pinVerifier };
        const registry = new DefaultConversationRegistry();
        const opened: ShadowThreadRef[] = [];
        const handler = createShadowSearchHandler({
          store: storeWith([{ aliasHash, ref }]),
          registry,
          getMode: () => 'real',
          onOpenShadowThread: (r) => opened.push(r),
          onOrdinarySearch: () => undefined,
          // requestPinAndVerify omitted: cannot verify => must deny.
        });

        const result = await handler(`/${body}`);
        assert.deepEqual(result, { kind: 'denied' });
        assert.deepEqual(opened, []);
      },
    ),
    { numRuns: 100 },
  );
});
