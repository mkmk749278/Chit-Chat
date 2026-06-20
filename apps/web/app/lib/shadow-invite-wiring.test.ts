import { describe, expect, it } from 'vitest';

import {
  createConversationRegistry,
  InMemoryRowThreadAssociation,
  ShadowSecretStore,
  type ContentPayload,
  type ShadowInviteTransport,
} from '@chat-app/crypto';

import { createInMemoryShadowSecretPersistence } from './shadow-search';
import { buildWebShadowInviteCoordinator } from './shadow-invite-wiring';

function harness() {
  const control: { to: string; payload: ContentPayload }[] = [];
  const shadow: { to: string; threadId: string; text: string }[] = [];
  const purged: string[] = [];
  const persistence = createInMemoryShadowSecretPersistence();
  const store = new ShadowSecretStore(persistence);
  const registry = createConversationRegistry({ platform: 'web' });
  const rowThreads = new InMemoryRowThreadAssociation();
  let counter = 0;
  const transport: ShadowInviteTransport = {
    async sendControl(to, payload) {
      control.push({ to, payload });
    },
    async sendShadow(to, threadId, text) {
      shadow.push({ to, threadId, text });
    },
  };
  const coordinator = buildWebShadowInviteCoordinator({
    transport,
    store,
    registry,
    rowThreads,
    purgeMessages: async (ids) => void purged.push(...ids),
    resolveMode: () => 'real',
    myUid: () => 'alice',
    randomBytes: (n) => Uint8Array.from({ length: n }, (_v, i) => (i * 13 + (counter += 1)) & 0xff),
    now: () => 1000,
    newInviteId: () => `inv-${(counter += 1)}`,
  });
  return { control, shadow, purged, persistence, coordinator };
}

describe('buildWebShadowInviteCoordinator', () => {
  it('createInvite sends one shadow-invite control over the injected transport', async () => {
    const h = harness();
    const pending = await h.coordinator.createInvite('bob');
    expect(pending).not.toBeNull();
    expect(h.control).toHaveLength(1);
    expect(h.control[0]).toMatchObject({ to: 'bob', payload: { type: 'shadow-invite' } });
    expect((await h.persistence.loadInvitedThreads())[0]?.state).toBe('awaiting-accept');
  });

  it('flushes pre-accept messages as shadow sends on accept', async () => {
    const h = harness();
    const pending = await h.coordinator.createInvite('bob');
    h.coordinator.enqueuePreAccept(pending!.threadId, 'queued');
    await h.coordinator.handleInbound('bob', { type: 'shadow-accept', inviteId: pending!.inviteId });
    expect(h.shadow).toEqual([{ to: 'bob', threadId: pending!.threadId, text: 'queued' }]);
  });

  it('revoke deletes the record and notifies the peer with a shadow-revoke', async () => {
    const h = harness();
    const pending = await h.coordinator.createInvite('bob');
    await h.coordinator.handleInbound('bob', { type: 'shadow-accept', inviteId: pending!.inviteId });
    await h.coordinator.revokeShadowThread(pending!.threadId);
    expect((await h.persistence.loadInvitedThreads())).toHaveLength(0);
    expect(h.control.some((c) => c.payload.type === 'shadow-revoke')).toBe(true);
  });
});
