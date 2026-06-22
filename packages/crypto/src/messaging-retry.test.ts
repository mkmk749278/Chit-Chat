import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  CiphertextBody,
  CiphertextEnvelope,
  ClientToServerFrame,
  ConnectionStatus,
  MessageStatus,
  ServerToClientFrame,
} from '@chat-app/types';
import type { ClaimedPreKeyBundle } from '@chat-app/types';

import { decodeContentPayload } from './content-payload';
import type { ConversationEvent } from './conversation-reducer';
import { createEnvelopeCodec } from './envelope-codec';
import { DefaultMessaging } from './messaging';
import type {
  LocalSenderResolver,
  MessagingDeps,
  MessagingRealtime,
  MessagingStore,
  PreKeyClaimClient,
} from './messaging';
import type { AttachmentRef, BlobStore, MessageRow, Unsubscribe } from './ports';
import type { SequenceAllocator } from './sequence-allocator';
import type { SessionManager } from './session-manager';

/**
 * Unit tests for {@link DefaultMessaging.retryMessage} (connection-reliability UX, roadmap P1 #5):
 * the user taps "retry" on a `failed` outbound message. Retry must reconstruct the message from its
 * persisted row and re-drive the send path with the SAME id + seq (no duplicate row/sequence), be
 * idempotent for anything not retryable, and re-send the right payload for both text and attachments.
 */

// --- fakes -------------------------------------------------------------------

class FakeRealtime implements MessagingRealtime {
  status: ConnectionStatus = 'connected';
  readonly sent: Extract<ClientToServerFrame, { kind: 'send' }>[] = [];
  private readonly frameListeners = new Set<(frame: ServerToClientFrame) => void>();

  send(frame: ClientToServerFrame): void {
    if (frame.kind === 'send') this.sent.push(frame);
  }
  getStatus(): ConnectionStatus {
    return this.status;
  }
  onFrame(listener: (frame: ServerToClientFrame) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onStatus(): Unsubscribe {
    return () => undefined;
  }
  emitFrame(frame: ServerToClientFrame): void {
    for (const l of this.frameListeners) l(frame);
  }
}

const bundle: ClaimedPreKeyBundle = {
  deviceId: 'dev-recipient',
  registrationId: 1,
  identityKey: Buffer.from('id').toString('base64'),
  signedPreKey: {
    keyId: 1,
    publicKey: Buffer.from('spk').toString('base64'),
    signature: Buffer.from('sig').toString('base64'),
  },
  oneTimePreKey: { keyId: 2, publicKey: Buffer.from('otp').toString('base64') },
};

class FakeSessions implements SessionManager {
  private readonly sessions = new Set<string>();
  /** The most recent encoded content-payload body handed to `encrypt`, for payload assertions. */
  lastBody: string | null = null;
  async hasSession(recipientUid: string): Promise<boolean> {
    return this.sessions.has(recipientUid);
  }
  async establishSession(recipientUid: string): Promise<void> {
    this.sessions.add(recipientUid);
  }
  async encrypt(_recipientUid: string, body: string): Promise<CiphertextBody> {
    this.lastBody = body;
    return { type: 3, ciphertext: Buffer.from('ct').toString('base64') };
  }
  async decrypt(): Promise<string> {
    return 'decrypted';
  }
  async getSafetyNumber(): Promise<null> {
    return null;
  }
}

class FakeSequence implements SequenceAllocator {
  private readonly counters = new Map<string, number>();
  async next(recipientUid: string): Promise<number> {
    const next = (this.counters.get(recipientUid) ?? 0) + 1;
    this.counters.set(recipientUid, next);
    return next;
  }
}

class FakeClaimer implements PreKeyClaimClient {
  result: ClaimedPreKeyBundle | null = bundle;
  async claim(): Promise<ClaimedPreKeyBundle | null> {
    return this.result;
  }
}

class FakeSender implements LocalSenderResolver {
  value: { uid: string; deviceId: string } | null = { uid: 'me', deviceId: 'dev-me' };
  async resolveSender(): Promise<{ uid: string; deviceId: string } | null> {
    return this.value;
  }
}

/** A realistic store that REFLECTS status updates back into the rows (so retry can read them). */
class Store implements MessagingStore {
  readonly rows = new Map<string, MessageRow>();
  seed(row: MessageRow): void {
    this.rows.set(row.id, { ...row });
  }
  async appendMessage(row: MessageRow): Promise<void> {
    this.rows.set(row.id, { ...row });
  }
  async updateMessageStatus(id: string, status: MessageStatus): Promise<void> {
    const r = this.rows.get(id);
    if (r !== undefined) r.status = status;
  }
  async applyReaction(): Promise<void> {}
  async applyEdit(): Promise<void> {}
  async applyDelete(): Promise<void> {}
  async setConversationTimer(): Promise<void> {}
  async loadMessages(): Promise<MessageRow[]> {
    return [...this.rows.values()].map((r) => ({ ...r }));
  }
  async purgeMessages(ids: string[]): Promise<void> {
    for (const id of ids) this.rows.delete(id);
  }
}

const ackFor = (envelope: CiphertextEnvelope): ServerToClientFrame => ({
  kind: 'ack',
  recipientUid: envelope.recipientUid,
  seq: envelope.seq,
  status: 'received',
});

interface Harness {
  realtime: FakeRealtime;
  sessions: FakeSessions;
  claimer: FakeClaimer;
  store: Store;
  events: ConversationEvent[];
  messaging: DefaultMessaging;
}

function makeHarness(blobs?: BlobStore): Harness {
  const realtime = new FakeRealtime();
  const sessions = new FakeSessions();
  const claimer = new FakeClaimer();
  const store = new Store();
  const events: ConversationEvent[] = [];
  let idCounter = 0;
  const deps: MessagingDeps = {
    realtime,
    sessions,
    sequence: new FakeSequence(),
    codec: createEnvelopeCodec(),
    keyClaimer: claimer,
    sender: new FakeSender(),
    store,
    ...(blobs !== undefined ? { blobs } : {}),
  };
  const messaging = new DefaultMessaging(deps, {
    generateId: () => `gen-${++idCounter}`,
    now: () => 1000,
  });
  messaging.onConversationUpdate((e) => events.push(e));
  return { realtime, sessions, claimer, store, events, messaging };
}

const failedTextRow = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  id: 'msg-1',
  remoteUid: 'bob',
  direction: 'out',
  seq: 7,
  plaintext: 'meet at noon',
  status: 'failed',
  createdAt: 500,
  ...overrides,
});

const attachmentRef: AttachmentRef = {
  blobId: 'blob-9',
  key: Buffer.from('k').toString('base64'),
  iv: Buffer.from('iv').toString('base64'),
  mediaType: 'image/jpeg',
  size: 1234,
  name: 'pic.jpg',
};

// --- tests -------------------------------------------------------------------

test('retry of a failed text message re-sends with the SAME id + seq and reaches sent', async () => {
  const h = makeHarness();
  h.store.seed(failedTextRow());

  await h.messaging.retryMessage('bob', { direction: 'out', seq: 7 });

  // Exactly one frame transmitted, carrying the original seq (no new sequence allocated).
  assert.equal(h.realtime.sent.length, 1);
  assert.equal(h.realtime.sent[0]!.envelope.seq, 7);

  // The re-sent payload is the original text, reconstructed from the row.
  assert.equal(decodeContentPayload(h.sessions.lastBody!).payload.type, 'text');

  // Optimistic flip back to `sending`, then `sent` after the ack — all on the SAME row id.
  assert.ok(
    h.events.some((e) => e.type === 'status-updated' && e.id === 'msg-1' && e.status === 'sending'),
  );
  h.realtime.emitFrame(ackFor(h.realtime.sent[0]!.envelope));
  assert.equal(h.store.rows.get('msg-1')!.status, 'sent');

  // No duplicate row was created.
  assert.equal(h.store.rows.size, 1);
});

test('retry is a no-op for a message that is not failed (idempotent)', async () => {
  const h = makeHarness();
  h.store.seed(failedTextRow({ status: 'sent' }));

  await h.messaging.retryMessage('bob', { direction: 'out', seq: 7 });

  assert.equal(h.realtime.sent.length, 0, 'an already-sent message is not re-transmitted');
  assert.ok(!h.events.some((e) => e.type === 'status-updated'));
});

test('retry is a no-op for an inbound target and for an unknown seq', async () => {
  const h = makeHarness();
  h.store.seed(failedTextRow());

  await h.messaging.retryMessage('bob', { direction: 'in', seq: 7 }); // can't retry a peer's message
  await h.messaging.retryMessage('bob', { direction: 'out', seq: 999 }); // no such row

  assert.equal(h.realtime.sent.length, 0);
});

test('retry re-sends a failed attachment whose ciphertext was already uploaded', async () => {
  const blobs: BlobStore = {
    async put(): Promise<string> {
      throw new Error('retry must not re-upload an already-uploaded blob');
    },
    async get(): Promise<Uint8Array> {
      return new Uint8Array();
    },
  };
  const h = makeHarness(blobs);
  h.store.seed(failedTextRow({ plaintext: null, attachment: attachmentRef }));

  await h.messaging.retryMessage('bob', { direction: 'out', seq: 7 });

  assert.equal(h.realtime.sent.length, 1);
  const decoded = decodeContentPayload(h.sessions.lastBody!).payload;
  assert.equal(decoded.type, 'attachment');
  assert.equal(decoded.type === 'attachment' ? decoded.blobId : '', 'blob-9');
});

test('retry will not resend an attachment whose upload never produced a blob handle', async () => {
  const h = makeHarness();
  h.store.seed(
    failedTextRow({ plaintext: null, attachment: { ...attachmentRef, blobId: '' } }),
  );

  await h.messaging.retryMessage('bob', { direction: 'out', seq: 7 });

  assert.equal(h.realtime.sent.length, 0, 'no bytes retained → nothing to resend');
});

test('retry holds the frame for flush-on-reconnect when disconnected (will send when online)', async () => {
  const h = makeHarness();
  h.realtime.status = 'disconnected';
  h.store.seed(failedTextRow());

  await h.messaging.retryMessage('bob', { direction: 'out', seq: 7 });

  // Nothing transmitted while offline, but the row is back to `sending` (the "will send" affordance)
  // and the frame is held in the pending queue for flush-on-reconnect (existing send-path behaviour).
  assert.equal(h.realtime.sent.length, 0);
  assert.equal(h.store.rows.get('msg-1')!.status, 'sending');
});
