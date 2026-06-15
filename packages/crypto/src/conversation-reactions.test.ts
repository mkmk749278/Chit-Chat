import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
  type ConversationState,
  type RenderableMessage,
} from './conversation-reducer';

/**
 * Tests for reaction / edit / delete handling in the shared reducer (Phase 2, Requirement 3).
 * The reducer addresses targets by their LOCAL (direction, seq); these prove apply + ignore
 * semantics and that an unknown target is a no-op (Req 3.5).
 */

const inbound = (seq: number, text = `m${seq}`): ConversationEvent => ({
  type: 'message-appended',
  message: { id: `in-${seq}`, seq, direction: 'in', text, status: 'received' },
});

const outbound = (seq: number, text = `s${seq}`): ConversationEvent => ({
  type: 'message-appended',
  message: { id: `out-${seq}`, seq, direction: 'out', text, status: 'sent' },
});

const apply = (events: ConversationEvent[]): ConversationState =>
  events.reduce(reduce, initialConversationState('mobile'));

const find = (s: ConversationState, dir: 'in' | 'out', seq: number): RenderableMessage | undefined =>
  s.messages.find((m) => m.direction === dir && m.seq === seq);

test('a reaction attaches an emoji to the target message', () => {
  const s = apply([inbound(1), { type: 'reaction-applied', targetDirection: 'in', targetSeq: 1, emoji: '👍' }]);
  assert.deepEqual(find(s, 'in', 1)?.reactions, ['👍']);
});

test('reactions dedupe; distinct emojis accumulate', () => {
  const s = apply([
    outbound(1),
    { type: 'reaction-applied', targetDirection: 'out', targetSeq: 1, emoji: '👍' },
    { type: 'reaction-applied', targetDirection: 'out', targetSeq: 1, emoji: '👍' },
    { type: 'reaction-applied', targetDirection: 'out', targetSeq: 1, emoji: '🔥' },
  ]);
  assert.deepEqual(find(s, 'out', 1)?.reactions, ['👍', '🔥']);
});

test('an edit supersedes the text and marks the message edited', () => {
  const s = apply([
    inbound(1, 'helo'),
    { type: 'message-edited', targetDirection: 'in', targetSeq: 1, body: 'hello' },
  ]);
  const m = find(s, 'in', 1);
  assert.equal(m?.text, 'hello');
  assert.equal(m?.edited, true);
});

test('a delete tombstones the message (null text, deleted flag, reactions cleared)', () => {
  const s = apply([
    outbound(1),
    { type: 'reaction-applied', targetDirection: 'out', targetSeq: 1, emoji: '👍' },
    { type: 'message-deleted', targetDirection: 'out', targetSeq: 1 },
  ]);
  const m = find(s, 'out', 1);
  assert.equal(m?.text, null);
  assert.equal(m?.deleted, true);
  assert.equal(m?.reactions, undefined);
});

test('a deleted message rejects later edits and reactions', () => {
  const s = apply([
    inbound(1, 'secret'),
    { type: 'message-deleted', targetDirection: 'in', targetSeq: 1 },
    { type: 'message-edited', targetDirection: 'in', targetSeq: 1, body: 'resurrected' },
    { type: 'reaction-applied', targetDirection: 'in', targetSeq: 1, emoji: '👍' },
  ]);
  const m = find(s, 'in', 1);
  assert.equal(m?.text, null);
  assert.equal(m?.deleted, true);
  assert.equal(m?.reactions, undefined);
});

test('reaction/edit/delete for an unknown target are no-ops (Req 3.5)', () => {
  const base = apply([inbound(1)]);
  const r = reduce(base, { type: 'reaction-applied', targetDirection: 'in', targetSeq: 99, emoji: '👍' });
  const e = reduce(base, { type: 'message-edited', targetDirection: 'out', targetSeq: 99, body: 'x' });
  const d = reduce(base, { type: 'message-deleted', targetDirection: 'in', targetSeq: 99 });
  // Message list is structurally unchanged (same reference returned by the no-op path).
  assert.equal(r.messages, base.messages);
  assert.equal(e.messages, base.messages);
  assert.equal(d.messages, base.messages);
});

test('direction matters: a reaction to in:1 does not touch out:1', () => {
  const s = apply([
    inbound(1),
    outbound(1),
    { type: 'reaction-applied', targetDirection: 'in', targetSeq: 1, emoji: '👍' },
  ]);
  assert.deepEqual(find(s, 'in', 1)?.reactions, ['👍']);
  assert.equal(find(s, 'out', 1)?.reactions, undefined);
});

test('plain appended messages carry no reaction/edit/delete fields', () => {
  const s = apply([inbound(1)]);
  const m = find(s, 'in', 1)!;
  assert.equal('reactions' in m, false);
  assert.equal('edited' in m, false);
  assert.equal('deleted' in m, false);
});
