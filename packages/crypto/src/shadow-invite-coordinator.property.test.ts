/**
 * `ShadowInviteCoordinator` property-based tests (Shadow Chat Invites, design Correctness Properties
 * 6, 8, 9, 13, 16; Task 5.7). Uses `fast-check` (≥100 runs) over arbitrary invite lifecycles.
 *
 * Each side runs the REAL `ShadowSecretStore` / `ConversationRegistry` / `InMemoryRowThreadAssociation`
 * behind paired transports, with DIFFERENT device-local master secrets — so any threadId convergence
 * is driven only by the shared per-thread key.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { AppMode } from './app-lock';
import type { ContentPayload } from './content-payload';
import { createConversationRegistry, type ConversationRegistry } from './conversation-registry';
import { InMemoryRowThreadAssociation } from './row-thread-association';
import type { AliasEntry } from './shadow-chat';
import {
  DefaultShadowInviteCoordinator,
  type RandomSource,
  type ShadowInviteCoordinator,
  type ShadowInviteEvent,
  type ShadowInviteTransport,
} from './shadow-invite-coordinator';
import {
  ShadowSecretStore,
  type InvitedThreadRef,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from './shadow-secret-store';

const RUNS = 100;

function makePersistence(): ShadowSecretPersistence {
  let master: Uint8Array | null = null;
  let aliasKey: Uint8Array | null = null;
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const invited: InvitedThreadRef[] = [];
  return {
    async loadMasterSecret() {
      return master;
    },
    async saveMasterSecret(s) {
      master = s;
    },
    async loadAliasKey() {
      return aliasKey;
    },
    async saveAliasKey(k) {
      aliasKey = k;
    },
    async loadAliasEntries() {
      return entries.map((e) => ({ aliasHash: e.aliasHash, ref: { ...e.ref } }));
    },
    async saveAliasEntry(entry) {
      const i = entries.findIndex((e) => e.aliasHash === entry.aliasHash);
      const c = { aliasHash: entry.aliasHash, ref: { ...entry.ref } };
      if (i >= 0) entries[i] = c;
      else entries.push(c);
    },
    async saveInvitedThread(r) {
      const i = invited.findIndex((x) => x.threadId === r.threadId);
      const c: InvitedThreadRef = { ...r, threadKey: r.threadKey.slice() };
      if (i >= 0) invited[i] = c;
      else invited.push(c);
    },
    async loadInvitedThreads() {
      return invited.map((r) => ({ ...r, threadKey: r.threadKey.slice() }));
    },
    async deleteInvitedThread(threadId) {
      const i = invited.findIndex((x) => x.threadId === threadId);
      if (i >= 0) invited.splice(i, 1);
      for (let j = entries.length - 1; j >= 0; j -= 1) {
        if (entries[j].ref.threadId === threadId) entries.splice(j, 1);
      }
    },
  };
}

function makeRandom(seed: number): RandomSource {
  let n = seed;
  return {
    bytes(len: number) {
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) {
        n = (n * 1103515245 + 12345) & 0x7fffffff;
        out[i] = n & 0xff;
      }
      return out;
    },
  };
}

interface Side {
  uid: string;
  coord: ShadowInviteCoordinator;
  registry: ConversationRegistry;
  rowThreads: InMemoryRowThreadAssociation;
  persistence: ShadowSecretPersistence;
  events: ShadowInviteEvent[];
  control: { to: string; payload: ContentPayload }[];
  shadow: { to: string; threadId: string; text: string }[];
  purged: string[];
  setMode: (m: AppMode | null) => void;
}

function makeWorld(seedA: number, seedB: number): { A: Side; B: Side } {
  const sides: Record<string, Side> = {};
  let counter = 0;
  const build = (uid: string, seed: number): Side => {
    const persistence = makePersistence();
    const store = new ShadowSecretStore(persistence);
    const registry = createConversationRegistry({ platform: 'mobile' });
    const rowThreads = new InMemoryRowThreadAssociation();
    const events: ShadowInviteEvent[] = [];
    const control: { to: string; payload: ContentPayload }[] = [];
    const shadow: { to: string; threadId: string; text: string }[] = [];
    const purged: string[] = [];
    let mode: AppMode | null = 'real';
    const transport: ShadowInviteTransport = {
      async sendControl(to, payload) {
        control.push({ to, payload });
        await sides[to]?.coord.handleInbound(uid, payload);
      },
      async sendShadow(to, threadId, text) {
        shadow.push({ to, threadId, text });
      },
    };
    const coord = new DefaultShadowInviteCoordinator({
      store,
      registry,
      transport,
      random: makeRandom(seed),
      rowThreads,
      purgeMessages: async (ids) => {
        purged.push(...ids);
      },
      resolveMode: () => mode,
      myUid: () => uid,
      now: () => 1000,
      newInviteId: () => `inv-${(counter += 1)}`,
      inviteTtlMs: 1000,
    });
    coord.onInvite((e) => events.push(e));
    const side: Side = {
      uid,
      coord,
      registry,
      rowThreads,
      persistence,
      events,
      control,
      shadow,
      purged,
      setMode: (m) => {
        mode = m;
      },
    };
    sides[uid] = side;
    return side;
  };
  const A = build('alice', seedA);
  const B = build('bob', seedB);
  return { A, B };
}

const recvInviteId = (B: Side): string | undefined =>
  B.events.find((e) => e.type === 'invite-received')?.type === 'invite-received'
    ? (B.events.find((e) => e.type === 'invite-received') as { inviteId: string }).inviteId
    : undefined;

// Property 8 — No-surface-disturbance for the inviter ---------------------------------------------

test('Property 8: the inviter surface state is byte-for-byte unchanged across any invite lifecycle', async () => {
  // design Correctness Property 8.
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.array(fc.string(), { maxLength: 5 }),
      fc.constantFrom('accept-hidden', 'accept-merge', 'decline', 'expire'),
      async (seedA, seedB, preMsgs, outcome) => {
        const { A, B } = makeWorld(seedA, seedB);
        const before = JSON.stringify(A.registry.getState({ kind: 'surface', remoteUid: 'bob' }));
        const pending = await A.coord.createInvite('bob');
        assert.ok(pending);
        for (const m of preMsgs) A.coord.enqueuePreAccept(pending!.threadId, m);
        const id = recvInviteId(B);
        if (outcome === 'accept-hidden' && id) await B.coord.acceptInvite(id, 'hidden');
        else if (outcome === 'accept-merge' && id) await B.coord.acceptInvite(id, 'merge');
        else if (outcome === 'decline' && id) await B.coord.declineInvite(id);
        else await A.coord.expireStaleInvites(10_000);
        const after = JSON.stringify(A.registry.getState({ kind: 'surface', remoteUid: 'bob' }));
        return before === after;
      },
    ),
    { numRuns: RUNS },
  );
});

// Property 9 — Pre-accept queue safety ------------------------------------------------------------

test('Property 9: queued pre-accept messages flush exactly once, in order, only on Accept', async () => {
  // design Correctness Property 9 (seq contiguity ≥ SHADOW_SEQ_OFFSET is enforced by the allocator in
  // the send path — see the e2e gate; here we assert exactly-once, in-order, and none-on-decline).
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.array(fc.string(), { minLength: 0, maxLength: 8 }),
      fc.boolean(),
      async (seedA, seedB, msgs, accept) => {
        const { A, B } = makeWorld(seedA, seedB);
        const pending = await A.coord.createInvite('bob');
        assert.ok(pending);
        for (const m of msgs) A.coord.enqueuePreAccept(pending!.threadId, m);
        assert.equal(A.shadow.length, 0); // nothing transmitted before Accept
        const id = recvInviteId(B);
        if (accept && id) {
          await B.coord.acceptInvite(id, 'hidden');
          assert.deepEqual(A.shadow.map((s) => s.text), msgs);
          assert.ok(A.shadow.every((s) => s.threadId === pending!.threadId));
        } else if (id) {
          await B.coord.declineInvite(id);
          assert.equal(A.shadow.length, 0);
        }
        return true;
      },
    ),
    { numRuns: RUNS },
  );
});

// Property 13 — No invite-control residue ---------------------------------------------------------

test('Property 13: only an active record (accept) or nothing (decline/expire) persists; resolved fires once', async () => {
  // design Correctness Property 13.
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.constantFrom('accept', 'decline', 'expire'),
      async (seedA, seedB, outcome) => {
        const { A, B } = makeWorld(seedA, seedB);
        await A.coord.createInvite('bob');
        const id = recvInviteId(B);
        if (outcome === 'accept' && id) {
          await B.coord.acceptInvite(id, 'hidden');
          const inv = await A.persistence.loadInvitedThreads();
          assert.equal(inv.length, 1);
          assert.equal(inv[0].state, 'active');
        } else if (outcome === 'decline' && id) {
          await B.coord.declineInvite(id);
          assert.equal((await A.persistence.loadInvitedThreads()).length, 0);
        } else {
          await A.coord.expireStaleInvites(10_000);
          assert.equal((await A.persistence.loadInvitedThreads()).length, 0);
        }
        // Exactly one invite-resolved on the inviter (accept/expire) or recipient (decline) path.
        const resolvedA = A.events.filter((e) => e.type === 'invite-resolved').length;
        const resolvedB = B.events.filter((e) => e.type === 'invite-resolved').length;
        return resolvedA + resolvedB >= 1 && resolvedA <= 1 && resolvedB <= 1;
      },
    ),
    { numRuns: RUNS },
  );
});

// Property 6 — Decoy/null inertness ---------------------------------------------------------------

test('Property 6: createInvite/acceptInvite and inbound invites are inert in decoy and null mode', async () => {
  // design Correctness Property 6.
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.constantFrom<AppMode | null>('decoy', null),
      async (seedA, seedB, nonReal) => {
        const { A, B } = makeWorld(seedA, seedB);
        // Inviter in non-real mode: createInvite releases nothing, sends nothing.
        A.setMode(nonReal);
        const pending = await A.coord.createInvite('bob');
        assert.equal(pending, null);
        assert.equal(A.control.length, 0);
        assert.equal((await A.persistence.loadInvitedThreads()).length, 0);
        // Recipient in non-real mode never reveals an inbound invite (separate real-mode inviter).
        const { A: A2, B: B2 } = makeWorld(seedA ^ 0x5a5a, seedB ^ 0x5a5a);
        B2.setMode(nonReal);
        await A2.coord.createInvite('bob');
        assert.ok(!B2.events.some((e) => e.type === 'invite-received'));
        assert.equal((await B2.persistence.loadInvitedThreads()).length, 0);
        return true;
      },
    ),
    { numRuns: RUNS },
  );
});

// Property 16 — Revoke decoy inertness ------------------------------------------------------------

test('Property 16: revoke (outbound and inbound) is inert in decoy/null — deletes nothing, sends nothing', async () => {
  // design Correctness Property 16.
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.integer({ min: 1, max: 1 << 20 }),
      fc.constantFrom<AppMode | null>('decoy', null),
      async (seedA, seedB, nonReal) => {
        const { A, B } = makeWorld(seedA, seedB);
        const pending = await A.coord.createInvite('bob');
        assert.ok(pending);
        const id = recvInviteId(B);
        assert.ok(id);
        await B.coord.acceptInvite(id!, 'hidden');
        await A.rowThreads.record('row-1', pending!.threadId);
        const controlsBefore = A.control.length;

        // Outbound revoke in non-real mode is a no-op.
        A.setMode(nonReal);
        await A.coord.revokeShadowThread(pending!.threadId);
        assert.equal(A.purged.length, 0);
        assert.equal(A.control.length, controlsBefore);
        assert.equal((await A.persistence.loadInvitedThreads()).length, 1);

        // Inbound revoke while in non-real mode is also inert.
        B.setMode(nonReal);
        const consumed = await B.coord.handleInbound('alice', {
          type: 'shadow-revoke',
          inviteId: id!,
          threadId: pending!.threadId,
        });
        assert.equal(consumed, true);
        assert.equal(B.purged.length, 0);
        assert.equal((await B.persistence.loadInvitedThreads()).length, 1);
        return true;
      },
    ),
    { numRuns: RUNS },
  );
});
