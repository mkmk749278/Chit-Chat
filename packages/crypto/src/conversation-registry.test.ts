import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationEvent, RenderableMessage } from './conversation-reducer';
import {
  DefaultConversationRegistry,
  UnknownShadowThreadError,
  createConversationRegistry,
  type ConversationKey,
} from './conversation-registry';

/**
 * `@chat-app/crypto` — unit tests for the {@link DefaultConversationRegistry} (Shadow Chat, design
 * Component 5; task 4.2). Assert one state instance per key, surface/shadow events routing to
 * DISJOINT instances, `listSurfaceConversations` excluding shadow threads, `isNotifiable` being
 * false for shadow events, per-thread gap detection, and unknown-thread rejection leaving every
 * state unchanged (Requirements 7.1–7.8).
 */

const THREAD_A = 'a'.repeat(64);
const THREAD_B = 'b'.repeat(64);

/** Build an outbound `message-appended` event, optionally tagged with a shadow threadId. */
function appended(
  remoteUid: string,
  message: RenderableMessage,
  threadId?: string,
): ConversationEvent {
  return {
    type: 'message-appended',
    message,
    remoteUid,
    ...(threadId !== undefined ? { threadId } : {}),
  };
}

const outMsg = (seq: number, text: string): RenderableMessage => ({
  id: `out-${seq}`,
  seq,
  direction: 'out',
  text,
  status: 'sending',
});

const inMsg = (seq: number, text: string): RenderableMessage => ({
  id: `in-${seq}`,
  seq,
  direction: 'in',
  text,
  status: 'received',
});

const surfaceKey = (remoteUid: string): ConversationKey => ({ kind: 'surface', remoteUid });
const shadowKey = (threadId: string, peerUid: string): ConversationKey => ({
  kind: 'shadow',
  threadId,
  peerUid,
});

test('getState returns the SAME state instance per key across calls (7.1)', () => {
  const reg = new DefaultConversationRegistry();
  reg.apply(appended('bob', outMsg(1, 'hi')));
  const first = reg.getState(surfaceKey('bob'));
  const second = reg.getState(surfaceKey('bob'));
  assert.strictEqual(first, second, 'same key must yield the identical state object');
});

test('getState creates an empty state on first access (7.1)', () => {
  const reg = createConversationRegistry();
  const state = reg.getState(surfaceKey('never-seen'));
  assert.deepEqual(state.messages, []);
  assert.equal(state.missingBefore.length, 0);
  assert.equal(state.disappearingTtlMs, 0);
});

test('surface and shadow events route to DISJOINT state instances (7.2)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');

  reg.apply(appended('bob', outMsg(1, 'surface hello')));
  reg.apply(appended('bob', outMsg(1_000_000_001, 'shadow hello'), THREAD_A));

  const surface = reg.getState(surfaceKey('bob'));
  const shadow = reg.getState(shadowKey(THREAD_A, 'bob'));

  assert.notStrictEqual(surface, shadow, 'surface and shadow must be distinct instances');
  assert.deepEqual(
    surface.messages.map((m) => m.text),
    ['surface hello'],
  );
  assert.deepEqual(
    shadow.messages.map((m) => m.text),
    ['shadow hello'],
  );
});

test('a shadow event never mutates the surface state and vice-versa (7.2, 7.3)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');

  reg.apply(appended('bob', outMsg(1, 'surface')));
  reg.apply(appended('bob', outMsg(1_000_000_001, 'shadow'), THREAD_A));
  // A reaction + timer in the shadow thread must not touch the surface message.
  reg.apply({
    type: 'reaction-applied',
    targetDirection: 'out',
    targetSeq: 1_000_000_001,
    emoji: '🔥',
    remoteUid: 'bob',
    threadId: THREAD_A,
  });
  reg.apply({ type: 'timer-changed', ttlMs: 60_000, remoteUid: 'bob', threadId: THREAD_A });

  const surface = reg.getState(surfaceKey('bob'));
  const shadow = reg.getState(shadowKey(THREAD_A, 'bob'));
  assert.equal(surface.messages[0]?.reactions, undefined, 'surface message has no shadow reaction');
  assert.equal(surface.disappearingTtlMs, 0, 'surface timer untouched by a shadow timer');
  assert.deepEqual(shadow.messages[0]?.reactions, ['🔥']);
  assert.equal(shadow.disappearingTtlMs, 60_000);
});

test('listSurfaceConversations returns only surface entries — zero shadow entries (7.5, 7.6)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.openShadowThread(THREAD_B, 'carol');

  reg.apply(appended('bob', outMsg(1, 'surface bob')));
  reg.apply(appended('carol', outMsg(1, 'surface carol')));
  reg.apply(appended('bob', outMsg(1_000_000_001, 'shadow bob'), THREAD_A));
  reg.apply(appended('carol', outMsg(1_000_000_001, 'shadow carol'), THREAD_B));

  const list = reg.listSurfaceConversations();
  assert.deepEqual(list.map((e) => e.remoteUid).sort(), ['bob', 'carol']);
  // Not one of the entries corresponds to a shadow thread.
  assert.equal(list.length, 2);
});

test('listSurfaceConversations excludes a shadow thread even when no surface chat exists (7.5)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_001, 'shadow only'), THREAD_A));
  assert.deepEqual(reg.listSurfaceConversations(), []);
});

test('isNotifiable is false for any shadow-tagged event and true for surface (7.5, 7.6)', () => {
  const reg = new DefaultConversationRegistry();
  assert.equal(reg.isNotifiable(appended('bob', inMsg(1, 'surface'))), true);
  assert.equal(reg.isNotifiable(appended('bob', inMsg(1_000_000_001, 'shadow'), THREAD_A)), false);
  assert.equal(
    reg.isNotifiable({
      type: 'reaction-applied',
      targetDirection: 'in',
      targetSeq: 1_000_000_001,
      emoji: '👍',
      remoteUid: 'bob',
      threadId: THREAD_A,
    }),
    false,
  );
});

test('gap detection (missingBefore) is computed PER thread (7.4)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');

  // Surface: contiguous inbound 1,2 → no gap.
  reg.apply(appended('bob', inMsg(1, 's1')));
  reg.apply(appended('bob', inMsg(2, 's2')));
  // Shadow: inbound 1e9+1 then 1e9+3 (missing 1e9+2) → a gap at 1e9+3, isolated to the thread.
  reg.apply(appended('bob', inMsg(1_000_000_001, 'h1'), THREAD_A));
  reg.apply(appended('bob', inMsg(1_000_000_003, 'h3'), THREAD_A));

  assert.deepEqual(reg.getState(surfaceKey('bob')).missingBefore, []);
  assert.deepEqual(reg.getState(shadowKey(THREAD_A, 'bob')).missingBefore, [1_000_000_003]);
});

test('an inbound event for an UNOPENED shadow thread is rejected and changes nothing (7.8)', () => {
  const reg = new DefaultConversationRegistry();
  reg.apply(appended('bob', outMsg(1, 'surface')));
  const surfaceBefore = reg.getState(surfaceKey('bob'));

  assert.throws(
    () => reg.apply(appended('bob', inMsg(1_000_000_001, 'sneaky inbound shadow'), THREAD_A)),
    UnknownShadowThreadError,
  );

  // Surface state is the identical, unmodified instance; no shadow entry leaked into the list.
  assert.strictEqual(reg.getState(surfaceKey('bob')), surfaceBefore);
  assert.deepEqual(surfaceBefore.messages.map((m) => m.text), ['surface']);
  assert.deepEqual(reg.listSurfaceConversations().map((e) => e.remoteUid), ['bob']);
});

test('rejection error carries the offending threadId (7.8)', () => {
  const reg = new DefaultConversationRegistry();
  try {
    reg.apply({
      type: 'reaction-applied',
      targetDirection: 'in',
      targetSeq: 1_000_000_001,
      emoji: '👍',
      remoteUid: 'bob',
      threadId: THREAD_B,
    });
    assert.fail('expected an UnknownShadowThreadError');
  } catch (err) {
    assert.ok(err instanceof UnknownShadowThreadError);
    assert.equal(err.threadId, THREAD_B);
  }
});

test('the first locally-initiated OUTBOUND send creates the shadow thread without openShadowThread (7.1, 7.2, 7.8)', () => {
  const reg = new DefaultConversationRegistry();
  // No openShadowThread call: an outbound send is locally initiated and may create the thread.
  reg.apply(appended('bob', outMsg(1_000_000_001, 'first shadow send'), THREAD_A));
  const shadow = reg.getState(shadowKey(THREAD_A, 'bob'));
  assert.deepEqual(shadow.messages.map((m) => m.text), ['first shadow send']);
  // It still must not appear in the surface list.
  assert.deepEqual(reg.listSurfaceConversations(), []);
});

test('openShadowThread is idempotent and does not reset an existing thread (7.1)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_001, 'kept'), THREAD_A));
  reg.openShadowThread(THREAD_A, 'bob'); // second open must not wipe history.
  assert.deepEqual(reg.getState(shadowKey(THREAD_A, 'bob')).messages.map((m) => m.text), ['kept']);
});

test('untagged conversation-UI events (composer/connection) are ignored by the router', () => {
  const reg = new DefaultConversationRegistry();
  // These carry neither remoteUid nor threadId; the registry does not route them.
  assert.doesNotThrow(() => {
    reg.apply({ type: 'composer-changed', text: 'draft' });
    reg.apply({ type: 'connection-changed', connection: 'connected' });
    reg.apply({ type: 'web-warning-acknowledged' });
  });
  assert.deepEqual(reg.listSurfaceConversations(), []);
});

test('a web-platform registry starts conversations gated behind the ephemerality ack', () => {
  const reg = new DefaultConversationRegistry({ platform: 'web' });
  assert.equal(reg.getState(surfaceKey('bob')).webWarningAcknowledged, false);
  const mobile = new DefaultConversationRegistry({ platform: 'mobile' });
  assert.equal(mobile.getState(surfaceKey('bob')).webWarningAcknowledged, true);
});

// --- Task 4: recipient routing override (markSurfaceVisible) + clearThread + closeThread ---

test('markSurfaceVisible surfaces a merged shadow thread under its peerUid and makes it notifiable, without touching its own state/seqs (3.2, 4.4)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_001, 'merged hi'), THREAD_A));

  // Capture the thread's own (isolated) state BEFORE the view override.
  const before = reg.getState(shadowKey(THREAD_A, 'bob'));
  // Before merge: excluded from the surface list and non-notifiable.
  assert.deepEqual(reg.listSurfaceConversations(), []);
  assert.equal(reg.isNotifiable(appended('bob', inMsg(1_000_000_002, 'x'), THREAD_A)), false);

  reg.markSurfaceVisible(THREAD_A);

  // Now present in the surface list under peerUid, and notifiable — purely a VIEW change.
  const list = reg.listSurfaceConversations();
  assert.deepEqual(list.map((e) => e.remoteUid), ['bob']);
  assert.deepEqual(list[0]?.state.messages.map((m) => m.text), ['merged hi']);
  assert.equal(reg.isNotifiable(appended('bob', inMsg(1_000_000_002, 'x'), THREAD_A)), true);

  // The thread's own ConversationState instance and its +1e9 seqs are byte-for-byte unchanged.
  assert.strictEqual(reg.getState(shadowKey(THREAD_A, 'bob')), before);
  assert.deepEqual(before.messages.map((m) => m.seq), [1_000_000_001]);
});

test('markSurfaceVisible is idempotent and does not duplicate the surface entry (3.2)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_001, 'hi'), THREAD_A));
  reg.markSurfaceVisible(THREAD_A);
  reg.markSurfaceVisible(THREAD_A); // second call must be a no-op.
  assert.equal(reg.listSurfaceConversations().length, 1);
});

test('markSurfaceVisible is a safe no-op for the inviter / an unopened thread (never surfaces it) (3.2)', () => {
  const reg = new DefaultConversationRegistry();
  // The inviter never calls markSurfaceVisible after opening as merged; here the thread is unknown.
  reg.markSurfaceVisible(THREAD_A);
  assert.deepEqual(reg.listSurfaceConversations(), []);
  // It also did not conjure a thread: an inbound event for it is still rejected as unknown.
  assert.throws(
    () => reg.apply(appended('bob', inMsg(1_000_000_001, 'x'), THREAD_A)),
    UnknownShadowThreadError,
  );
});

test('clearThread empties one shadow thread, leaves other shadow threads and surface intact, thread stays routable (6.3, 6.4, 7.4)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.openShadowThread(THREAD_B, 'carol');

  reg.apply(appended('bob', outMsg(1, 'surface bob')));
  reg.apply(appended('bob', outMsg(1_000_000_001, 'shadow a1'), THREAD_A));
  reg.apply({ type: 'timer-changed', ttlMs: 60_000, remoteUid: 'bob', threadId: THREAD_A });
  reg.apply(appended('carol', outMsg(1_000_000_001, 'shadow b1'), THREAD_B));

  reg.clearThread(THREAD_A);

  // Thread A is emptied — no messages, no gap markers, timer reset.
  const clearedA = reg.getState(shadowKey(THREAD_A, 'bob'));
  assert.deepEqual(clearedA.messages, []);
  assert.deepEqual(clearedA.missingBefore, []);
  assert.equal(clearedA.disappearingTtlMs, 0);

  // Other shadow thread and the surface chat are untouched.
  assert.deepEqual(
    reg.getState(shadowKey(THREAD_B, 'carol')).messages.map((m) => m.text),
    ['shadow b1'],
  );
  assert.deepEqual(reg.getState(surfaceKey('bob')).messages.map((m) => m.text), ['surface bob']);

  // Still routable: a new event on the same threadId is accepted (no UnknownShadowThreadError).
  assert.doesNotThrow(() =>
    reg.apply(appended('bob', outMsg(1_000_000_002, 'after clear'), THREAD_A)),
  );
  assert.deepEqual(
    reg.getState(shadowKey(THREAD_A, 'bob')).messages.map((m) => m.text),
    ['after clear'],
  );
});

test('clearThread is idempotent and a no-op for an unknown/closed thread (6.3)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_001, 'hi'), THREAD_A));
  reg.clearThread(THREAD_A);
  reg.clearThread(THREAD_A); // second clear on an already-empty thread: no-op.
  assert.deepEqual(reg.getState(shadowKey(THREAD_A, 'bob')).messages, []);
  // Unknown thread: no throw, no surface side effects.
  assert.doesNotThrow(() => reg.clearThread(THREAD_B));
});

test('closeThread removes the thread; a later event for it throws UnknownShadowThreadError (6.4, 7.4)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_001, 'hi'), THREAD_A));

  reg.closeThread(THREAD_A);

  // A subsequent INBOUND event for the now-closed thread is rejected exactly as an unknown thread.
  assert.throws(
    () => reg.apply(appended('bob', inMsg(1_000_000_002, 'after close'), THREAD_A)),
    UnknownShadowThreadError,
  );
});

test('closeThread is scoped — other shadow threads and the surface chat are intact (6.4)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.openShadowThread(THREAD_B, 'carol');
  reg.apply(appended('bob', outMsg(1, 'surface bob')));
  reg.apply(appended('bob', outMsg(1_000_000_001, 'a1'), THREAD_A));
  reg.apply(appended('carol', outMsg(1_000_000_001, 'b1'), THREAD_B));

  reg.closeThread(THREAD_A);

  assert.deepEqual(
    reg.getState(shadowKey(THREAD_B, 'carol')).messages.map((m) => m.text),
    ['b1'],
  );
  assert.deepEqual(reg.getState(surfaceKey('bob')).messages.map((m) => m.text), ['surface bob']);
});

test('closeThread also clears any surface-visible override and is idempotent (6.4)', () => {
  const reg = new DefaultConversationRegistry();
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_001, 'merged'), THREAD_A));
  reg.markSurfaceVisible(THREAD_A);
  assert.equal(reg.listSurfaceConversations().length, 1);

  reg.closeThread(THREAD_A);
  // Override dropped with the thread → no surface entry remains.
  assert.deepEqual(reg.listSurfaceConversations(), []);
  // Closing again (unknown/closed) is a no-op.
  assert.doesNotThrow(() => reg.closeThread(THREAD_A));

  // Re-opening as merged does NOT inherit the stale override automatically: it must be re-marked.
  reg.openShadowThread(THREAD_A, 'bob');
  reg.apply(appended('bob', outMsg(1_000_000_005, 'fresh'), THREAD_A));
  assert.deepEqual(reg.listSurfaceConversations(), []);
});
