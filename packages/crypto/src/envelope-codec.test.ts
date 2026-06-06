import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CiphertextBody, EnvelopeRouting } from '@chat-app/types';

import { createEnvelopeCodec } from './envelope-codec';

const routing = (overrides: Partial<EnvelopeRouting> = {}): EnvelopeRouting => ({
  senderUid: 'alice',
  recipientUid: 'bob',
  senderDeviceId: 'dev-alice',
  seq: 42,
  ...overrides,
});

const body = (overrides: Partial<CiphertextBody> = {}): CiphertextBody => ({
  type: 3,
  ciphertext: Buffer.from('opaque-ciphertext').toString('base64'),
  ...overrides,
});

// Feature: phase1-client-messaging, Property 2: Envelope codec round-trip.

test('decode(encode(r, b)) returns the original routing and body (Property 2)', () => {
  const codec = createEnvelopeCodec();
  const r = routing();
  const b = body();

  const decoded = codec.decode(codec.encode(r, b));

  assert.deepEqual(decoded.routing, r);
  assert.deepEqual(decoded.body, b);
});

test('round-trip preserves both libsignal message types', () => {
  const codec = createEnvelopeCodec();
  for (const type of [1, 3] as const) {
    const b = body({ type });
    const decoded = codec.decode(codec.encode(routing(), b));
    assert.equal(decoded.body.type, type);
  }
});

// Feature: phase1-client-messaging, Property 3: No plaintext on the wire.

test('encode copies only the named routing + body fields — no foreign field rides along (Property 3)', () => {
  const codec = createEnvelopeCodec();
  // Smuggle a "plaintext" property onto the inputs; the codec must not carry it through.
  const r = { ...routing(), plaintext: 'SECRET' } as unknown as EnvelopeRouting;
  const b = { ...body(), plaintext: 'SECRET' } as unknown as CiphertextBody;

  const envelope = codec.encode(r, b);

  assert.deepEqual(Object.keys(envelope).sort(), [
    'ciphertext',
    'recipientUid',
    'senderDeviceId',
    'senderUid',
    'seq',
    'type',
  ]);
  assert.ok(!('plaintext' in envelope));
  assert.ok(!JSON.stringify(envelope).includes('SECRET'));
});

test('the serialized envelope carries only the opaque base64 ciphertext, never message text', () => {
  const codec = createEnvelopeCodec();
  const ciphertext = Buffer.from('hello-encrypted-bytes').toString('base64');
  const envelope = codec.encode(routing(), body({ ciphertext }));
  const serialized = JSON.stringify(envelope);
  assert.ok(serialized.includes(ciphertext));
  assert.ok(!serialized.includes('hello-encrypted-bytes'));
});

test('encode/decode do not mutate their inputs', () => {
  const codec = createEnvelopeCodec();
  const r = routing();
  const b = body();
  const rCopy = { ...r };
  const bCopy = { ...b };
  const envelope = codec.encode(r, b);
  codec.decode(envelope);
  assert.deepEqual(r, rCopy);
  assert.deepEqual(b, bCopy);
});
