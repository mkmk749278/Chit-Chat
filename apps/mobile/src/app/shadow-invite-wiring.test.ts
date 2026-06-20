/**
 * Tests for {@link buildShadowInviteCoordinator} (mobile wiring of the shared ShadowInviteCoordinator,
 * Shadow Chat Invites design Component A). Uses the REAL ShadowSecretStore / ConversationRegistry /
 * InMemoryRowThreadAssociation with a fake Messaging, asserting the transport binds to
 * `sendShadowControl` / `send({threadId})`, real-mode gating holds, and Clear/Revoke purge history.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createConversationRegistry,
  InMemoryRowThreadAssociation,
  ShadowSecretStore,
  type AliasEntry,
  type AppMode,
  type ContentPayload,
  type InvitedThreadRef,
  type Messaging,
  type ShadowSecretPersistence,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import { buildShadowInviteCoordinator } from './shadow-invite-wiring';

function makePersistence(): ShadowSecretPersistence {
  const entries: AliasEntry<ShadowThreadRef>[] = [];
  const invited: InvitedThreadRef[] = [];
  let master: Uint8Array | null = null;
  let aliasKey: Uint8Array | null = null;
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
    },
  };
}

interface Harness {
  control: { to: string; payload: ContentPayload }[];
  shadow: { to: string; threadId: string; text: string }[];
  purged: string[];
  persistence: ShadowSecretPersistence;
  rowThreads: InMemoryRowThreadAssociation;
  setMode: (m: AppMode | null) => void;
  coordinator: ReturnType<typeof buildShadowInviteCoordinator>;
}

function makeHarness(): Harness {
  const control: { to: string; payload: ContentPayload }[] = [];
  const shadow: { to: string; threadId: string; text: string }[] = [];
  const purged: string[] = [];
  const persistence = makePersistence();
  const store = new ShadowSecretStore(persistence);
  const registry = createConversationRegistry({ platform: 'mobile' });
  const rowThreads = new InMemoryRowThreadAssociation();
  let mode: AppMode | null = 'real';
  let counter = 0;

  const messaging = {
    async sendShadowControl(to: string, payload: ContentPayload) {
      control.push({ to, payload });
    },
    async send(to: string, text: string, options?: { threadId?: string }) {
      if (options?.threadId !== undefined) shadow.push({ to, threadId: options.threadId, text });
    },
  } as unknown as Messaging;

  const coordinator = buildShadowInviteCoordinator({
    messaging: () => messaging,
    store,
    registry,
    rowThreads,
    keyStore: { purgeMessages: async (ids) => void purged.push(...ids) },
    resolveMode: () => mode,
    myUid: () => 'alice',
    randomBytes: (n) => Uint8Array.from({ length: n }, (_v, i) => (i * 7 + (counter += 1)) & 0xff),
    now: () => 1000,
    newInviteId: () => `inv-${(counter += 1)}`,
  });

  return { control, shadow, purged, persistence, rowThreads, setMode: (m) => void (mode = m), coordinator };
}

test('createInvite (real) sends a shadow-invite control via Messaging.sendShadowControl', async () => {
  const h = makeHarness();
  const pending = await h.coordinator.createInvite('bob');
  assert.ok(pending);
  assert.equal(h.control.length, 1);
  assert.equal(h.control[0].to, 'bob');
  assert.equal(h.control[0].payload.type, 'shadow-invite');
  assert.equal((await h.persistence.loadInvitedThreads())[0]?.state, 'awaiting-accept');
});

test('createInvite is inert in decoy/null mode (no control sent, nothing persisted)', async () => {
  for (const mode of ['decoy', null] as const) {
    const h = makeHarness();
    h.setMode(mode);
    assert.equal(await h.coordinator.createInvite('bob'), null);
    assert.equal(h.control.length, 0);
    assert.equal((await h.persistence.loadInvitedThreads()).length, 0);
  }
});

test('pre-accept messages flush as shadow sends through Messaging.send({threadId}) on accept', async () => {
  const h = makeHarness();
  const pending = await h.coordinator.createInvite('bob');
  assert.ok(pending);
  h.coordinator.enqueuePreAccept(pending!.threadId, 'queued-1');
  // Simulate the inbound shadow-accept from bob.
  const accepted = await h.coordinator.handleInbound('bob', {
    type: 'shadow-accept',
    inviteId: pending!.inviteId,
  });
  assert.equal(accepted, true);
  assert.deepEqual(h.shadow.map((s) => ({ to: s.to, threadId: s.threadId, text: s.text })), [
    { to: 'bob', threadId: pending!.threadId, text: 'queued-1' },
  ]);
});

test('clear purges this thread history but keeps the record; revoke deletes it and notifies the peer', async () => {
  const h = makeHarness();
  const pending = await h.coordinator.createInvite('bob');
  assert.ok(pending);
  await h.coordinator.handleInbound('bob', { type: 'shadow-accept', inviteId: pending!.inviteId });
  await h.rowThreads.record('row-1', pending!.threadId);

  await h.coordinator.clearShadowThread(pending!.threadId);
  assert.deepEqual(h.purged, ['row-1']);
  assert.equal((await h.persistence.loadInvitedThreads()).length, 1, 'clear keeps the record + key');

  await h.rowThreads.record('row-2', pending!.threadId);
  await h.coordinator.revokeShadowThread(pending!.threadId);
  assert.deepEqual(h.purged, ['row-1', 'row-2']);
  assert.equal((await h.persistence.loadInvitedThreads()).length, 0, 'revoke deletes the record');
  assert.ok(
    h.control.some((c) => c.payload.type === 'shadow-revoke'),
    'revoke notifies the peer with a shadow-revoke control',
  );
});
