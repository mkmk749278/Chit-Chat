import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as Signal from '@signalapp/libsignal-client';

import { createEnvelopeCodec } from './envelope-codec';

/**
 * Real libsignal session round-trip (Property 1; task 2.15).
 *
 * Unlike the rest of the crypto suite — which keeps the native binding behind the
 * injected `LibsignalEngine` port so it stays platform-agnostic — this test exercises
 * the REAL `@signalapp/libsignal-client` native library end-to-end, proving the actual
 * cryptography (not a stub) round-trips. It establishes a session from a published
 * prekey bundle, exchanges messages in both directions, and persists session state
 * (serialize → deserialize) between every step, validating Requirements 5.1, 5.2, 5.4,
 * 5.8. It also routes each ciphertext through the shared `EnvelopeCodec` wire frame to
 * confirm the envelope carries the libsignal ciphertext faithfully (Requirement 5.3).
 *
 * The in-memory stores below are the standard libsignal store pattern; the production
 * platform adapters (SQLCipher on mobile, in-memory on web) back the same store surface.
 */

type Address = Signal.ProtocolAddress;

class InMemorySessionStore extends Signal.SessionStore {
  private readonly records = new Map<string, Buffer>();
  async saveSession(name: Address, record: Signal.SessionRecord): Promise<void> {
    this.records.set(name.toString(), record.serialize());
  }
  async getSession(name: Address): Promise<Signal.SessionRecord | null> {
    const bytes = this.records.get(name.toString());
    return bytes !== undefined ? Signal.SessionRecord.deserialize(bytes) : null;
  }
  async getExistingSessions(addresses: Address[]): Promise<Signal.SessionRecord[]> {
    return addresses.map((address) => {
      const bytes = this.records.get(address.toString());
      if (bytes === undefined) {
        throw new Error(`no session for ${address.toString()}`);
      }
      return Signal.SessionRecord.deserialize(bytes);
    });
  }
}

class InMemoryIdentityStore extends Signal.IdentityKeyStore {
  private readonly identities = new Map<string, Buffer>();
  constructor(
    private readonly keyPair: Signal.IdentityKeyPair,
    private readonly registrationId: number,
  ) {
    super();
  }
  async getIdentityKey(): Promise<Signal.PrivateKey> {
    return this.keyPair.privateKey;
  }
  async getLocalRegistrationId(): Promise<number> {
    return this.registrationId;
  }
  async saveIdentity(name: Address, key: Signal.PublicKey): Promise<boolean> {
    this.identities.set(name.toString(), key.serialize());
    return false;
  }
  async isTrustedIdentity(): Promise<boolean> {
    // Trust-on-first-use for this slice (the design defers verification UI).
    return true;
  }
  async getIdentity(name: Address): Promise<Signal.PublicKey | null> {
    const bytes = this.identities.get(name.toString());
    return bytes !== undefined ? Signal.PublicKey.deserialize(bytes) : null;
  }
}

class InMemoryPreKeyStore extends Signal.PreKeyStore {
  private readonly records = new Map<number, Buffer>();
  async savePreKey(id: number, record: Signal.PreKeyRecord): Promise<void> {
    this.records.set(id, record.serialize());
  }
  async getPreKey(id: number): Promise<Signal.PreKeyRecord> {
    const bytes = this.records.get(id);
    if (bytes === undefined) {
      throw new Error(`no prekey ${id}`);
    }
    return Signal.PreKeyRecord.deserialize(bytes);
  }
  async removePreKey(id: number): Promise<void> {
    this.records.delete(id);
  }
  has(id: number): boolean {
    return this.records.has(id);
  }
}

class InMemorySignedPreKeyStore extends Signal.SignedPreKeyStore {
  private readonly records = new Map<number, Buffer>();
  async saveSignedPreKey(id: number, record: Signal.SignedPreKeyRecord): Promise<void> {
    this.records.set(id, record.serialize());
  }
  async getSignedPreKey(id: number): Promise<Signal.SignedPreKeyRecord> {
    const bytes = this.records.get(id);
    if (bytes === undefined) {
      throw new Error(`no signed prekey ${id}`);
    }
    return Signal.SignedPreKeyRecord.deserialize(bytes);
  }
}

class InMemoryKyberPreKeyStore extends Signal.KyberPreKeyStore {
  private readonly records = new Map<number, Buffer>();
  async saveKyberPreKey(id: number, record: Signal.KyberPreKeyRecord): Promise<void> {
    this.records.set(id, record.serialize());
  }
  async getKyberPreKey(id: number): Promise<Signal.KyberPreKeyRecord> {
    const bytes = this.records.get(id);
    if (bytes === undefined) {
      throw new Error(`no kyber prekey ${id}`);
    }
    return Signal.KyberPreKeyRecord.deserialize(bytes);
  }
  async markKyberPreKeyUsed(): Promise<void> {
    // No-op: this slice does not use Kyber/PQXDH prekeys.
  }
}

interface Party {
  identity: InMemoryIdentityStore;
  sessions: InMemorySessionStore;
  preKeys: InMemoryPreKeyStore;
  signedPreKeys: InMemorySignedPreKeyStore;
  kyberPreKeys: InMemoryKyberPreKeyStore;
}

function newParty(registrationId: number): Party {
  return {
    identity: new InMemoryIdentityStore(Signal.IdentityKeyPair.generate(), registrationId),
    sessions: new InMemorySessionStore(),
    preKeys: new InMemoryPreKeyStore(),
    signedPreKeys: new InMemorySignedPreKeyStore(),
    kyberPreKeys: new InMemoryKyberPreKeyStore(),
  };
}

const PREKEY_ID = 31337;
const SIGNED_PREKEY_ID = 22;

/** Publish a classic (non-Kyber) prekey bundle for `party`, populating its stores. */
async function publishBundle(party: Party): Promise<Signal.PreKeyBundle> {
  const identityKeyPair = await partyIdentityKeyPair(party);
  const reg = await party.identity.getLocalRegistrationId();

  const preKeyPair = Signal.PrivateKey.generate();
  await party.preKeys.savePreKey(
    PREKEY_ID,
    Signal.PreKeyRecord.new(PREKEY_ID, preKeyPair.getPublicKey(), preKeyPair),
  );

  const signedPair = Signal.PrivateKey.generate();
  const signature = identityKeyPair.privateKey.sign(signedPair.getPublicKey().serialize());
  await party.signedPreKeys.saveSignedPreKey(
    SIGNED_PREKEY_ID,
    Signal.SignedPreKeyRecord.new(SIGNED_PREKEY_ID, 0, signedPair.getPublicKey(), signedPair, signature),
  );

  return Signal.PreKeyBundle.new(
    reg,
    1,
    PREKEY_ID,
    preKeyPair.getPublicKey(),
    SIGNED_PREKEY_ID,
    signedPair.getPublicKey(),
    signature,
    identityKeyPair.publicKey,
  );
}

/** Recover a party's identity key pair (the store only exposes the private half). */
async function partyIdentityKeyPair(party: Party): Promise<Signal.IdentityKeyPair> {
  const priv = await party.identity.getIdentityKey();
  return new Signal.IdentityKeyPair(priv.getPublicKey(), priv);
}

const codec = createEnvelopeCodec();

/** Encrypt `plaintext` from `sender` to `recipientAddr`, returned as a wire envelope. */
async function encryptToEnvelope(
  sender: Party,
  senderUid: string,
  recipientAddr: Address,
  recipientUid: string,
  seq: number,
  plaintext: string,
) {
  const ciphertext = await Signal.signalEncrypt(
    Buffer.from(plaintext, 'utf8'),
    recipientAddr,
    sender.sessions,
    sender.identity,
  );
  // Map libsignal's CiphertextMessageType to the wire `type`: libsignal labels a
  // PreKeySignalMessage 3 and a (whisper) SignalMessage 2, while the wire frame uses
  // 3 = PreKeySignalMessage and 1 = SignalMessage (design "Data Models"). The real
  // engine adapter performs this exact mapping.
  const type: 1 | 3 = ciphertext.type() === 3 ? 3 : 1;
  // Route through the shared wire frame (Requirement 5.3): the envelope carries only
  // routing + the base64 libsignal ciphertext.
  return codec.encode(
    { senderUid, recipientUid, senderDeviceId: '1', seq },
    { type, ciphertext: Buffer.from(ciphertext.serialize()).toString('base64') },
  );
}

/** Decrypt a wire envelope received by `recipient` from `senderAddr`. */
async function decryptEnvelope(
  recipient: Party,
  senderAddr: Address,
  envelope: ReturnType<typeof codec.encode>,
): Promise<string> {
  const { body } = codec.decode(envelope);
  const bytes = Buffer.from(body.ciphertext, 'base64');
  let plain: Buffer;
  if (body.type === 3) {
    const message = Signal.PreKeySignalMessage.deserialize(bytes);
    plain = await Signal.signalDecryptPreKey(
      message,
      senderAddr,
      recipient.sessions,
      recipient.identity,
      recipient.preKeys,
      recipient.signedPreKeys,
      recipient.kyberPreKeys,
    );
  } else {
    const message = Signal.SignalMessage.deserialize(bytes);
    plain = await Signal.signalDecrypt(message, senderAddr, recipient.sessions, recipient.identity);
  }
  return Buffer.from(plain).toString('utf8');
}

// Feature: phase1-client-messaging, Property 1: libsignal session round-trip

test('Property 1: a session established from a bundle round-trips a message (5.1, 5.2, 5.4)', async () => {
  const alice = newParty(5678);
  const bob = newParty(1234);
  const bobAddr = Signal.ProtocolAddress.new('bob', 1);
  const aliceAddr = Signal.ProtocolAddress.new('alice', 1);

  const bundle = await publishBundle(bob);
  await Signal.processPreKeyBundle(bundle, bobAddr, alice.sessions, alice.identity);

  const envelope = await encryptToEnvelope(alice, 'alice', bobAddr, 'bob', 1, 'hello bob 👋');
  assert.equal(envelope.type, 3, 'first message is a PreKeySignalMessage');
  const decrypted = await decryptEnvelope(bob, aliceAddr, envelope);
  assert.equal(decrypted, 'hello bob 👋');
});

test('Property 1: multi-message bidirectional exchange round-trips with persisted state (5.4, 5.8)', async () => {
  const alice = newParty(5678);
  const bob = newParty(1234);
  const bobAddr = Signal.ProtocolAddress.new('bob', 1);
  const aliceAddr = Signal.ProtocolAddress.new('alice', 1);

  const bundle = await publishBundle(bob);
  await Signal.processPreKeyBundle(bundle, bobAddr, alice.sessions, alice.identity);

  // Alice → Bob (PreKeySignalMessage, type 3).
  const m1 = await encryptToEnvelope(alice, 'alice', bobAddr, 'bob', 1, 'm1');
  assert.equal(await decryptEnvelope(bob, aliceAddr, m1), 'm1');

  // Bob → Alice reply, which advances the ratchet so the next Alice→Bob is a whisper.
  const r1 = await encryptToEnvelope(bob, 'bob', aliceAddr, 'alice', 1, 'reply-1');
  assert.equal(await decryptEnvelope(alice, bobAddr, r1), 'reply-1');

  // Alice → Bob again — now a SignalMessage (type 1), proving the established session.
  const m2 = await encryptToEnvelope(alice, 'alice', bobAddr, 'bob', 2, 'm2 with more text');
  assert.equal(m2.type, 1, 'subsequent message is a SignalMessage (whisper)');
  assert.equal(await decryptEnvelope(bob, aliceAddr, m2), 'm2 with more text');

  // One more each way to confirm continued ratcheting over persisted state.
  const r2 = await encryptToEnvelope(bob, 'bob', aliceAddr, 'alice', 2, 'reply-2 🚀');
  assert.equal(await decryptEnvelope(alice, bobAddr, r2), 'reply-2 🚀');
  const m3 = await encryptToEnvelope(alice, 'alice', bobAddr, 'bob', 3, 'm3 final');
  assert.equal(await decryptEnvelope(bob, aliceAddr, m3), 'm3 final');
});

test('Property 1: the one-time prekey is consumed exactly once on first inbound (5.1)', async () => {
  const alice = newParty(5678);
  const bob = newParty(1234);
  const bobAddr = Signal.ProtocolAddress.new('bob', 1);
  const aliceAddr = Signal.ProtocolAddress.new('alice', 1);

  const bundle = await publishBundle(bob);
  assert.equal(bob.preKeys.has(PREKEY_ID), true, 'prekey present before use');

  await Signal.processPreKeyBundle(bundle, bobAddr, alice.sessions, alice.identity);
  const m1 = await encryptToEnvelope(alice, 'alice', bobAddr, 'bob', 1, 'consume my prekey');
  await decryptEnvelope(bob, aliceAddr, m1);

  assert.equal(bob.preKeys.has(PREKEY_ID), false, 'one-time prekey removed after first inbound');
});
