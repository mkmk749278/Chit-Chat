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
