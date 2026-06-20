import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import {
  canonicalSortUids,
  deriveShadowThreadId,
  hashAlias,
  isAliasInput,
  matchAlias,
  normalizeAlias,
} from './shadow-chat';

/** Tests for the shadow-chat core (Signature Feature 7, §9). Run under `node --test` WebCrypto. */

const master = Uint8Array.from({ length: 32 }, (_v, i) => (i * 53 + 7) & 0xff);
const aliasKey = Uint8Array.from({ length: 32 }, (_v, i) => (i * 17 + 1) & 0xff);

test('shadow thread id is symmetric across both peers (§9.4)', async () => {
  const ab = await deriveShadowThreadId(master, 'alice', 'bob');
  const ba = await deriveShadowThreadId(master, 'bob', 'alice');
  assert.equal(ab, ba);
  assert.match(ab, /^[0-9a-f]{64}$/);
});

test('shadow thread id changes with the master secret and with the user pair', async () => {
  const other = Uint8Array.from({ length: 32 }, (_v, i) => (i * 99 + 2) & 0xff);
  assert.notEqual(await deriveShadowThreadId(master, 'alice', 'bob'), await deriveShadowThreadId(other, 'alice', 'bob'));
  assert.notEqual(await deriveShadowThreadId(master, 'alice', 'bob'), await deriveShadowThreadId(master, 'alice', 'carol'));
});

test('canonicalSortUids cannot collide distinct pairs by concatenation', () => {
  assert.notEqual(canonicalSortUids('a', 'bc'), canonicalSortUids('ab', 'c'));
});

test('an empty master secret is rejected', async () => {
  await assert.rejects(() => deriveShadowThreadId(new Uint8Array(0), 'a', 'b'), /non-empty/);
});

test('an empty or missing uid is rejected (refined §9.4 / Req 2.5)', async () => {
  // An empty uid never addressed a usable two-party thread, so derivation fails closed on it,
  // in either argument position.
  await assert.rejects(() => deriveShadowThreadId(master, '', 'bob'), /non-empty/);
  await assert.rejects(() => deriveShadowThreadId(master, 'alice', ''), /non-empty/);
  await assert.rejects(() => deriveShadowThreadId(master, '', ''), /non-empty/);
});

test('two identical uids are rejected — a shadow chat is with a different contact (Req 2.5)', async () => {
  await assert.rejects(() => deriveShadowThreadId(master, 'alice', 'alice'), /distinct/);
});

/**
 * Alias-discriminated derivation (full-vision evolution; design Component 1, Req 1.7, 2.7–2.12).
 * The expected ids below are computed INDEPENDENTLY with Node's `createHmac`, so they pin the exact
 * HMAC inputs: the legacy input `canonicalSortUids(a,b) + "shadow"` and the discriminated input
 * `canonicalSortUids(a,b) + "shadow" + 0x1f + normalizeAlias(alias)`.
 */
const US = '\u001f';

/** Reference HMAC-SHA256 hex over a UTF-8 string, using the same key bytes the SUT uses. */
function refThreadId(key: Uint8Array, data: string): string {
  return createHmac('sha256', Buffer.from(key)).update(Buffer.from(data, 'utf8')).digest('hex');
}

test('discriminated id equals the expected HMAC over `…"shadow" + 0x1f + alias` (Req 2.7)', async () => {
  const expected = refThreadId(master, `${canonicalSortUids('alice', 'bob')}shadow${US}/work`);
  const actual = await deriveShadowThreadId(master, 'alice', 'bob', '/Work'); // case-insensitive normalise
  assert.equal(actual, expected);
  assert.match(actual, /^[0-9a-f]{64}$/);
});

test('omitted/empty alias reproduces the byte-for-byte legacy id constant (Req 2.9)', async () => {
  const legacyConstant = refThreadId(master, `${canonicalSortUids('alice', 'bob')}shadow`);
  assert.equal(await deriveShadowThreadId(master, 'alice', 'bob'), legacyConstant);
  assert.equal(await deriveShadowThreadId(master, 'alice', 'bob', undefined), legacyConstant);
  assert.equal(await deriveShadowThreadId(master, 'alice', 'bob', ''), legacyConstant);
});

test('a discriminated id is never equal to the legacy id (disjoint id-spaces, Req 2.10)', async () => {
  const legacy = await deriveShadowThreadId(master, 'alice', 'bob');
  const discriminated = await deriveShadowThreadId(master, 'alice', 'bob', '/work');
  assert.notEqual(discriminated, legacy);
});

test('distinct aliases for the same pair yield distinct ids (Req 2.8)', async () => {
  assert.notEqual(
    await deriveShadowThreadId(master, 'alice', 'bob', '/work'),
    await deriveShadowThreadId(master, 'alice', 'bob', '/journal'),
  );
});

test('discriminated derivation is symmetric and deterministic with the alias present (Req 2.11)', async () => {
  const ab1 = await deriveShadowThreadId(master, 'alice', 'bob', '/notes');
  const ab2 = await deriveShadowThreadId(master, 'alice', 'bob', '/notes');
  const ba = await deriveShadowThreadId(master, 'bob', 'alice', '/notes');
  assert.equal(ab1, ab2);
  assert.equal(ab1, ba);
});

test('an invalid alias discriminator is rejected (Req 2.12)', async () => {
  await assert.rejects(() => deriveShadowThreadId(master, 'alice', 'bob', '/two words'), /not a grammatically valid alias/);
  await assert.rejects(() => deriveShadowThreadId(master, 'alice', 'bob', '/has-dash'), /not a grammatically valid alias/);
  await assert.rejects(() => deriveShadowThreadId(master, 'alice', 'bob', 'nodash'), /not a grammatically valid alias/);
});

test('isAliasInput detects the `/` prefix (interception trigger, §9.3)', () => {
  assert.equal(isAliasInput('/private'), true);
  assert.equal(isAliasInput('  /work'), true);
  assert.equal(isAliasInput('hello'), false);
});

test('normalizeAlias enforces the grammar and is case-insensitive (§9.3)', () => {
  assert.equal(normalizeAlias('/Private'), '/private');
  assert.equal(normalizeAlias('  /Work  '), '/work');
  assert.equal(normalizeAlias('/notes2'), '/notes2');
  // Invalid: no slash, empty body, spaces, punctuation.
  assert.equal(normalizeAlias('private'), null);
  assert.equal(normalizeAlias('/'), null);
  assert.equal(normalizeAlias('/two words'), null);
  assert.equal(normalizeAlias('/has-dash'), null);
});

test('hashAlias is case-insensitive, deterministic, and never the plaintext (§9.3)', async () => {
  const a = await hashAlias('/Private', aliasKey);
  const b = await hashAlias('/private', aliasKey);
  assert.equal(a, b);
  assert.match(a ?? '', /^[0-9a-f]{64}$/);
  assert.ok(!(a ?? '').includes('private'));
  assert.equal(await hashAlias('not-an-alias', aliasKey), null);
});

test('hashAlias differs under a different key', async () => {
  const other = Uint8Array.from({ length: 32 }, (_v, i) => (i + 200) & 0xff);
  assert.notEqual(await hashAlias('/private', aliasKey), await hashAlias('/private', other));
});

test('matchAlias opens the right shadow chat; wrong/non-existent alias is indistinguishable (§9.3)', async () => {
  const entries = [
    { aliasHash: (await hashAlias('/journal', aliasKey)) as string, ref: 'contactA' },
    { aliasHash: (await hashAlias('/work', aliasKey)) as string, ref: 'contactB' },
  ];
  assert.equal(await matchAlias('/journal', entries, aliasKey), 'contactA');
  assert.equal(await matchAlias('/Work', entries, aliasKey), 'contactB'); // case-insensitive
  // A wrong alias and a never-configured alias both return null — no confirmation either exists.
  assert.equal(await matchAlias('/private', entries, aliasKey), null);
  assert.equal(await matchAlias('not an alias', entries, aliasKey), null);
});

test('knowing one alias reveals nothing about others (independent hashes)', async () => {
  const j = await hashAlias('/journal', aliasKey);
  const w = await hashAlias('/work', aliasKey);
  assert.notEqual(j, w);
});
