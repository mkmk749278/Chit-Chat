/**
 * `ShadowInviteCoordinator` unit tests (Shadow Chat Invites, design Component A; Tasks 5.6).
 *
 * The harness wires the REAL collaborators — `ShadowSecretStore` over an in-memory vault, a real
 * `ConversationRegistry`, and `InMemoryRowThreadAssociation` — behind paired transports so two
 * coordinators (inviter A, recipient B) exchange control payloads exactly as Messaging would. Each
 * side is provisioned with a DIFFERENT device-local master secret, so convergence on an identical
 * `threadId` can only come from the SHARED per-thread key carried in the invite (the regression the
 * shipped single-shared-secret e2e harness masked).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

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

// --- in-memory vault (the durable encrypted store, faked) ---------------------------------------

function makePersistence(): ShadowSecretPersistence {
  let master: Uint8Array | null = null;
  let aliasKey: Uint8Array | null = null;
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const invited: InvitedThreadRef[] = [];
  return {
    async loadMasterSecret() {
      return master;
    },
    async saveMasterSecret(secret) {
      master = secret;
    },
    async loadAliasKey() {
      return aliasKey;
    },
    async saveAliasKey(key) {
      aliasKey = key;
    },
    async loadAliasEntries() {
      return entries.map((e) => ({ aliasHash: e.aliasHash, ref: { ...e.ref } }));
    },
    async saveAliasEntry(entry) {
      const idx = entries.findIndex((e) => e.aliasHash === entry.aliasHash);
      const copy = { aliasHash: entry.aliasHash, ref: { ...entry.ref } };
      if (idx >= 0) entries[idx] = copy;
      else entries.push(copy);
    },
    async saveInvitedThread(record) {
      const idx = invited.findIndex((r) => r.threadId === record.threadId);
      const copy: InvitedThreadRef = { ...record, threadKey: record.threadKey.slice() };
      if (idx >= 0) invited[idx] = copy;
      else invited.push(copy);
    },
    async loadInvitedThreads() {
      return invited.map((r) => ({ ...r, threadKey: r.threadKey.slice() }));
    },
    async deleteInvitedThread(threadId) {
      const idx = invited.findIndex((r) => r.threadId === threadId);
      if (idx >= 0) invited.splice(idx, 1);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].ref.threadId === threadId) entries.splice(i, 1);
      }
    },
  };
}

/** A deterministic CSPRNG: distinct 32-byte keys per draw (seeded so each side differs). */
function makeRandom(seed: number): RandomSource {
  let n = seed;
  return {
    bytes(len: number): Uint8Array {
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
  store: ShadowSecretStore;
  registry: ConversationRegistry;
  rowThreads: InMemoryRowThreadAssociation;
  persistence: ShadowSecretPersistence;
  events: ShadowInviteEvent[];
  control: { to: string; payload: ContentPayload }[];
  shadow: { to: string; threadId: string; text: string }[];
  purged: string[];
  setMode: (m: AppMode | null) => void;
  setNow: (t: number) => void;
}

/** A two-party world: A's control sends are delivered into B.handleInbound and vice-versa. */
function makeWorld(): { A: Side; B: Side } {
  const sides: Record<string, Side> = {};
  let inviteCounter = 0;

  const build = (uid: string, peerUid: string, seed: number): Side => {
    const persistence = makePersistence();
    const store = new ShadowSecretStore(persistence);
    const registry = createConversationRegistry({ platform: 'mobile' });
    const rowThreads = new InMemoryRowThreadAssociation();
    const events: ShadowInviteEvent[] = [];
    const control: { to: string; payload: ContentPayload }[] = [];
    const shadow: { to: string; threadId: string; text: string }[] = [];
    const purged: string[] = [];
    let mode: AppMode | null = 'real';
    let clock = 1_000;

    const transport: ShadowInviteTransport = {
      async sendControl(to, payload) {
        control.push({ to, payload });
        const target = sides[to];
        if (target !== undefined) {
          await target.coord.handleInbound(uid, payload);
        }
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
      now: () => clock,
      newInviteId: () => `inv-${(inviteCounter += 1)}`,
      inviteTtlMs: 1000,
    });
    coord.onInvite((e) => events.push(e));

    const side: Side = {
      uid,
      coord,
      store,
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
      setNow: (t) => {
        clock = t;
      },
    };
    sides[uid] = side;
    return side;
  };

  const A = build('alice', 'bob', 1);
  const B = build('bob', 'alice', 999); // DIFFERENT seed ⇒ different device-local randomness
  return { A, B };
}

const eventTypes = (s: Side): string[] => s.events.map((e) => e.type);
const lastControl = (s: Side): ContentPayload | undefined => s.control.at(-1)?.payload;

// --- tests --------------------------------------------------------------------------------------

test('createInvite (real): sends one shadow-invite with a base64 32-byte key and leaves surface untouched', async () => {
  const { A } = makeWorld();
  const pending = await A.coord.createInvite('bob');
  assert.ok(pending, 'real-mode createInvite returns a pending handle');
  assert.equal(A.control.length, 1);
  const payload = lastControl(A);
  assert.equal(payload?.type, 'shadow-invite');
  if (payload?.type === 'shadow-invite') {
    assert.equal(Buffer.from(payload.key, 'base64').length, 32, 'key is 32 bytes');
  }
  assert.deepEqual(eventTypes(A), ['invite-sent']);
  // No-surface-disturbance: the surface conversation with bob has no rows.
  assert.equal(A.registry.getState({ kind: 'surface', remoteUid: 'bob' }).messages.length, 0);
  // A durable awaiting-accept record exists.
  const invited = await A.persistence.loadInvitedThreads();
  assert.equal(invited.length, 1);
  assert.equal(invited[0].state, 'awaiting-accept');
});

test('createInvite is inert in decoy and null mode (returns null, sends nothing)', async () => {
  for (const mode of ['decoy', null] as const) {
    const { A } = makeWorld();
    A.setMode(mode);
    const pending = await A.coord.createInvite('bob');
    assert.equal(pending, null);
    assert.equal(A.control.length, 0);
    assert.equal(A.events.length, 0);
    assert.equal((await A.persistence.loadInvitedThreads()).length, 0);
  }
});

test('invite → accept(hidden): both sides converge on the SAME threadId from the shared key (distinct masters)', async () => {
  const { A, B } = makeWorld();
  // Provision DIFFERENT device-local secrets per side to prove convergence is key-driven, not master.
  await A.persistence.saveMasterSecret(Uint8Array.from({ length: 32 }, () => 0xaa));
  await B.persistence.saveMasterSecret(Uint8Array.from({ length: 32 }, () => 0xbb));

  const pending = await A.coord.createInvite('bob');
  assert.ok(pending);
  // B received the invite card.
  assert.ok(B.events.some((e) => e.type === 'invite-received'));
  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');

  const ref = await B.coord.acceptInvite(received.inviteId, 'hidden');
  assert.ok(ref, 'accept returns a thread ref');
  // A promoted to active and learned the accept.
  assert.ok(A.events.some((e) => e.type === 'invite-accepted'));
  const accepted = A.events.find((e) => e.type === 'invite-accepted');
  assert.ok(accepted && accepted.type === 'invite-accepted');
  // CONVERGENCE: identical threadId on both sides.
  assert.equal(ref!.threadId, accepted.threadId, 'inviter and recipient threadIds must be identical');
  assert.equal(pending!.threadId, ref!.threadId);

  // hidden ⇒ excluded from B's surface list (no surface entry under the peer uid).
  assert.ok(!B.registry.listSurfaceConversations().some((c) => c.remoteUid === 'alice'));
  // shadow-accept must NOT encode the routing choice.
  const acceptPayload = B.control.find((c) => c.payload.type === 'shadow-accept');
  assert.deepEqual(acceptPayload?.payload, { type: 'shadow-accept', inviteId: received.inviteId });
  // Auto-cleanup: both sides emitted invite-resolved 'accepted' exactly once.
  assert.equal(A.events.filter((e) => e.type === 'invite-resolved').length, 1);
  assert.equal(B.events.filter((e) => e.type === 'invite-resolved').length, 1);
});

test('accept(merge): the thread becomes surface-visible under peerUid yet keeps its own shadow state', async () => {
  const { A, B } = makeWorld();
  await A.coord.createInvite('bob');
  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');
  const ref = await B.coord.acceptInvite(received.inviteId, 'merge');
  assert.ok(ref);
  const surfaced = B.registry.listSurfaceConversations().find((c) => c.remoteUid === 'alice');
  assert.ok(surfaced, 'merge ⇒ the thread appears in the surface list under the peer uid');
});

test('decline: inviter discards the pending record + key and both sides resolve as declined', async () => {
  const { A, B } = makeWorld();
  await A.coord.createInvite('bob');
  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');
  await B.coord.declineInvite(received.inviteId);

  assert.ok(A.events.some((e) => e.type === 'invite-declined'));
  assert.equal(A.events.filter((e) => e.type === 'invite-resolved').length, 1);
  assert.equal(B.events.filter((e) => e.type === 'invite-resolved').length, 1);
  // No shadow residue on either side.
  assert.equal((await A.persistence.loadInvitedThreads()).length, 0);
  assert.equal((await B.persistence.loadInvitedThreads()).length, 0);
});

test('pre-accept queue: messages typed before Accept are held locally and flushed in order on Accept', async () => {
  const { A, B } = makeWorld();
  const pending = await A.coord.createInvite('bob');
  assert.ok(pending);
  assert.equal(A.coord.enqueuePreAccept(pending!.threadId, 'm1'), true);
  assert.equal(A.coord.enqueuePreAccept(pending!.threadId, 'm2'), true);
  assert.equal(A.shadow.length, 0, 'nothing is transmitted before Accept');

  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');
  await B.coord.acceptInvite(received.inviteId, 'hidden');

  assert.deepEqual(
    A.shadow.map((s) => s.text),
    ['m1', 'm2'],
    'queued messages flush exactly once, in enqueue order',
  );
  assert.ok(A.shadow.every((s) => s.threadId === pending!.threadId));
});

test('pre-accept queue: messages are discarded on Decline (never transmitted)', async () => {
  const { A, B } = makeWorld();
  const pending = await A.coord.createInvite('bob');
  A.coord.enqueuePreAccept(pending!.threadId, 'never');
  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');
  await B.coord.declineInvite(received.inviteId);
  assert.equal(A.shadow.length, 0, 'declined ⇒ queued messages are dropped, not sent');
});

test('enqueuePreAccept returns false for a thread that is not awaiting-accept', async () => {
  const { A } = makeWorld();
  assert.equal(A.coord.enqueuePreAccept('unknown-thread', 'x'), false);
});

test('revoke: deletes key + record + history on both sides, closes the thread, and is symmetric', async () => {
  const { A, B } = makeWorld();
  const pending = await A.coord.createInvite('bob');
  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');
  await B.coord.acceptInvite(received.inviteId, 'hidden');
  const threadId = pending!.threadId;
  // Record a couple of history rows on each side for this thread.
  await A.rowThreads.record('a-row-1', threadId);
  await B.rowThreads.record('b-row-1', threadId);

  await A.coord.revokeShadowThread(threadId);

  // A: local-first deletion + purge + close + one shadow-revoke sent.
  assert.deepEqual(A.purged, ['a-row-1']);
  assert.equal((await A.persistence.loadInvitedThreads()).length, 0);
  assert.ok(A.events.some((e) => e.type === 'thread-revoked' && e.initiatedBy === 'self'));
  const revokePayload = A.control.find((c) => c.payload.type === 'shadow-revoke');
  assert.ok(revokePayload, 'exactly one shadow-revoke goes on the wire');
  assert.deepEqual(revokePayload!.payload, { type: 'shadow-revoke', inviteId: received.inviteId, threadId });

  // B: mirror teardown (delivered via the paired transport).
  assert.deepEqual(B.purged, ['b-row-1']);
  assert.equal((await B.persistence.loadInvitedThreads()).length, 0);
  assert.ok(B.events.some((e) => e.type === 'thread-revoked' && e.initiatedBy === 'peer'));
});

test('revoke of an unknown/already-revoked thread is a total no-op (idempotent)', async () => {
  const { A } = makeWorld();
  await A.coord.revokeShadowThread('does-not-exist');
  assert.equal(A.control.length, 0);
  assert.equal(A.purged.length, 0);
  assert.equal(A.events.length, 0);
});

test('revoke is inert in decoy/null mode (deletes nothing, sends nothing)', async () => {
  const { A, B } = makeWorld();
  const pending = await A.coord.createInvite('bob');
  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');
  await B.coord.acceptInvite(received.inviteId, 'hidden');
  await A.rowThreads.record('a-row-1', pending!.threadId);

  A.setMode('decoy');
  await A.coord.revokeShadowThread(pending!.threadId);
  assert.equal(A.purged.length, 0);
  assert.ok(!A.control.some((c) => c.payload.type === 'shadow-revoke'));
  assert.equal((await A.persistence.loadInvitedThreads()).length, 1, 'record survives a decoy revoke');
});

test('clear: purges local history and resets state but KEEPS the key so the chat keeps working', async () => {
  const { A, B } = makeWorld();
  const pending = await A.coord.createInvite('bob');
  const received = B.events.find((e) => e.type === 'invite-received');
  assert.ok(received && received.type === 'invite-received');
  await B.coord.acceptInvite(received.inviteId, 'hidden');
  await A.rowThreads.record('a-row-1', pending!.threadId);

  const controlsBefore = A.control.length;
  await A.coord.clearShadowThread(pending!.threadId);
  assert.deepEqual(A.purged, ['a-row-1'], 'history purged');
  assert.equal(A.control.length, controlsBefore, 'clear sends NO wire traffic');
  const invited = await A.persistence.loadInvitedThreads();
  assert.equal(invited.length, 1, 'record + key retained');
  assert.equal(invited[0].state, 'active'); // promoted on accept; Clear keeps it usable
  assert.equal(invited[0].threadKey.length, 32, 'shared key retained so the chat keeps working');
});

test('expireStaleInvites discards pending invites past TTL and emits resolved/expired', async () => {
  const { A, B } = makeWorld();
  await A.coord.createInvite('bob');
  assert.equal((await A.persistence.loadInvitedThreads()).length, 1);

  await A.coord.expireStaleInvites(5_000); // well past the 1000ms TTL from createdAt=1000
  assert.equal((await A.persistence.loadInvitedThreads()).length, 0);
  assert.ok(A.events.some((e) => e.type === 'invite-resolved' && e.reason === 'expired'));
  // B's inbound invite also expires on its own timer.
  await B.coord.expireStaleInvites(5_000);
  assert.ok(B.events.some((e) => e.type === 'invite-resolved' && e.reason === 'expired'));
});

test('handleInbound returns false for a non-shadow payload so Messaging keeps routing', async () => {
  const { A } = makeWorld();
  const consumed = await A.coord.handleInbound('bob', { type: 'text', body: 'hi' });
  assert.equal(consumed, false);
});

test('handleInbound silently ignores an inbound invite in decoy mode (no card, no thread)', async () => {
  const { A, B } = makeWorld();
  B.setMode('decoy');
  await A.coord.createInvite('bob');
  assert.ok(!B.events.some((e) => e.type === 'invite-received'), 'decoy reveals no invite');
  assert.equal((await B.persistence.loadInvitedThreads()).length, 0);
});
