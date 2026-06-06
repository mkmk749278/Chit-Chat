import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canSendComposerText,
  conversationReducer,
  initialConversationState,
  reduce,
  type ConversationState,
  type RenderableMessage,
} from './conversation-reducer';

const out = (seq: number, text: string | null, id = `o${seq}`): RenderableMessage => ({
  id,
  seq,
  direction: 'out',
  text,
  status: 'sending',
});

const inbound = (seq: number, text: string | null, id = `i${seq}`): RenderableMessage => ({
  id,
  seq,
  direction: 'in',
  text,
  status: 'received',
});

// --- initial state -----------------------------------------------------------

test('mobile initial state is not gated (webWarningAcknowledged true)', () => {
  const state = initialConversationState('mobile');
  assert.equal(state.webWarningAcknowledged, true);
  assert.equal(state.connection, 'disconnected');
  assert.deepEqual(state.messages, []);
  assert.deepEqual(state.composer, { text: '', canSend: false });
});

test('web initial state is gated until acknowledgment (7.7, 8.3)', () => {
  const state = initialConversationState('web');
  assert.equal(state.webWarningAcknowledged, false);
});

test('web-warning-acknowledged flips the gate to true', () => {
  const state = reduce(initialConversationState('web'), { type: 'web-warning-acknowledged' });
  assert.equal(state.webWarningAcknowledged, true);
});

// --- composer send-enablement (6.3, 6.4) -------------------------------------

test('canSend is false for empty text', () => {
  assert.equal(canSendComposerText(''), false);
});

test('canSend is false for whitespace-only text (6.4)', () => {
  assert.equal(canSendComposerText('   \t\n  '), false);
});

test('canSend is true for a single non-whitespace character (6.3)', () => {
  assert.equal(canSendComposerText('a'), true);
});

test('canSend is true at the 4096 boundary and false at 4097 (trimmed) (6.3)', () => {
  assert.equal(canSendComposerText('x'.repeat(4096)), true);
  assert.equal(canSendComposerText('x'.repeat(4097)), false);
});

test('length is measured on trimmed text', () => {
  // 4096 real chars plus surrounding whitespace still sends.
  assert.equal(canSendComposerText(`  ${'x'.repeat(4096)}  `), true);
});

test('composer-changed recomputes canSend', () => {
  const state = reduce(initialConversationState('mobile'), {
    type: 'composer-changed',
    text: 'hello',
  });
  assert.deepEqual(state.composer, { text: 'hello', canSend: true });

  const cleared = reduce(state, { type: 'composer-changed', text: '   ' });
  assert.deepEqual(cleared.composer, { text: '   ', canSend: false });
});

// --- connection (6.6) --------------------------------------------------------

test('connection-changed updates the connection indicator', () => {
  const state = reduce(initialConversationState('mobile'), {
    type: 'connection-changed',
    connection: 'connected',
  });
  assert.equal(state.connection, 'connected');
});

// --- dedup + ordering (6.2) --------------------------------------------------

test('messages are ordered ascending by seq regardless of arrival order', () => {
  let state = initialConversationState('mobile');
  for (const seq of [3, 1, 2]) {
    state = reduce(state, { type: 'message-appended', message: out(seq, `m${seq}`) });
  }
  assert.deepEqual(
    state.messages.map((m) => m.seq),
    [1, 2, 3],
  );
});

test('duplicate (direction, seq) replaces rather than duplicates (6.2)', () => {
  let state = initialConversationState('mobile');
  state = reduce(state, { type: 'message-appended', message: out(1, 'first', 'a') });
  state = reduce(state, { type: 'message-appended', message: out(1, 'second', 'b') });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text, 'second');
});

test('inbound and outbound may share a seq without colliding (6.2)', () => {
  let state = initialConversationState('mobile');
  state = reduce(state, { type: 'message-appended', message: out(1, 'sent') });
  state = reduce(state, { type: 'message-appended', message: inbound(1, 'recv') });
  assert.equal(state.messages.length, 2);
  const dirs = state.messages.map((m) => m.direction).sort();
  assert.deepEqual(dirs, ['in', 'out']);
});

// --- status transitions (6.5, 6.8) -------------------------------------------

test('status-updated transitions an existing message and retains its text (6.8)', () => {
  let state = initialConversationState('mobile');
  state = reduce(state, { type: 'message-appended', message: out(1, 'keep me', 'x') });
  state = reduce(state, { type: 'status-updated', id: 'x', status: 'failed' });
  assert.equal(state.messages[0].status, 'failed');
  assert.equal(state.messages[0].text, 'keep me');
});

test('status-updated for an unknown id leaves messages unchanged', () => {
  let state = initialConversationState('mobile');
  state = reduce(state, { type: 'message-appended', message: out(1, 'a', 'x') });
  const next = reduce(state, { type: 'status-updated', id: 'nope', status: 'sent' });
  assert.deepEqual(next.messages, state.messages);
});

// --- inbound delivery error (5.5, 6.9) ---------------------------------------

test('inbound-delivery-error renders a null-text delivery-error entry (6.9)', () => {
  let state = initialConversationState('mobile');
  state = reduce(state, { type: 'inbound-delivery-error', id: 'd1', seq: 5 });
  assert.equal(state.messages.length, 1);
  assert.deepEqual(state.messages[0], {
    id: 'd1',
    seq: 5,
    direction: 'in',
    text: null,
    status: 'delivery-error',
  });
});

// --- purity ------------------------------------------------------------------

test('reduce does not mutate the input state', () => {
  const state = initialConversationState('mobile');
  const frozen: ConversationState = Object.freeze({
    ...state,
    messages: Object.freeze([...state.messages]) as RenderableMessage[],
  });
  // Object.freeze would throw on mutation; a pure reducer must not mutate.
  const next = reduce(frozen, { type: 'message-appended', message: out(1, 'hi') });
  assert.notEqual(next, frozen);
  assert.equal(frozen.messages.length, 0);
});

test('conversationReducer.reduce delegates to the pure function', () => {
  const state = initialConversationState('mobile');
  const next = conversationReducer.reduce(state, {
    type: 'connection-changed',
    connection: 'connected',
  });
  assert.equal(next.connection, 'connected');
});
