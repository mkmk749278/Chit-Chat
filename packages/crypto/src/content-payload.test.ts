import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CONTENT_PAYLOAD_VERSION,
  decodeContentPayload,
  encodeContentPayload,
  type ContentPayload,
} from './content-payload';

/**
 * Tests for the versioned E2E content payload (Phase 2, Requirement 3; Shadow Chat, Req 5/6).
 * Covers round-trip fidelity, backward compatibility with Phase 1 bare-string plaintext, forward
 * compatibility with unknown types, total (never-throws) decoding of malformed input (Req 3.4/3.5,
 * C1), and the additive optional shadow `threadId` (Shadow Chat Req 5.1, 5.3, 6.1–6.5).
 */

const roundTrip = (p: ContentPayload): ContentPayload =>
  decodeContentPayload(encodeContentPayload(p)).payload;

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
  assert.deepEqual(decodeContentPayload(encodeContentPayload({ type: 'text', body: 'hi' })).payload, {
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

test('attachment payload round-trips (with and without a name) (Req 7)', () => {
  const withName: ContentPayload = {
    type: 'attachment',
    blobId: 'blob-123',
    key: Buffer.from('k').toString('base64'),
    iv: Buffer.from('iv').toString('base64'),
    mediaType: 'image/jpeg',
    size: 4096,
    name: 'photo.jpg',
  };
  assert.deepEqual(roundTrip(withName), withName);

  const noName: ContentPayload = {
    type: 'attachment',
    blobId: 'b',
    key: 'aaa',
    iv: 'bbb',
    mediaType: 'application/octet-stream',
    size: 0,
  };
  assert.deepEqual(roundTrip(noName), noName);
});

test('an attachment payload missing required fields decodes as unsupported', () => {
  const bad = JSON.stringify({ v: 1, type: 'attachment', blobId: 'b', key: 'k' }); // no iv/mediaType/size
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

test('timer with ttlMs 0 (disable) round-trips', () => {
  const p: ContentPayload = { type: 'timer', ttlMs: 0 };
  assert.deepEqual(roundTrip(p), p);
});

test('timer with a negative ttl is unsupported', () => {
  const bad = JSON.stringify({ v: 1, type: 'timer', ttlMs: -5 });
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

test('legacy bare-string plaintext decodes as text (back-compat)', () => {
  assert.deepEqual(decodeContentPayload('just plain text').payload, {
    type: 'text',
    body: 'just plain text',
  });
});

test('a user typing JSON on a legacy client is treated as text, not a command', () => {
  // No {v:1} envelope → must be treated as literal text, never as a delete/edit.
  const typed = '{"foo":"bar"}';
  assert.deepEqual(decodeContentPayload(typed).payload, { type: 'text', body: typed });
});

test('non-JSON garbage decodes as text (never throws)', () => {
  assert.deepEqual(decodeContentPayload('}{not json').payload, { type: 'text', body: '}{not json' });
});

test('unknown future type decodes as unsupported (forward-compat)', () => {
  const future = JSON.stringify({ v: 1, type: 'poll', options: ['a', 'b'] });
  assert.deepEqual(decodeContentPayload(future).payload, { type: 'unsupported' });
});

test('malformed reaction (missing emoji) decodes as unsupported, not a crash', () => {
  const bad = JSON.stringify({ v: 1, type: 'reaction', targetSeq: 1, targetOutbound: true });
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

test('reaction with non-integer targetSeq is unsupported', () => {
  const bad = JSON.stringify({ v: 1, type: 'reaction', targetSeq: 1.5, targetOutbound: true, emoji: '👍' });
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

test('a different version is treated as text (cannot misparse another schema)', () => {
  const v2 = JSON.stringify({ v: 2, type: 'delete', targetSeq: 1 });
  assert.deepEqual(decodeContentPayload(v2).payload, { type: 'text', body: v2 });
});

test('verify-request round-trips and rejects an empty seed', () => {
  const enc = encodeContentPayload({ type: 'verify-request', seed: 'c2VlZA==' });
  assert.deepEqual(decodeContentPayload(enc).payload, { type: 'verify-request', seed: 'c2VlZA==' });
  const bad = JSON.stringify({ v: 1, type: 'verify-request', seed: '' });
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

test('verify-response round-trips and rejects a missing code', () => {
  const enc = encodeContentPayload({ type: 'verify-response', code: '123456' });
  assert.deepEqual(decodeContentPayload(enc).payload, { type: 'verify-response', code: '123456' });
  const bad = JSON.stringify({ v: 1, type: 'verify-response' });
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

test('verify-result round-trips both outcomes; non-boolean ok is unsupported', () => {
  assert.deepEqual(decodeContentPayload(encodeContentPayload({ type: 'verify-result', ok: true })).payload, {
    type: 'verify-result',
    ok: true,
  });
  assert.deepEqual(decodeContentPayload(encodeContentPayload({ type: 'verify-result', ok: false })).payload, {
    type: 'verify-result',
    ok: false,
  });
  const bad = JSON.stringify({ v: 1, type: 'verify-result', ok: 'yes' });
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

test('duress-alert round-trips and rejects an empty peerUid', () => {
  const enc = encodeContentPayload({ type: 'duress-alert', peerUid: 'bob' });
  assert.deepEqual(decodeContentPayload(enc).payload, { type: 'duress-alert', peerUid: 'bob' });
  const bad = JSON.stringify({ v: 1, type: 'duress-alert', peerUid: '' });
  assert.deepEqual(decodeContentPayload(bad).payload, { type: 'unsupported' });
});

// ---------------------------------------------------------------------------
// Shadow Chat: optional, backward-compatible `threadId` (Req 5.1, 5.3, 6.1–6.5).
// ---------------------------------------------------------------------------

/**
 * The pre-shadow encoder, reproduced verbatim. Any divergence between this and
 * `encodeContentPayload(p)` (no threadId) is a backward-compatibility regression (Property 6).
 */
const legacyEncode = (p: ContentPayload): string =>
  JSON.stringify({ v: CONTENT_PAYLOAD_VERSION, ...p });

/** One representative value of every `ContentPayload` discriminant, for exhaustive coverage. */
const representativePayloads: ContentPayload[] = [
  { type: 'text', body: 'hello 🔐' },
  { type: 'text', body: 'secret', viewOnce: true },
  { type: 'reaction', targetSeq: 7, targetOutbound: true, emoji: '👍' },
  { type: 'edit', targetSeq: 3, targetOutbound: false, body: 'fixed typo' },
  { type: 'delete', targetSeq: 9, targetOutbound: true },
  { type: 'timer', ttlMs: 0 },
  { type: 'timer', ttlMs: 86_400_000 },
  {
    type: 'attachment',
    blobId: 'blob-123',
    key: 'a2V5',
    iv: 'aXY=',
    mediaType: 'image/jpeg',
    size: 4096,
    name: 'photo.jpg',
  },
  { type: 'attachment', blobId: 'b', key: 'aaa', iv: 'bbb', mediaType: 'application/octet-stream', size: 0 },
  { type: 'verify-request', seed: 'c2VlZA==' },
  { type: 'verify-response', code: '123456' },
  { type: 'verify-result', ok: true },
  { type: 'duress-alert', peerUid: 'bob' },
  { type: 'unsupported' },
];

test('encode with no threadId is byte-for-byte identical to the legacy encoder, for every type (Req 5.1)', () => {
  for (const p of representativePayloads) {
    assert.equal(
      encodeContentPayload(p),
      legacyEncode(p),
      `encode mismatch for payload type "${p.type}"`,
    );
  }
});

test('decode of a no-threadId envelope reports threadId absent and recovers the payload (Req 6.3)', () => {
  for (const p of representativePayloads) {
    const decoded = decodeContentPayload(encodeContentPayload(p));
    assert.equal(decoded.threadId, undefined, `unexpected threadId for type "${p.type}"`);
    assert.ok(!('threadId' in decoded) || decoded.threadId === undefined);
    // `unsupported` is never produced by encoding a real payload of a known type, but the rest
    // must round-trip the payload exactly.
    if (p.type !== 'unsupported') {
      assert.deepEqual(decoded.payload, p);
    }
  }
});

test('round-trips payload + threadId for non-empty ids of 1..255 chars (Req 6.1, 6.2)', () => {
  const ids = ['a', 'x'.repeat(64), 'f0'.repeat(64), '/contact1', 'z'.repeat(255)];
  for (const threadId of ids) {
    for (const p of representativePayloads) {
      if (p.type === 'unsupported') continue;
      const decoded = decodeContentPayload(encodeContentPayload(p, threadId));
      assert.deepEqual(decoded.payload, p, `payload mismatch for id length ${threadId.length}`);
      assert.equal(decoded.threadId, threadId, `threadId mismatch for length ${threadId.length}`);
    }
  }
});

test('encode includes the threadId verbatim inside the envelope, leaving v + fields intact (Req 6.1)', () => {
  const encoded = encodeContentPayload({ type: 'text', body: 'hi' }, 'thread-xyz');
  const parsed = JSON.parse(encoded) as Record<string, unknown>;
  assert.equal(parsed.v, CONTENT_PAYLOAD_VERSION);
  assert.equal(parsed.type, 'text');
  assert.equal(parsed.body, 'hi');
  assert.equal(parsed.threadId, 'thread-xyz');
});

test('an empty-string threadId is not emitted by encode (stays byte-for-byte legacy) (Req 5.1)', () => {
  assert.equal(encodeContentPayload({ type: 'text', body: 'hi' }, ''), legacyEncode({ type: 'text', body: 'hi' }));
});

test('a threadId longer than 255 chars is not emitted by encode (Req 6.4)', () => {
  const tooLong = 'x'.repeat(256);
  assert.equal(
    encodeContentPayload({ type: 'text', body: 'hi' }, tooLong),
    legacyEncode({ type: 'text', body: 'hi' }),
  );
});

test('decode falls back to surface (threadId undefined) for omitted/empty/non-string/over-255 (Req 6.4)', () => {
  const base = { v: CONTENT_PAYLOAD_VERSION, type: 'text', body: 'hi' } as const;
  const cases: unknown[] = [
    {}, // omitted
    '', // empty string
    null,
    123, // non-string
    true,
    { nested: 'object' },
    ['array'],
    'x'.repeat(256), // over 255
  ];
  for (const threadId of cases) {
    const raw = JSON.stringify({ ...base, ...(threadId === undefined ? {} : { threadId }) });
    const decoded = decodeContentPayload(raw);
    assert.equal(decoded.threadId, undefined, `expected surface fallback for ${JSON.stringify(threadId)}`);
    assert.deepEqual(decoded.payload, { type: 'text', body: 'hi' });
  }
});

test('a threadId of exactly 255 chars is accepted; 256 is rejected (boundary, Req 6.1/6.4)', () => {
  const at = 'a'.repeat(255);
  const over = 'a'.repeat(256);
  assert.equal(decodeContentPayload(JSON.stringify({ v: 1, type: 'text', body: 'b', threadId: at })).threadId, at);
  assert.equal(
    decodeContentPayload(JSON.stringify({ v: 1, type: 'text', body: 'b', threadId: over })).threadId,
    undefined,
  );
});

test('per-type validation outcome is identical whether or not threadId is present (Req 6.5)', () => {
  // A malformed reaction must decode as `unsupported` regardless of an accompanying threadId.
  const badReactionNoThread = JSON.stringify({ v: 1, type: 'reaction', targetSeq: 1, targetOutbound: true });
  const badReactionWithThread = JSON.stringify({
    v: 1,
    type: 'reaction',
    targetSeq: 1,
    targetOutbound: true,
    threadId: 'thread-1',
  });
  assert.deepEqual(decodeContentPayload(badReactionNoThread).payload, { type: 'unsupported' });
  assert.deepEqual(decodeContentPayload(badReactionWithThread).payload, { type: 'unsupported' });

  // A valid reaction must decode identically (in `payload`) with or without a threadId.
  const okNoThread = JSON.stringify({ v: 1, type: 'reaction', targetSeq: 2, targetOutbound: false, emoji: '🎉' });
  const okWithThread = JSON.stringify({
    v: 1,
    type: 'reaction',
    targetSeq: 2,
    targetOutbound: false,
    emoji: '🎉',
    threadId: 'thread-2',
  });
  assert.deepEqual(decodeContentPayload(okNoThread).payload, decodeContentPayload(okWithThread).payload);
  assert.equal(decodeContentPayload(okWithThread).threadId, 'thread-2');
});
