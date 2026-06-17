import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decodeContentPayload,
  encodeContentPayload,
  type ContentPayload,
} from './content-payload';

/**
 * Tests for the versioned E2E content payload (Phase 2, Requirement 3). Covers round-trip
 * fidelity, backward compatibility with Phase 1 bare-string plaintext, forward compatibility
 * with unknown types, and total (never-throws) decoding of malformed input (Req 3.4/3.5, C1).
 */

const roundTrip = (p: ContentPayload): ContentPayload =>
  decodeContentPayload(encodeContentPayload(p));

test('text payload round-trips', () => {
  assert.deepEqual(roundTrip({ type: 'text', body: 'hello 🔐' }), { type: 'text', body: 'hello 🔐' });
});

test('view-once text payload round-trips with the flag (Req 4.3)', () => {
  assert.deepEqual(roundTrip({ type: 'text', body: 'secret', viewOnce: true }), {
    type: 'text',
    body: 'secret',
    viewOnce: true,
  });
});

test('a plain text payload decodes without a viewOnce flag', () => {
  // No viewOnce key on a normal message — the field is absent, not `false`.
  assert.deepEqual(decodeContentPayload(encodeContentPayload({ type: 'text', body: 'hi' })), {
    type: 'text',
    body: 'hi',
  });
});

test('reaction payload round-trips', () => {
  const p: ContentPayload = { type: 'reaction', targetSeq: 7, targetOutbound: true, emoji: '👍' };
  assert.deepEqual(roundTrip(p), p);
});

test('edit payload round-trips', () => {
  const p: ContentPayload = { type: 'edit', targetSeq: 3, targetOutbound: true, body: 'fixed typo' };
  assert.deepEqual(roundTrip(p), p);
});

test('delete payload round-trips', () => {
  const p: ContentPayload = { type: 'delete', targetSeq: 9, targetOutbound: true };
  assert.deepEqual(roundTrip(p), p);
});

test('timer payload round-trips', () => {
  const p: ContentPayload = { type: 'timer', ttlMs: 86_400_000 };
  assert.deepEqual(roundTrip(p), p);
});

test('timer with ttlMs 0 (disable) round-trips', () => {
  const p: ContentPayload = { type: 'timer', ttlMs: 0 };
  assert.deepEqual(roundTrip(p), p);
});

test('timer with a negative ttl is unsupported', () => {
  const bad = JSON.stringify({ v: 1, type: 'timer', ttlMs: -5 });
  assert.deepEqual(decodeContentPayload(bad), { type: 'unsupported' });
});

test('legacy bare-string plaintext decodes as text (back-compat)', () => {
  assert.deepEqual(decodeContentPayload('just plain text'), { type: 'text', body: 'just plain text' });
});

test('a user typing JSON on a legacy client is treated as text, not a command', () => {
  // No {v:1} envelope → must be treated as literal text, never as a delete/edit.
  const typed = '{"foo":"bar"}';
  assert.deepEqual(decodeContentPayload(typed), { type: 'text', body: typed });
});

test('non-JSON garbage decodes as text (never throws)', () => {
  assert.deepEqual(decodeContentPayload('}{not json'), { type: 'text', body: '}{not json' });
});

test('unknown future type decodes as unsupported (forward-compat)', () => {
  const future = JSON.stringify({ v: 1, type: 'poll', options: ['a', 'b'] });
  assert.deepEqual(decodeContentPayload(future), { type: 'unsupported' });
});

test('malformed reaction (missing emoji) decodes as unsupported, not a crash', () => {
  const bad = JSON.stringify({ v: 1, type: 'reaction', targetSeq: 1, targetOutbound: true });
  assert.deepEqual(decodeContentPayload(bad), { type: 'unsupported' });
});

test('reaction with non-integer targetSeq is unsupported', () => {
  const bad = JSON.stringify({ v: 1, type: 'reaction', targetSeq: 1.5, targetOutbound: true, emoji: '👍' });
  assert.deepEqual(decodeContentPayload(bad), { type: 'unsupported' });
});

test('a different version is treated as text (cannot misparse another schema)', () => {
  const v2 = JSON.stringify({ v: 2, type: 'delete', targetSeq: 1 });
  assert.deepEqual(decodeContentPayload(v2), { type: 'text', body: v2 });
});
