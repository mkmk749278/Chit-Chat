import assert from 'node:assert/strict';
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
