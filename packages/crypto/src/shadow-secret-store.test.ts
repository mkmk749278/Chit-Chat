import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AliasEntry } from './shadow-chat';
import { deriveShadowThreadId, hashAlias } from './shadow-chat';
import {
  ShadowSecretStore,
  type InvitedThreadRef,
  type ShadowSecretOperation,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from './shadow-secret-store';

/**
 * Unit tests for the {@link ShadowSecretStore} (Shadow Chat, design Component 6; task 7.2).
 *
 * Covers: real-mode release of context + alias entries; decoy AND null modes return `null` / `[]`;
 * hash-only persistence (no plaintext/normalised alias anywhere in the backing store after a bind);
 * fail-closed reads on a persistence error in real mode (`getShadowContext` → `null`,
 * `listAliasEntries` → `[]`, with the error surfaced out-of-band); and fail-closed writes
 * (`bindAlias` / `putAlias` abort with nothing partial persisted) (Requirements 8.2, 8.3, 8.5, 8.7,
 * 9.1, 9.2, 9.4, 9.6, 9.7).
 */

const MASTER = Uint8Array.from({ length: 32 }, (_v, i) => (i * 53 + 7) & 0xff);
const ALIAS_KEY = Uint8Array.from({ length: 32 }, (_v, i) => (i * 17 + 1) & 0xff);

/**
 * An in-memory {@link ShadowSecretPersistence} fake. `saveAliasEntry` is atomic — it appends only
 * after the (optional) injected failure has been considered, so a thrown write leaves the entry set
 * untouched. `failOn` lets a test make a chosen operation throw to exercise the fail-closed paths.
 * `serialize()` returns a single string capturing EVERY stored byte/string so a test can assert no
 * plaintext alias leaked into any structure.
 */
interface FakePersistence extends ShadowSecretPersistence {
  entries: AliasEntry<ShadowThreadRef>[];
  invited: InvitedThreadRef[];
  failOn: Set<keyof ShadowSecretPersistence>;
  serialize(): string;
}

function fakePersistence(opts: { master?: Uint8Array | null; aliasKey?: Uint8Array | null } = {}): FakePersistence {
  const master = opts.master === undefined ? MASTER : opts.master;
  const aliasKey = opts.aliasKey === undefined ? ALIAS_KEY : opts.aliasKey;
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const invited: InvitedThreadRef[] = [];
  const failOn = new Set<keyof ShadowSecretPersistence>();
  const guard = (op: keyof ShadowSecretPersistence): void => {
    if (failOn.has(op)) {
      throw new Error(`fake-persistence: ${op} failed`);
    }
  };
  return {
    entries,
    invited,
    failOn,
    async loadMasterSecret() {
      guard('loadMasterSecret');
      return master;
    },
    async saveMasterSecret() {
      guard('saveMasterSecret');
    },
    async loadAliasKey() {
      guard('loadAliasKey');
      return aliasKey;
    },
    async saveAliasKey() {
      guard('saveAliasKey');
    },
    async loadAliasEntries() {
      guard('loadAliasEntries');
      return entries.slice();
    },
    async saveAliasEntry(entry) {
      // Consider failure BEFORE mutating, so an aborted write leaves nothing partial persisted.
      guard('saveAliasEntry');
      entries.push(entry);
    },
    async saveInvitedThread(record) {
      // Atomic upsert by threadId: consider failure BEFORE mutating (nothing partial on abort).
      guard('saveInvitedThread');
      const at = invited.findIndex((r) => r.threadId === record.threadId);
      if (at >= 0) {
        invited[at] = record;
      } else {
        invited.push(record);
      }
    },
    async loadInvitedThreads() {
      guard('loadInvitedThreads');
      return invited.slice();
    },
    async deleteInvitedThread(threadId) {
      // Atomic all-or-nothing delete: consider failure BEFORE mutating ANYTHING, so an aborted delete
      // leaves the record + key + alias entry all intact (no keyless-record strand). Removes the
      // record AND any AliasEntry pointing at threadId in one write.
      guard('deleteInvitedThread');
      const recAt = invited.findIndex((r) => r.threadId === threadId);
      if (recAt >= 0) {
        invited.splice(recAt, 1);
      }
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]?.ref.threadId === threadId) {
          entries.splice(i, 1);
        }
      }
    },
    serialize() {
      return JSON.stringify({
        master: master ? Array.from(master) : null,
        aliasKey: aliasKey ? Array.from(aliasKey) : null,
        entries,
        invited: invited.map((r) => ({ ...r, threadKey: Array.from(r.threadKey) })),
      });
    },
  };
}

/** A deterministic, valid 32-byte shared thread key for invited-thread tests. */
const THREAD_KEY = Uint8Array.from({ length: 32 }, (_v, i) => (i * 31 + 5) & 0xff);

test('real mode releases the shadow context (masterSecret + aliasKey)', async () => {
  const store = new ShadowSecretStore(fakePersistence());
  const ctx = await store.getShadowContext('real');
  assert.ok(ctx, 'expected a context in real mode');
  assert.deepEqual(ctx?.masterSecret, MASTER);
  assert.deepEqual(ctx?.aliasKey, ALIAS_KEY);
});

test('real mode releases the stored alias entries', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const ref = await store.bindAlias('real', '/journal', 'bob', 'alice');
  assert.ok(ref);
  const entries = await store.listAliasEntries('real');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.ref.peerUid, 'bob');
  assert.equal(entries[0]?.ref.threadId, ref?.threadId);
});

test('decoy AND null modes return no context and no entries (observationally identical)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  // Seed an entry so there IS data to (not) reveal.
  await store.bindAlias('real', '/journal', 'bob', 'alice');

  for (const mode of ['decoy', null] as const) {
    assert.equal(await store.getShadowContext(mode), null, `getShadowContext should be null for ${mode}`);
    assert.deepEqual(await store.listAliasEntries(mode), [], `listAliasEntries should be [] for ${mode}`);
  }
  // bindAlias in a non-real mode resolves to null and persists nothing new.
  const before = persistence.entries.length;
  assert.equal(await store.bindAlias('decoy', '/work', 'carol', 'alice'), null);
  assert.equal(await store.bindAlias(null, '/work', 'carol', 'alice'), null);
  assert.equal(persistence.entries.length, before, 'non-real bindAlias must persist nothing');
});

test('bindAlias stores hash-only — no plaintext/normalised alias appears in the backing store', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);

  const ref = await store.bindAlias('real', '/SecretJournal', 'bob', 'alice');
  assert.ok(ref);

  // The stored entry's hash must equal the HMAC of the normalised alias, and only the hash + ref
  // are present — never the alias text in any form.
  const expectedHash = await hashAlias('/SecretJournal', ALIAS_KEY);
  assert.equal(persistence.entries.length, 1);
  assert.equal(persistence.entries[0]?.aliasHash, expectedHash);
  assert.match(persistence.entries[0]?.aliasHash ?? '', /^[0-9a-f]{64}$/);

  // Inspect EVERY stored byte/string: neither the raw nor the normalised alias may appear anywhere.
  const dump = persistence.serialize().toLowerCase();
  assert.ok(!dump.includes('secretjournal'), 'normalised alias body leaked into the backing store');
  assert.ok(!dump.includes('/secretjournal'), 'plaintext alias leaked into the backing store');

  // The derived threadId is the ALIAS-DISCRIMINATED shadow thread id for the pair: bindAlias now
  // mixes the alias into the derivation (design Component 1), so the expected id includes the alias.
  const expectedThreadId = await deriveShadowThreadId(MASTER, 'alice', 'bob', '/SecretJournal');
  assert.equal(ref?.threadId, expectedThreadId);
});

test('fail-closed: getShadowContext returns null and surfaces the error when persistence throws in real mode', async () => {
  const persistence = fakePersistence();
  const errors: ShadowSecretOperation[] = [];
  const store = new ShadowSecretStore(persistence, {
    onPersistenceError: (op) => errors.push(op),
  });
  persistence.failOn.add('loadMasterSecret');

  const ctx = await store.getShadowContext('real');
  assert.equal(ctx, null, 'must release no context on a persistence error');
  assert.deepEqual(errors, ['getShadowContext'], 'the error must be surfaced out-of-band');
});

test('fail-closed: listAliasEntries returns [] and surfaces the error when persistence throws in real mode', async () => {
  const persistence = fakePersistence();
  const errors: ShadowSecretOperation[] = [];
  const store = new ShadowSecretStore(persistence, {
    onPersistenceError: (op) => errors.push(op),
  });
  persistence.failOn.add('loadAliasEntries');

  const entries = await store.listAliasEntries('real');
  assert.deepEqual(entries, [], 'must release no entries on a persistence error');
  assert.deepEqual(errors, ['listAliasEntries']);
});

test('fail-closed: a half-provisioned store (missing aliasKey) releases no context', async () => {
  const store = new ShadowSecretStore(fakePersistence({ aliasKey: null }));
  assert.equal(await store.getShadowContext('real'), null);
});

test('fail-closed: bindAlias aborts (throws) and persists nothing when the write fails', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  persistence.failOn.add('saveAliasEntry');

  await assert.rejects(() => store.bindAlias('real', '/journal', 'bob', 'alice'), /saveAliasEntry failed/);
  assert.equal(persistence.entries.length, 0, 'a failed write must leave nothing partial persisted');
});

test('fail-closed: bindAlias aborts (throws) when loading the context fails — nothing persisted', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  persistence.failOn.add('loadAliasKey');

  await assert.rejects(() => store.bindAlias('real', '/journal', 'bob', 'alice'), /loadAliasKey failed/);
  assert.equal(persistence.entries.length, 0);
});

test('fail-closed: putAlias aborts (throws) and persists nothing when the write fails', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const aliasHash = (await hashAlias('/journal', ALIAS_KEY)) as string;
  persistence.failOn.add('saveAliasEntry');

  await assert.rejects(
    () => store.putAlias({ aliasHash, ref: { peerUid: 'bob', threadId: 'tid' } }),
    /saveAliasEntry failed/,
  );
  assert.equal(persistence.entries.length, 0);
});

test('putAlias stores only the hash + ref (never a plaintext alias)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const aliasHash = (await hashAlias('/journal', ALIAS_KEY)) as string;

  await store.putAlias({ aliasHash, ref: { peerUid: 'bob', threadId: 'tid-1' } });
  assert.equal(persistence.entries.length, 1);
  assert.deepEqual(persistence.entries[0], { aliasHash, ref: { peerUid: 'bob', threadId: 'tid-1' } });
  const dump = persistence.serialize().toLowerCase();
  assert.ok(!dump.includes('journal'), 'plaintext alias must never be persisted via putAlias');
});

test('bindAlias returns null (binds nothing) in real mode when secrets are not provisioned', async () => {
  const persistence = fakePersistence({ master: null, aliasKey: null });
  const store = new ShadowSecretStore(persistence);
  assert.equal(await store.bindAlias('real', '/journal', 'bob', 'alice'), null);
  assert.equal(persistence.entries.length, 0);
});

// ---------------------------------------------------------------------------
// Shadow Chat Invites — invited-thread binding keyed by the SHARED thread key.
// (design "Component C: ShadowSecretStore"; Requirements 2, 5, 6, 7, 8, 11, 15)
// ---------------------------------------------------------------------------

test('bindInvitedThread: real-mode derives the converged threadId from the shared key (no alias discriminator)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);

  const ref = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    routing: 'hidden',
    inviteId: 'inv-1',
    state: 'awaiting-accept',
  });
  assert.ok(ref, 'real-mode bind must return a ref');
  // Converged derivation: keyed by the SHARED threadKey + UID pair, with NO alias discriminator.
  const expected = await deriveShadowThreadId(THREAD_KEY, 'alice', 'bob');
  assert.equal(ref.threadId, expected);
  assert.deepEqual(ref.threadKey, THREAD_KEY);
  assert.equal(ref.routing, 'hidden');
  assert.equal(ref.state, 'awaiting-accept');
  assert.equal(ref.inviteId, 'inv-1');
  assert.equal(persistence.invited.length, 1);
  assert.equal(persistence.invited[0]?.threadId, expected);
});

test('bindInvitedThread: convergence — (A,B) and (B,A) derive the identical threadId', async () => {
  const store = new ShadowSecretStore(fakePersistence());
  const ab = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    routing: 'hidden',
    inviteId: 'inv-ab',
    state: 'active',
  });
  const ba = await store.bindInvitedThread('real', THREAD_KEY, 'alice', 'bob', {
    routing: 'merge',
    inviteId: 'inv-ba',
    state: 'active',
  });
  assert.ok(ab && ba);
  assert.equal(ab.threadId, ba.threadId, 'both peers converge on the identical threadId');
});

test('bindInvitedThread: returns null and persists nothing in decoy AND null modes', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  for (const mode of ['decoy', null] as const) {
    const ref = await store.bindInvitedThread(mode, THREAD_KEY, 'bob', 'alice', {
      routing: 'hidden',
      inviteId: 'inv',
      state: 'awaiting-accept',
    });
    assert.equal(ref, null, `bindInvitedThread must return null in ${mode}`);
  }
  assert.equal(persistence.invited.length, 0, 'non-real bindInvitedThread must persist nothing');
  assert.equal(persistence.entries.length, 0);
});

test('bindInvitedThread: a non-32-byte key binds nothing (fail-closed, no record)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  for (const len of [0, 16, 31, 33, 64]) {
    const key = Uint8Array.from({ length: len }, () => 1);
    const ref = await store.bindInvitedThread('real', key, 'bob', 'alice', {
      routing: 'hidden',
      inviteId: `inv-${len}`,
      state: 'active',
    });
    assert.equal(ref, null, `a ${len}-byte key must bind nothing`);
  }
  assert.equal(persistence.invited.length, 0, 'a malformed key leaves no record');
});

test('bindInvitedThread: an alias creates a hash-only AliasEntry so /alias re-opens the thread', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);

  const ref = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    alias: '/Rendezvous',
    routing: 'hidden',
    inviteId: 'inv-alias',
    state: 'active',
  });
  assert.ok(ref);
  // Exactly one alias entry, hash-only, pointing at the converged threadId.
  assert.equal(persistence.entries.length, 1);
  const expectedHash = await hashAlias('/Rendezvous', ALIAS_KEY);
  assert.equal(persistence.entries[0]?.aliasHash, expectedHash);
  assert.equal(persistence.entries[0]?.ref.threadId, ref.threadId);
  // The plaintext/normalised alias must appear nowhere in the backing store.
  const dump = persistence.serialize().toLowerCase();
  assert.ok(!dump.includes('rendezvous'), 'plaintext/normalised alias leaked into the backing store');
});

test('bindInvitedThread: a per-chat PIN is stored hash-only (plaintext PIN never persisted)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);

  const ref = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    pin: 'hunter2pin',
    routing: 'hidden',
    inviteId: 'inv-pin',
    state: 'active',
  });
  assert.ok(ref);
  assert.match(ref.pinVerifier ?? '', /^pbkdf2\$sha256\$/, 'only a PBKDF2 verifier is stored');
  const dump = persistence.serialize();
  assert.ok(!dump.includes('hunter2pin'), 'the plaintext PIN must never be persisted');
});

test('bindInvitedThread: fail-closed abort on a throwing record write — nothing partial persisted', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  persistence.failOn.add('saveInvitedThread');

  await assert.rejects(
    () =>
      store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
        alias: '/x',
        routing: 'hidden',
        inviteId: 'inv',
        state: 'active',
      }),
    /saveInvitedThread failed/,
  );
  assert.equal(persistence.invited.length, 0, 'a failed record write leaves no record');
});

test('markInvitedThreadActive: promotes awaiting-accept → active and is idempotent', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    routing: 'hidden',
    inviteId: 'inv-2',
    state: 'awaiting-accept',
  });

  const promoted = await store.markInvitedThreadActive('real', 'inv-2');
  assert.ok(promoted);
  assert.equal(promoted.state, 'active');
  assert.equal(persistence.invited[0]?.state, 'active');

  // Idempotent: a second call returns the active record and writes nothing new.
  const again = await store.markInvitedThreadActive('real', 'inv-2');
  assert.equal(again?.state, 'active');
  assert.equal(persistence.invited.length, 1);

  // Unknown invite ⇒ null, no partial state.
  assert.equal(await store.markInvitedThreadActive('real', 'nope'), null);
  // Decoy/null ⇒ inert no-op.
  assert.equal(await store.markInvitedThreadActive('decoy', 'inv-2'), null);
  assert.equal(await store.markInvitedThreadActive(null, 'inv-2'), null);
});

test('discardInvitedThread: removes the pending record + key and is idempotent', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    alias: '/pending',
    routing: 'hidden',
    inviteId: 'inv-3',
    state: 'awaiting-accept',
  });
  assert.equal(persistence.invited.length, 1);
  assert.equal(persistence.entries.length, 1);

  await store.discardInvitedThread('real', 'inv-3');
  assert.equal(persistence.invited.length, 0, 'record removed');
  assert.equal(persistence.entries.length, 0, 'alias entry removed too');

  // Idempotent: discarding again is a silent no-op.
  await store.discardInvitedThread('real', 'inv-3');
  assert.equal(persistence.invited.length, 0);

  // Decoy/null ⇒ inert no-op (delete nothing).
  await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    routing: 'hidden',
    inviteId: 'inv-4',
    state: 'awaiting-accept',
  });
  await store.discardInvitedThread('decoy', 'inv-4');
  await store.discardInvitedThread(null, 'inv-4');
  assert.equal(persistence.invited.length, 1, 'non-real discard deletes nothing');
});

test('discardInvitedThread: fail-closed abort leaves the record intact (no partial delete)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    routing: 'hidden',
    inviteId: 'inv-5',
    state: 'awaiting-accept',
  });
  persistence.failOn.add('deleteInvitedThread');

  await assert.rejects(() => store.discardInvitedThread('real', 'inv-5'), /deleteInvitedThread failed/);
  assert.equal(persistence.invited.length, 1, 'a failed delete leaves the record intact');
});

test('clearShadowThread: returns the ref and KEEPS the record + key untouched; idempotent', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const bound = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    alias: '/keep',
    routing: 'hidden',
    inviteId: 'inv-6',
    state: 'active',
  });
  assert.ok(bound);

  const cleared = await store.clearShadowThread('real', bound.threadId);
  assert.ok(cleared, 'clear returns the validated ref');
  assert.equal(cleared.threadId, bound.threadId);
  assert.deepEqual(cleared.threadKey, THREAD_KEY, 'the shared key is returned, kept intact');
  // The record + key + alias entry are all RETAINED so the chat keeps working.
  assert.equal(persistence.invited.length, 1, 'clear keeps the record');
  assert.equal(persistence.entries.length, 1, 'clear keeps the alias entry');

  // Idempotent: clearing again still returns the same ref, still keeps everything.
  const again = await store.clearShadowThread('real', bound.threadId);
  assert.equal(again?.threadId, bound.threadId);
  assert.equal(persistence.invited.length, 1);

  // Unknown thread ⇒ null. Decoy/null ⇒ null (reveal nothing).
  assert.equal(await store.clearShadowThread('real', 'unknown'), null);
  assert.equal(await store.clearShadowThread('decoy', bound.threadId), null);
  assert.equal(await store.clearShadowThread(null, bound.threadId), null);
});

test('revokeShadowThread: atomically deletes key+record+alias and returns {peerUid, inviteId}', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const bound = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    alias: '/gone',
    routing: 'hidden',
    inviteId: 'inv-7',
    state: 'active',
  });
  assert.ok(bound);
  assert.equal(persistence.invited.length, 1);
  assert.equal(persistence.entries.length, 1);

  const result = await store.revokeShadowThread('real', bound.threadId);
  assert.deepEqual(result, { peerUid: 'bob', inviteId: 'inv-7' });
  assert.equal(persistence.invited.length, 0, 'record + key deleted');
  assert.equal(persistence.entries.length, 0, 'alias entry deleted too');

  // Idempotent: a second revoke of the now-absent thread returns null, changes nothing.
  assert.equal(await store.revokeShadowThread('real', bound.threadId), null);
});

test('revokeShadowThread: fail-closed abort leaves record + key intact (no keyless strand)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const bound = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    alias: '/strand',
    routing: 'hidden',
    inviteId: 'inv-8',
    state: 'active',
  });
  assert.ok(bound);
  persistence.failOn.add('deleteInvitedThread');

  await assert.rejects(() => store.revokeShadowThread('real', bound.threadId), /deleteInvitedThread failed/);
  assert.equal(persistence.invited.length, 1, 'the record stays intact on abort');
  assert.equal(persistence.entries.length, 1, 'the alias entry stays intact on abort');
});

test('revokeShadowThread: decoy AND null modes are a no-op returning null (delete nothing)', async () => {
  const persistence = fakePersistence();
  const store = new ShadowSecretStore(persistence);
  const bound = await store.bindInvitedThread('real', THREAD_KEY, 'bob', 'alice', {
    alias: '/safe',
    routing: 'hidden',
    inviteId: 'inv-9',
    state: 'active',
  });
  assert.ok(bound);

  for (const mode of ['decoy', null] as const) {
    assert.equal(await store.revokeShadowThread(mode, bound.threadId), null, `revoke must return null in ${mode}`);
  }
  assert.equal(persistence.invited.length, 1, 'non-real revoke deletes nothing');
  assert.equal(persistence.entries.length, 1);
});
