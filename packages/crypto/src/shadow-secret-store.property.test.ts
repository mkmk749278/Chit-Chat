import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import { getPbkdf2Provider, verifySecret, type Pbkdf2Provider } from './secret-hash';
import { hashAlias, matchAlias, normalizeAlias, type AliasEntry } from './shadow-chat';
import {
  ShadowSecretStore,
  type InvitedThreadRef,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from './shadow-secret-store';

/**
 * Property tests for the {@link ShadowSecretStore} (Shadow Chat, design Component 6; tasks 7.3, 12.3).
 *
 * Feature: shadow-chat.
 *
 * Validates design **Correctness Property 10 (decoy mode reveals nothing)**: for ANY stored state
 * (arbitrary master secret, alias key, and alias-entry set) and ANY mode that is `decoy` or `null`,
 * `getShadowContext` returns `null` and `listAliasEntries` returns `[]`, so no thread id can be
 * derived and no alias resolves — and the decoy and null modes are observationally identical to each
 * other (Requirements 8.2, 8.3, 8.6).
 *
 * Also validates design **Correctness Property 12 (durable persistence round-trip)**: for arbitrary
 * master secret, alias key, and a bound `AliasEntry` set (refs including an optional `pinVerifier`),
 * persisting them through a DURABLE `ShadowSecretPersistence` in `real` mode and then constructing a
 * FRESH `ShadowSecretStore` over the SAME durable persistence (a simulated restart) recovers
 * identical secrets and the identical entry set including each `pinVerifier`, and an alias that
 * resolved before the simulated restart still resolves to the identical ref afterwards (Requirements
 * 9.8, 9.9). A complementary check exercises the fail-closed write path: a failing `saveAliasEntry`
 * aborts the write (propagates) leaving nothing persisted (Requirement 9.7).
 *
 * Every property runs >=100 randomised iterations and reports fast-check's counterexample on failure.
 */

/**
 * A {@link ShadowThreadRef} widened with the optional per-chat PIN verifier. The shipped
 * `ShadowThreadRef` type does not yet declare `pinVerifier` (it is added by a later core task), so —
 * exactly as the web adapter test does — we attach it via a local typed widening to prove the store
 * round-trips the full entry shape the design specifies (Requirement 9.9).
 */
type RefWithPin = ShadowThreadRef & { pinVerifier?: string };

/** A non-real mode: the store must reveal nothing in either of these. */
const nonRealModeArb: fc.Arbitrary<'decoy' | null> = fc.constantFrom('decoy' as const, null);

/** Arbitrary non-empty secret bytes (master secret / alias key). */
const secretArb = fc.uint8Array({ minLength: 1, maxLength: 64 });

/** Arbitrary opaque alias entries (hash + ref); the contents are irrelevant to Property 10. */
const entriesArb: fc.Arbitrary<AliasEntry<ShadowThreadRef>[]> = fc.array(
  fc.record({
    aliasHash: fc.hexaString({ minLength: 64, maxLength: 64 }),
    ref: fc.record({ peerUid: fc.string({ minLength: 1 }), threadId: fc.hexaString({ minLength: 64, maxLength: 64 }) }),
  }),
  { maxLength: 16 },
);

/** Build a fully-provisioned in-memory persistence from arbitrary state. */
function persistenceOf(
  master: Uint8Array,
  aliasKey: Uint8Array,
  entries: ReadonlyArray<AliasEntry<ShadowThreadRef>>,
): ShadowSecretPersistence {
  return {
    async loadMasterSecret() {
      return master;
    },
    async saveMasterSecret() {},
    async loadAliasKey() {
      return aliasKey;
    },
    async saveAliasKey() {},
    async loadAliasEntries() {
      return entries.slice();
    },
    async saveAliasEntry() {},
    async saveInvitedThread() {},
    async loadInvitedThreads() {
      return [];
    },
    async deleteInvitedThread() {},
  };
}

test('Property 10: decoy/null mode releases no context and no entries, for any stored state', async () => {
  // Feature: shadow-chat, Correctness Property 10 (decoy reveals nothing).
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, entriesArb, nonRealModeArb, async (master, aliasKey, entries, mode) => {
      const store = new ShadowSecretStore(persistenceOf(master, aliasKey, entries));
      assert.equal(await store.getShadowContext(mode), null, 'non-real mode must release no context');
      assert.deepEqual(await store.listAliasEntries(mode), [], 'non-real mode must release no entries');
    }),
    { numRuns: 200 },
  );
});

test('Property 10: decoy and null are observationally identical, for any stored state', async () => {
  // Feature: shadow-chat, Correctness Property 10 (decoy and null indistinguishable).
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, entriesArb, async (master, aliasKey, entries) => {
      const store = new ShadowSecretStore(persistenceOf(master, aliasKey, entries));
      const decoyCtx = await store.getShadowContext('decoy');
      const nullCtx = await store.getShadowContext(null);
      const decoyEntries = await store.listAliasEntries('decoy');
      const nullEntries = await store.listAliasEntries(null);
      assert.equal(decoyCtx, nullCtx, 'context must be identical (both null) across decoy and null');
      assert.deepEqual(decoyEntries, nullEntries, 'entries must be identical (both []) across decoy and null');
    }),
    { numRuns: 200 },
  );
});

// ---------------------------------------------------------------------------
// Property 12 — durable persistence round-trip (Requirements 9.8, 9.9, 9.7).
// ---------------------------------------------------------------------------

/**
 * A DURABLE fake {@link ShadowSecretPersistence}. Unlike `persistenceOf` above (which fabricates a
 * fresh closure per construction), this keeps a single mutable backing store so that a FRESH
 * {@link ShadowSecretStore} constructed over the SAME instance observes everything previously
 * persisted — exactly the "survives a restart" semantics of the on-device encrypted vault. Entries
 * are upserted by their opaque `aliasHash` (re-binding replaces, never duplicates) and copied on the
 * way in and out, so the durable medium is the only shared state. `failSaves`, when set, makes
 * `saveAliasEntry` throw BEFORE mutating, modelling an atomic write that aborts with nothing partial
 * persisted (Requirement 9.7).
 */
interface DurableFake extends ShadowSecretPersistence {
  failSaves: boolean;
  storedCount(): number;
}

function durableFake(): DurableFake {
  let master: Uint8Array | null = null;
  let aliasKey: Uint8Array | null = null;
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const invited: InvitedThreadRef[] = [];
  const cloneRef = (ref: ShadowThreadRef): ShadowThreadRef => ({ ...(ref as RefWithPin) });
  return {
    failSaves: false,
    storedCount() {
      return entries.length;
    },
    async loadMasterSecret() {
      return master === null ? null : master.slice();
    },
    async saveMasterSecret(value) {
      master = value.slice();
    },
    async loadAliasKey() {
      return aliasKey === null ? null : aliasKey.slice();
    },
    async saveAliasKey(value) {
      aliasKey = value.slice();
    },
    async loadAliasEntries() {
      return entries.map((e) => ({ aliasHash: e.aliasHash, ref: cloneRef(e.ref) }));
    },
    async saveAliasEntry(entry) {
      // Consider failure BEFORE mutating so an aborted write leaves nothing partial persisted.
      if (this.failSaves) {
        throw new Error('durable-fake: saveAliasEntry failed mid-write');
      }
      const next = { aliasHash: entry.aliasHash, ref: cloneRef(entry.ref) };
      const at = entries.findIndex((e) => e.aliasHash === entry.aliasHash);
      if (at >= 0) {
        entries[at] = next;
      } else {
        entries.push(next);
      }
    },
    async saveInvitedThread(record) {
      // Atomic abort BEFORE mutating, mirroring saveAliasEntry's fail-closed contract.
      if (this.failSaves) {
        throw new Error('durable-fake: saveInvitedThread failed mid-write');
      }
      const copy: InvitedThreadRef = { ...record, threadKey: record.threadKey.slice() };
      const at = invited.findIndex((r) => r.threadId === record.threadId);
      if (at >= 0) {
        invited[at] = copy;
      } else {
        invited.push(copy);
      }
    },
    async loadInvitedThreads() {
      return invited.map((r) => ({ ...r, threadKey: r.threadKey.slice() }));
    },
    async deleteInvitedThread(threadId) {
      if (this.failSaves) {
        throw new Error('durable-fake: deleteInvitedThread failed mid-write');
      }
      const at = invited.findIndex((r) => r.threadId === threadId);
      if (at >= 0) {
        invited.splice(at, 1);
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].ref.threadId === threadId) {
          entries.splice(i, 1);
        }
      }
    },
  };
}

/** Arbitrary grammatically-valid normalised alias body (`/[a-z0-9]+`). */
const aliasArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 1, maxLength: 12 })
  .map((chars) => `/${chars.join('')}`);

/** Arbitrary alias spec: a distinct alias plus its ref (optionally carrying a pinVerifier). */
const aliasSpecsArb = fc.uniqueArray(
  fc.record({
    alias: aliasArb,
    peerUid: fc.string({ minLength: 1, maxLength: 16 }),
    threadId: fc.hexaString({ minLength: 64, maxLength: 64 }),
    pinVerifier: fc.option(fc.string({ minLength: 1, maxLength: 24 }), { nil: undefined }),
  }),
  // Distinct normalised aliases ⇒ distinct alias hashes ⇒ no upsert collisions in the entry set.
  { selector: (spec) => normalizeAlias(spec.alias), maxLength: 12 },
);

test('Property 12: durable round-trip recovers identical secrets + entries (incl. pinVerifier) after a simulated restart', async () => {
  // Feature: shadow-chat, Correctness Property 12 (durable persistence round-trip), Req 9.8, 9.9.
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, aliasSpecsArb, async (master, aliasKey, specs) => {
      const durable = durableFake();

      // --- Provision through a real-mode store/session, persisting hash-only alias entries. ---
      await durable.saveMasterSecret(master);
      await durable.saveAliasKey(aliasKey);
      const built: Array<{ alias: string; aliasHash: string; ref: RefWithPin }> = [];
      for (const spec of specs) {
        // aliasKey is non-empty and the alias is grammatically valid ⇒ hashAlias never returns null.
        const aliasHash = (await hashAlias(spec.alias, aliasKey)) as string;
        const ref: RefWithPin = { peerUid: spec.peerUid, threadId: spec.threadId };
        if (spec.pinVerifier !== undefined) {
          ref.pinVerifier = spec.pinVerifier;
        }
        await durable.saveAliasEntry({ aliasHash, ref });
        built.push({ alias: spec.alias, aliasHash, ref });
      }

      // --- Resolve an alias BEFORE the simulated restart. ---
      const before = new ShadowSecretStore(durable);
      const ctxBefore = await before.getShadowContext('real');
      assert.ok(ctxBefore, 'real mode must release the context');
      const entriesBefore = await before.listAliasEntries('real');
      const target = built.length > 0 ? built[0] : null;
      const resolvedBefore =
        target === null ? null : await matchAlias(target.alias, entriesBefore, ctxBefore.aliasKey);
      if (target !== null) {
        assert.deepEqual(resolvedBefore, target.ref, 'the alias must resolve before the restart');
      }

      // --- Simulate a restart: a FRESH store over the SAME durable persistence. ---
      const fresh = new ShadowSecretStore(durable);
      const ctxAfter = await fresh.getShadowContext('real');
      assert.ok(ctxAfter, 'a fresh store must recover the context from durable state');
      assert.deepEqual(ctxAfter.masterSecret, master, 'master secret must survive the restart');
      assert.deepEqual(ctxAfter.aliasKey, aliasKey, 'alias key must survive the restart');

      const entriesAfter = await fresh.listAliasEntries('real');
      assert.equal(entriesAfter.length, built.length, 'the entry set size must survive the restart');
      for (const b of built) {
        const found = entriesAfter.find((e) => e.aliasHash === b.aliasHash);
        assert.ok(found, `entry ${b.aliasHash} must survive the restart`);
        // The whole ref — including any optional pinVerifier — must round-trip byte-for-byte.
        assert.deepEqual(found.ref as RefWithPin, b.ref, 'the ref incl. pinVerifier must survive the restart');
      }

      // --- The alias that resolved before the restart still resolves to the identical ref. ---
      if (target !== null) {
        const resolvedAfter = await matchAlias(target.alias, entriesAfter, ctxAfter.aliasKey);
        assert.deepEqual(resolvedAfter, target.ref, 'the alias must still resolve after the restart');
        assert.deepEqual(resolvedAfter, resolvedBefore, 'resolution must be identical across the restart');
      }
    }),
    { numRuns: 150 },
  );
});

test('Property 12 (fail-closed write): a failing saveAliasEntry aborts the bind, leaving nothing persisted (Req 9.7)', async () => {
  // Feature: shadow-chat, Requirement 9.7 — a failed shadow write aborts with nothing partial persisted.
  await fc.assert(
    fc.asyncProperty(secretArb, aliasArb, fc.string({ minLength: 1, maxLength: 16 }), async (aliasKey, alias, peerUid) => {
      const durable = durableFake();
      durable.failSaves = true;
      const store = new ShadowSecretStore(durable);
      const aliasHash = (await hashAlias(alias, aliasKey)) as string;
      const ref: ShadowThreadRef = { peerUid, threadId: 'a'.repeat(64) };

      await assert.rejects(() => store.putAlias({ aliasHash, ref }), /saveAliasEntry failed/);
      assert.equal(durable.storedCount(), 0, 'a failed write must leave nothing partial persisted');
    }),
    { numRuns: 100 },
  );
});


// ---------------------------------------------------------------------------
// Property 11 — per-chat PIN gating, incl. later set/change/remove (Req 11.6, 12.5–12.8, 9.2).
// ---------------------------------------------------------------------------

/**
 * A counting {@link Pbkdf2Provider} that delegates to the process-wide provider currently installed
 * (the real WebCrypto/native PBKDF2) so the verifiers it produces verify unchanged via
 * `verifySecret`, while recording every `deriveBits` call. Injecting it through
 * `ShadowSecretStoreOptions.pbkdf2Provider` lets a test assert that per-chat PIN hashing genuinely
 * routes through the off-UI-thread seam (design "Optional per-chat PIN" — Req 11.6, 12.5).
 */
function countingProvider(): { provider: Pbkdf2Provider; calls: () => number } {
  const base = getPbkdf2Provider();
  let count = 0;
  return {
    provider: {
      async deriveBits(password, salt, iterations, keyLenBytes) {
        count += 1;
        return base.deriveBits(password, salt, iterations, keyLenBytes);
      },
    },
    calls: () => count,
  };
}

type RefMaybePin = ShadowThreadRef & { pinVerifier?: string };

/**
 * Model the re-entry gating of a shadow thread (design Property 11): an absent `pinVerifier` opens
 * with no PIN; a present one opens IFF `verifySecret(pin, verifier)` is true (a `null` candidate PIN
 * never opens a PIN-gated thread).
 */
async function gateOpens(ref: RefMaybePin, candidate: string | null): Promise<boolean> {
  if (ref.pinVerifier === undefined) {
    return true;
  }
  if (candidate === null) {
    return false;
  }
  return verifySecret(candidate, ref.pinVerifier);
}

/** Two distinct non-empty uids. */
const uidPairArb = fc
  .tuple(fc.string({ minLength: 1, maxLength: 12 }), fc.string({ minLength: 1, maxLength: 12 }))
  .filter(([a, b]) => a !== b);

/** A non-empty per-chat PIN drawn from a stable alphabet (so the no-plaintext check is exact). */
const pinArb = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 4, maxLength: 10 })
  .map((chars) => chars.join(''));

test('Property 11: per-chat PIN gating — absent opens freely; set/change requires PIN; remove reopens; hash-only via injected provider', async () => {
  // Feature: shadow-chat, Correctness Property 11 (per-chat PIN gating incl. later set/change/remove).
  await fc.assert(
    fc.asyncProperty(
      secretArb,
      secretArb,
      aliasArb,
      uidPairArb,
      pinArb,
      async (master, aliasKey, alias, [myUid, peerUid], pin) => {
        const durable = durableFake();
        await durable.saveMasterSecret(master);
        await durable.saveAliasKey(aliasKey);
        const counter = countingProvider();
        const store = new ShadowSecretStore(durable, { pbkdf2Provider: counter.provider });

        // --- Bind with NO PIN: pinVerifier absent ⇒ opens without a PIN; provider untouched. ---
        const bound = (await store.bindAlias('real', alias, peerUid, myUid)) as RefMaybePin | null;
        assert.ok(bound, 'real-mode bind must return a ref');
        assert.equal(bound.pinVerifier, undefined, 'a no-PIN bind leaves the chat unlocked');
        assert.equal(await gateOpens(bound, null), true, 'absent verifier ⇒ opens with no PIN');
        assert.equal(counter.calls(), 0, 'no PIN hashing happens for a no-PIN bind');
        const { threadId } = bound;

        // --- setThreadPin sets a PIN: now PIN-gated; hashing went through the injected provider. ---
        const set = (await store.setThreadPin('real', threadId, pin)) as RefMaybePin | null;
        assert.ok(set, 'setting a PIN on a bound thread returns the updated ref');
        assert.match(set.pinVerifier ?? '', /^pbkdf2\$sha256\$/, 'only a PBKDF2 verifier is stored');
        assert.equal(counter.calls(), 1, 'PIN hashing routes through the injected off-thread provider');

        // Re-read persisted state: present verifier ⇒ opens IFF verifySecret(pin, verifier).
        const afterSet = (await store.listAliasEntries('real')).find((e) => e.ref.threadId === threadId);
        assert.ok(afterSet, 'the gated entry must be persisted');
        assert.equal(await gateOpens(afterSet.ref, pin), true, 'correct PIN opens the gated thread');
        assert.equal(await gateOpens(afterSet.ref, `${pin}x`), false, 'a wrong PIN never opens');
        assert.equal(await gateOpens(afterSet.ref, null), false, 'no PIN never opens a gated thread');

        // The plaintext PIN must appear nowhere in the persisted representation (hash-only, Req 9.2).
        const dump = JSON.stringify(await durable.loadAliasEntries());
        assert.ok(!dump.includes(pin), 'the plaintext PIN must never be persisted');

        // --- Non-real setThreadPin is a no-op: returns null, persists nothing, verifier unchanged. ---
        const dumpBefore = JSON.stringify(await durable.loadAliasEntries());
        for (const mode of ['decoy', null] as const) {
          assert.equal(await store.setThreadPin(mode, threadId, `${pin}z`), null, `setThreadPin no-op in ${mode}`);
        }
        assert.equal(JSON.stringify(await durable.loadAliasEntries()), dumpBefore, 'non-real setThreadPin changes nothing');

        // --- setThreadPin(null) removes the PIN: verifier cleared ⇒ opens directly again. ---
        const removed = (await store.setThreadPin('real', threadId, null)) as RefMaybePin | null;
        assert.ok(removed, 'removing a PIN returns the updated ref');
        assert.equal(removed.pinVerifier, undefined, 'a null newPin clears the verifier');
        const afterRemove = (await store.listAliasEntries('real')).find((e) => e.ref.threadId === threadId);
        assert.ok(afterRemove);
        assert.equal(await gateOpens(afterRemove.ref, null), true, 'a removed PIN reopens the thread directly');
      },
    ),
    { numRuns: 100 },
  );
});

test('Property 11: a PIN set at creation is stored hash-only and gates re-entry', async () => {
  // Feature: shadow-chat, Correctness Property 11 (creation-time PIN, hash-only).
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, aliasArb, uidPairArb, pinArb, async (master, aliasKey, alias, [myUid, peerUid], pin) => {
      const durable = durableFake();
      await durable.saveMasterSecret(master);
      await durable.saveAliasKey(aliasKey);
      const counter = countingProvider();
      const store = new ShadowSecretStore(durable, { pbkdf2Provider: counter.provider });

      const bound = (await store.bindAlias('real', alias, peerUid, myUid, pin)) as RefMaybePin | null;
      assert.ok(bound, 'creation-time bind with a PIN returns a ref');
      assert.match(bound.pinVerifier ?? '', /^pbkdf2\$sha256\$/, 'creation-time PIN is stored as a PBKDF2 verifier');
      assert.equal(counter.calls(), 1, 'creation-time PIN hashing routes through the injected provider');
      assert.equal(await gateOpens(bound, pin), true, 'the creation-time PIN opens the thread');
      assert.equal(await gateOpens(bound, `${pin}x`), false, 'a wrong PIN never opens');
      const dump = JSON.stringify(await durable.loadAliasEntries());
      assert.ok(!dump.includes(pin), 'the plaintext creation-time PIN must never be persisted');
    }),
    { numRuns: 100 },
  );
});

// ---------------------------------------------------------------------------
// Property 13 — creation / PIN-control inertness under decoy/locked (Req 8.1, 8.6, 12.8).
// ---------------------------------------------------------------------------

test('Property 13: in non-real mode bindAlias AND setThreadPin are inert (return null, persist nothing); decoy ≡ null', async () => {
  // Feature: shadow-chat, Correctness Property 13 (creation/PIN-control inertness under decoy/locked).
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, aliasArb, aliasArb, uidPairArb, pinArb, async (master, aliasKey, aliasA, aliasB, [myUid, peerUid], pin) => {
      const durable = durableFake();
      await durable.saveMasterSecret(master);
      await durable.saveAliasKey(aliasKey);
      const store = new ShadowSecretStore(durable);

      // Seed one real-mode binding so there IS a threadId for setThreadPin to (not) touch.
      const seeded = await store.bindAlias('real', aliasA, peerUid, myUid);
      assert.ok(seeded);
      const countBefore = durable.storedCount();
      const dumpBefore = JSON.stringify(await durable.loadAliasEntries());

      const results: Array<unknown> = [];
      for (const mode of ['decoy', null] as const) {
        // bindAlias is inert: returns null and persists nothing.
        const bindResult = await store.bindAlias(mode, aliasB, peerUid, myUid, pin);
        assert.equal(bindResult, null, `bindAlias must return null in ${mode}`);
        // setThreadPin is inert: returns null and persists nothing.
        const pinResult = await store.setThreadPin(mode, seeded.threadId, pin);
        assert.equal(pinResult, null, `setThreadPin must return null in ${mode}`);
        results.push(bindResult, pinResult);
        assert.equal(durable.storedCount(), countBefore, `${mode} must persist nothing`);
        assert.equal(JSON.stringify(await durable.loadAliasEntries()), dumpBefore, `${mode} must change no stored entry`);
      }
      // decoy and null are observationally identical (both inert, both null).
      assert.deepEqual(results, [null, null, null, null], 'decoy and null are indistinguishable');
    }),
    { numRuns: 100 },
  );
});

// ---------------------------------------------------------------------------
// Property 9 (new code path) — alias plaintext never persisted via alias-discriminated bindAlias.
// ---------------------------------------------------------------------------

/** A valid alias body guaranteed to contain a non-hex letter (so it cannot coincide with hex). */
const nonHexAliasArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { maxLength: 6 }),
    fc.constantFrom(...'ghijklmnopqrstuvwxyz'.split('')),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { maxLength: 6 }),
  )
  .map(([a, g, b]) => `/${a.join('')}${g}${b.join('')}`);

test('Property 9: alias-discriminated bindAlias persists only the HMAC hash — no plaintext alias anywhere', async () => {
  // Feature: shadow-chat, Correctness Property 9 (alias plaintext is never persisted), new bind path.
  await fc.assert(
    fc.asyncProperty(secretArb, secretArb, nonHexAliasArb, uidPairArb, async (master, aliasKey, alias, [myUid, peerUid]) => {
      const durable = durableFake();
      await durable.saveMasterSecret(master);
      await durable.saveAliasKey(aliasKey);
      const store = new ShadowSecretStore(durable);

      const ref = await store.bindAlias('real', alias, peerUid, myUid);
      assert.ok(ref, 'real-mode bind must return a ref');

      const entries = await durable.loadAliasEntries();
      assert.equal(entries.length, 1, 'exactly one hash-only entry is stored');
      const expectedHash = (await hashAlias(alias, aliasKey)) as string;
      assert.equal(entries[0]?.aliasHash, expectedHash, 'only the HMAC alias hash is stored');
      // The stored entry shape is exactly the opaque hash + ref — no plaintext-alias field.
      assert.deepEqual(Object.keys(entries[0] ?? {}).sort(), ['aliasHash', 'ref']);
      assert.deepEqual(Object.keys(entries[0]?.ref ?? {}).sort(), ['peerUid', 'threadId']);

      // The only alias-derived persisted fields are the HMAC `aliasHash` and the alias-discriminated
      // `threadId` (both lowercase hex). The body carries a non-hex letter, so if the plaintext alias
      // had leaked into either it would show up here; an opaque hash can never contain it.
      const aliasDerived = `${entries[0]?.aliasHash}${entries[0]?.ref.threadId}`.toLowerCase();
      const normalizedBody = (normalizeAlias(alias) as string).slice(1);
      assert.ok(!aliasDerived.includes(normalizedBody), 'normalised alias body must never be persisted');
      assert.ok(!aliasDerived.includes(alias.toLowerCase()), 'plaintext alias must never be persisted');
    }),
    { numRuns: 100 },
  );
});
