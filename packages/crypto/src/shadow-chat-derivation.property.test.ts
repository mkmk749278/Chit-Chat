import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { deriveShadowThreadId, normalizeAlias } from './shadow-chat';

/**
 * Property test for {@link deriveShadowThreadId} (Shadow Chat, design Component 1; task 5.2).
 *
 * Feature: shadow-chat. Validates design **Correctness Property 1 (deterministic, symmetric thread
 * id — no handshake)**: for any non-empty `masterSecret` and DISTINCT non-empty uids `a`,`b`, the
 * thread id is symmetric (`derive(s,a,b) === derive(s,b,a)`), stable across repeated calls, and a
 * 64-character lowercase hex string; two DISTINCT secrets for the same pair yield different ids
 * (compartmentalisation); and invalid input — an empty secret, an empty/missing uid, or two
 * identical uids — is rejected (Requirements 2.1–2.6). Runs >=100 randomised iterations and reports
 * fast-check's counterexample on failure. Reuses `shadow-chat.ts` UNCHANGED.
 *
 * Precondition note (refined Requirement 2.5): a usable shadow thread is always between a non-empty
 * master secret and two DISTINCT, non-empty contact uids, so the symmetry / stability /
 * compartmentalisation generators below are constrained to non-empty, distinct uids (`minLength: 1`
 * + `fc.pre(a !== b)`), and the empty/identical-uid cases are asserted to REJECT.
 */

const HEX_64 = /^[0-9a-f]{64}$/;

/** Non-empty master secret (1..64 bytes). */
const secretArb = fc.uint8Array({ minLength: 1, maxLength: 64 });
/** Non-empty uids (the derivation now rejects an empty uid; valid threads use non-empty uids). */
const uidArb = fc.string({ minLength: 1, maxLength: 32 });

/** Byte-equality for two Uint8Arrays (used to keep "distinct secrets" genuinely distinct). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

test('Property 1: thread id is symmetric and stable, and a 64-char lowercase hex string', async () => {
  // Feature: shadow-chat, Correctness Property 1 (symmetric + deterministic, no handshake).
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, uidArb, async (secret, a, b) => {
      fc.pre(a !== b); // a valid shadow thread is always between two DISTINCT contacts (Req 2.5)
      const ab1 = await deriveShadowThreadId(secret, a, b);
      const ab2 = await deriveShadowThreadId(secret, a, b);
      const ba = await deriveShadowThreadId(secret, b, a);

      // Shape: 64 lowercase hex chars (SHA-256 HMAC).
      assert.match(ab1, HEX_64, `id is not 64-char lowercase hex: ${ab1}`);
      // Stability across repeated calls.
      assert.equal(ab1, ab2, 'derivation is not stable across calls');
      // Symmetry: order of the uid pair does not matter (both peers converge, no handshake).
      assert.equal(ab1, ba, 'derivation is not symmetric in (a, b)');
    }),
    { numRuns: 200 },
  );
});

test('Property 1: two DISTINCT master secrets for the same pair yield different ids (compartmentalisation)', async () => {
  // Feature: shadow-chat, Correctness Property 1 (distinct secrets → distinct ids).
  await fc.assert(
    fc.asyncProperty(
      secretArb,
      secretArb,
      uidArb,
      uidArb,
      async (secret1, secret2, a, b) => {
        fc.pre(a !== b); // distinct, non-empty contacts (Req 2.5)
        fc.pre(!bytesEqual(secret1, secret2)); // only meaningful when the secrets genuinely differ
        const id1 = await deriveShadowThreadId(secret1, a, b);
        const id2 = await deriveShadowThreadId(secret2, a, b);
        assert.notEqual(id1, id2, 'distinct master secrets produced the same thread id');
      },
    ),
    { numRuns: 200 },
  );
});

test('Property 1: an empty master secret is rejected (throws)', async () => {
  // Feature: shadow-chat, Correctness Property 1 / Req 2.5 (empty secret rejected).
  await fc.assert(
    fc.asyncProperty(uidArb, uidArb, async (a, b) => {
      fc.pre(a !== b);
      await assert.rejects(() => deriveShadowThreadId(new Uint8Array(0), a, b), /non-empty/);
    }),
    { numRuns: 100 },
  );
});

test('Property 1: an empty or missing uid is rejected (throws) — refined Req 2.5', async () => {
  // Feature: shadow-chat, Correctness Property 1 / Req 2.5 (empty/missing uid rejected). An empty
  // uid never addressed a usable two-party thread, so derivation now fails closed on it.
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, async (secret, u) => {
      // Either side empty must reject, in either argument position.
      await assert.rejects(() => deriveShadowThreadId(secret, '', u), /non-empty/);
      await assert.rejects(() => deriveShadowThreadId(secret, u, ''), /non-empty/);
    }),
    { numRuns: 100 },
  );
  // Both empty (and therefore equal) is also rejected.
  await assert.rejects(() => deriveShadowThreadId(secretArbSample(), '', ''));
});

test('Property 1: two IDENTICAL uids are rejected (throws) — refined Req 2.5', async () => {
  // Feature: shadow-chat, Correctness Property 1 / Req 2.5 (identical uids rejected). A shadow chat
  // is always with a DIFFERENT contact; an a===a pair could never name a real two-party thread.
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, async (secret, u) => {
      await assert.rejects(() => deriveShadowThreadId(secret, u, u), /distinct/);
    }),
    { numRuns: 100 },
  );
});

/** A fixed non-empty secret for the one non-property assertion above. */
function secretArbSample(): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_v, i) => (i + 1) & 0xff);
}

/**
 * A grammatically valid normalised alias: `/` followed by one or more lowercase ASCII alphanumerics
 * (the {@link normalizeAlias} grammar). Built from a non-empty array of allowed characters so it is
 * already-normalised and round-trips unchanged, independent of fast-check string-unit options.
 */
const aliasArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 32 })
  .map((chars) => `/${chars.join('')}`)
  .filter((a) => normalizeAlias(a) === a);

/**
 * Property 1 (UPDATED — full vision): deterministic, symmetric, ALIAS-DISCRIMINATED derivation.
 *
 * Feature: shadow-chat, design Correctness Property 1. For any non-empty `masterSecret`, DISTINCT
 * non-empty uids `a`,`b`, and an arbitrary valid alias `s`, the discriminated id is symmetric
 * (`derive(secret,a,b,s) === derive(secret,b,a,s)`), stable across repeated calls, and a 64-char
 * lowercase hex string; two DISTINCT secrets for the same pair + alias yield different ids
 * (compartmentalisation is preserved with the discriminator present). Reuses `shadow-chat.ts`
 * UNCHANGED. Runs >=100 randomised iterations and reports fast-check's counterexample on failure.
 * Requirements 1.7, 2.7, 2.11.
 */
test('Property 1: alias-discriminated id is symmetric, stable, and 64-char lowercase hex', async () => {
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, uidArb, aliasArb, async (secret, a, b, s) => {
      fc.pre(a !== b);
      const ab1 = await deriveShadowThreadId(secret, a, b, s);
      const ab2 = await deriveShadowThreadId(secret, a, b, s);
      const ba = await deriveShadowThreadId(secret, b, a, s);
      assert.match(ab1, HEX_64, `discriminated id is not 64-char lowercase hex: ${ab1}`);
      assert.equal(ab1, ab2, 'discriminated derivation is not stable across calls');
      assert.equal(ab1, ba, 'discriminated derivation is not symmetric in (a, b)');
    }),
    { numRuns: 200 },
  );
});

test('Property 1: distinct master secrets yield distinct ids even WITH an alias discriminator', async () => {
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, uidArb, uidArb, aliasArb, async (secret1, secret2, a, b, s) => {
      fc.pre(a !== b);
      fc.pre(!bytesEqual(secret1, secret2));
      const id1 = await deriveShadowThreadId(secret1, a, b, s);
      const id2 = await deriveShadowThreadId(secret2, a, b, s);
      assert.notEqual(id1, id2, 'distinct secrets produced the same discriminated id');
    }),
    { numRuns: 200 },
  );
});

/**
 * Property 1b: alias-discrimination collision-resistance + legacy compatibility.
 *
 * Feature: shadow-chat, design Correctness Property 1b. For DISTINCT valid aliases `s1 != s2`,
 * `derive(...,s1) !== derive(...,s2)` (distinct aliases identify distinct threads, Req 2.8); a call
 * with the alias omitted equals the call with an empty-string alias and BOTH equal the legacy
 * derivation byte-for-byte (Req 2.9); and a discriminated id is NEVER equal to the legacy id, since
 * the `0x1f` separator is disjoint from the normalised-alias and uid charsets (Req 2.10). Reuses
 * `shadow-chat.ts` UNCHANGED. Runs >=100 randomised iterations; reports counterexamples on failure.
 * Requirements 2.8, 2.9, 2.10.
 */
test('Property 1b: distinct aliases yield distinct ids (collision resistance)', async () => {
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, uidArb, aliasArb, aliasArb, async (secret, a, b, s1, s2) => {
      fc.pre(a !== b);
      fc.pre(s1 !== s2);
      const id1 = await deriveShadowThreadId(secret, a, b, s1);
      const id2 = await deriveShadowThreadId(secret, a, b, s2);
      assert.notEqual(id1, id2, `distinct aliases ${s1} / ${s2} produced the same id`);
    }),
    { numRuns: 200 },
  );
});

test('Property 1b: omitted and empty-string alias both reproduce the byte-for-byte legacy id', async () => {
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, uidArb, async (secret, a, b) => {
      fc.pre(a !== b);
      const legacy = await deriveShadowThreadId(secret, a, b);
      const omitted = await deriveShadowThreadId(secret, a, b, undefined);
      const empty = await deriveShadowThreadId(secret, a, b, '');
      assert.equal(omitted, legacy, 'omitted alias did not reproduce the legacy id');
      assert.equal(empty, legacy, 'empty-string alias did not reproduce the legacy id');
    }),
    { numRuns: 200 },
  );
});

test('Property 1b: a discriminated id is never equal to the legacy (no-discriminator) id (disjoint spaces)', async () => {
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, uidArb, aliasArb, async (secret, a, b, s) => {
      fc.pre(a !== b);
      const legacy = await deriveShadowThreadId(secret, a, b);
      const discriminated = await deriveShadowThreadId(secret, a, b, s);
      assert.notEqual(discriminated, legacy, `discriminated id collided with legacy id for alias ${s}`);
    }),
    { numRuns: 200 },
  );
});

test('Property 1b: an invalid alias discriminator is rejected (throws) — Req 2.12', async () => {
  // A supplied, non-empty alias that fails the grammar must fail closed (no thread id produced).
  const invalidAliasArb = fc
    .string({ minLength: 1, maxLength: 16 })
    .filter((s) => s !== '' && normalizeAlias(s) === null);
  await fc.assert(
    fc.asyncProperty(secretArb, uidArb, uidArb, invalidAliasArb, async (secret, a, b, bad) => {
      fc.pre(a !== b);
      await assert.rejects(() => deriveShadowThreadId(secret, a, b, bad), /not a grammatically valid alias/);
    }),
    { numRuns: 100 },
  );
});
