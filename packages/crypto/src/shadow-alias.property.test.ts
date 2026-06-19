import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import {
  hashAlias,
  matchAlias,
  normalizeAlias,
  type AliasEntry,
} from './shadow-chat';
import type { ShadowThreadRef } from './shadow-secret-store';

/**
 * Property tests for the shadow `/alias` hashing + matching primitives (Shadow Chat, design
 * Component 1; task 7.4). Reuses `shadow-chat.ts` UNCHANGED.
 *
 * Feature: shadow-chat. Validates:
 *   - **Correctness Property 9 (alias plaintext is never persisted):** for arbitrary aliases and
 *     keys, `hashAlias` yields only an opaque 64-char HMAC hex, and the only stored representation in
 *     an `AliasEntry` is that `aliasHash` — the normalised/plaintext alias never appears in any
 *     persisted structure (Requirements 1.4 background, 9.2).
 *   - **Correctness Property 4 (alias indistinguishability):** for arbitrary `aliasKey`, arbitrary
 *     entry set, and an input that is either an invalid alias OR a valid alias whose hash is absent
 *     from the set, `matchAlias` returns `null`; and `matchAlias` scans EVERY entry
 *     (non-short-circuiting), so a wrong alias and a non-existent one are indistinguishable
 *     (Requirements 1.4, 1.6).
 *
 * Each property runs >=100 randomised iterations and reports fast-check's counterexample on failure.
 */

const HEX_64 = /^[0-9a-f]{64}$/;

/** Non-empty alias-HMAC key. */
const aliasKeyArb = fc.uint8Array({ minLength: 1, maxLength: 32 });

/** Lowercase alphanumeric characters that form a valid normalised alias body. */
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
/** Letters OUTSIDE the hex alphabet, so a body built from them can never be a substring of hex. */
const NON_HEX_LETTERS = 'ghijklmnopqrstuvwxyz'.split('');

/** A valid (lowercase, alphanumeric) alias body of 1..12 chars. */
const bodyArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join(''));

/**
 * A valid alias body that is GUARANTEED to contain a non-hex letter (so the body cannot coincide,
 * by chance, with a substring of a 64-char hex hash or hex threadId). Used by Property 9's
 * bare-body absence check to keep it robust against accidental hex collisions.
 */
const bodyNonHexArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...NON_HEX_LETTERS),
    fc.array(fc.constantFrom(...ALNUM), { minLength: 0, maxLength: 11 }).map((cs) => cs.join('')),
  )
  .map(([head, rest]) => head + rest);

// ---------------------------------------------------------------------------
// Property 9: alias plaintext is never persisted.
// ---------------------------------------------------------------------------

test('Property 9: hashAlias yields an opaque 64-char hex hash for any valid alias/key', async () => {
  // Feature: shadow-chat, Correctness Property 9 (opaque hash only).
  await fc.assert(
    fc.asyncProperty(aliasKeyArb, bodyArb, async (aliasKey, body) => {
      const hash = await hashAlias(`/${body}`, aliasKey);
      assert.ok(hash !== null, 'a valid alias must hash');
      assert.match(hash as string, HEX_64, 'alias hash must be a 64-char lowercase hex string');
    }),
    { numRuns: 200 },
  );
});

test('Property 9: an AliasEntry persists only the hash — the plaintext/normalised alias never appears', async () => {
  // Feature: shadow-chat, Correctness Property 9 (plaintext never persisted, Req 9.2).
  await fc.assert(
    fc.asyncProperty(aliasKeyArb, bodyNonHexArb, async (aliasKey, body) => {
      const rawAlias = `/${body}`;
      const normalised = normalizeAlias(rawAlias);
      assert.equal(normalised, rawAlias, 'precondition: body is already normalised');

      const aliasHash = (await hashAlias(rawAlias, aliasKey)) as string;
      // The only persisted representation of the alias is the opaque hash + an opaque thread ref.
      // Use an UPPERCASE peerUid so it shares no characters with the lowercase alias body, keeping
      // the bare-body absence check free of incidental collisions.
      const entry: AliasEntry<ShadowThreadRef> = {
        aliasHash,
        ref: { peerUid: 'PEER-UID', threadId: aliasHash },
      };

      // Concatenate everything that would actually be STORED (the values, not the fixed schema
      // key names) and assert no alias text leaks in.
      const dump = `${entry.aliasHash}\u0000${entry.ref.peerUid}\u0000${entry.ref.threadId}`;
      assert.ok(!dump.includes(rawAlias), `normalised alias "${rawAlias}" leaked into the entry`);
      assert.ok(!dump.includes(body), `alias body "${body}" leaked into the entry`);
    }),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Property 4: alias indistinguishability + non-short-circuiting scan.
// ---------------------------------------------------------------------------

/** An input that is EITHER an invalid alias OR a valid alias body (resolved against the stored set). */
type Query = { kind: 'invalid'; input: string } | { kind: 'absentValid'; body: string };

const queryArb: fc.Arbitrary<Query> = fc.oneof(
  // Invalid alias inputs: guarded so they truly fail the grammar.
  fc
    .oneof(
      fc.string({ maxLength: 16 }).filter((s) => normalizeAlias(s) === null),
      fc.constantFrom('hello', '/', '/has-dash', '/two words', '', '   ', '/💀'),
    )
    .map((input) => ({ kind: 'invalid' as const, input })),
  // Valid alias body (absence from the stored set is enforced inside the property via fc.pre).
  bodyArb.map((body) => ({ kind: 'absentValid' as const, body })),
);

test('Property 4: a wrong or non-existent alias returns null (indistinguishable)', async () => {
  // Feature: shadow-chat, Correctness Property 4 (the app never confirms an alias exists).
  await fc.assert(
    fc.asyncProperty(
      aliasKeyArb,
      fc.array(bodyArb, { maxLength: 10 }),
      queryArb,
      async (aliasKey, storedBodies, query) => {
        const storedNorm = new Set(storedBodies.map((b) => `/${b}`));
        const entries: AliasEntry<string>[] = [];
        for (const b of storedBodies) {
          const hash = (await hashAlias(`/${b}`, aliasKey)) as string;
          entries.push({ aliasHash: hash, ref: `/${b}` });
        }

        let input: string;
        if (query.kind === 'invalid') {
          input = query.input;
        } else {
          // A valid alias that is NOT among the stored set ⇒ its hash is absent.
          fc.pre(!storedNorm.has(`/${query.body}`));
          input = `/${query.body}`;
        }

        const result = await matchAlias(input, entries, aliasKey);
        assert.equal(result, null, `wrong/non-existent alias must resolve to null (input=${JSON.stringify(input)})`);
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 4: matchAlias examines every entry (non-short-circuiting), even when the match is first', async () => {
  // Feature: shadow-chat, Correctness Property 4 (non-short-circuiting scan — timing cannot leak the
  // match position). A counting getter on `aliasHash` proves every entry is read regardless of where
  // (or whether) a match occurs.
  await fc.assert(
    fc.asyncProperty(
      aliasKeyArb,
      bodyArb,
      fc.array(bodyArb, { maxLength: 8 }),
      async (aliasKey, matchBody, otherBodies) => {
        const matchHash = (await hashAlias(`/${matchBody}`, aliasKey)) as string;
        const otherHashes = await Promise.all(
          otherBodies.map((b) => hashAlias(`/${b}`, aliasKey) as Promise<string>),
        );
        // Place the matching hash FIRST so a short-circuiting implementation would stop early.
        const hashes = [matchHash, ...otherHashes];

        const counter = { reads: 0 };
        const entries: AliasEntry<number>[] = hashes.map((h, i) => ({
          get aliasHash(): string {
            counter.reads += 1;
            return h;
          },
          ref: i,
        }));

        const result = await matchAlias(`/${matchBody}`, entries, aliasKey);
        // Index 0 matches, so the result is a real ref (not null) — but every entry was still read.
        assert.notEqual(result, null, 'the present alias must resolve');
        assert.equal(counter.reads, entries.length, 'matchAlias must read every entry (non-short-circuiting)');
      },
    ),
    { numRuns: 200 },
  );
});
