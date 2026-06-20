/**
 * `apps/mobile` — persistent, encrypted-at-rest {@link KeyStore} + {@link SignalProtocolStore}.
 *
 * This is the production backing for on-device identity and messaging state, replacing the
 * in-memory shortcut that regenerated the device's identity on every launch. That churn was
 * the documented root cause of "messages sent but never received": with a fresh identity each
 * launch, the recipient accumulated stale device rows and the sender encrypted for a device
 * that was not the one actually connected, so the ciphertext could never be decrypted.
 *
 * Persisting the identity, the server-issued `deviceId`, and the libsignal session state means
 * the device registers ONCE and reuses it across launches ({@link IdentityManager} and
 * {@link DeviceRegistrar} are already idempotent given stored material — Requirements 2.6, 3.7).
 * With exactly one stable device per user, the prekey claim, the relay's recipient lookup, and
 * the live socket all converge on the same device, so delivery is deterministic.
 *
 * Encryption-at-rest (Requirement 10.2): the whole store is serialized to a single JSON
 * document, encrypted with a 64-byte data-encryption key, and written as one opaque blob via
 * the injected {@link BlobStorage} (AsyncStorage on-device). The data-encryption key itself is
 * held in the injected {@link SecureKeyStorage} (the hardware-backed Android Keystore via
 * `expo-secure-store`), so plaintext never touches AsyncStorage. (Binding the key to the user's
 * PIN, per 10.2, is a documented follow-up; the hardware-backed key is in place now.)
 *
 * The module is platform-agnostic: storage, secure storage, and the crypto box all arrive as
 * injected ports, so the persistence logic round-trips under Node in tests and under the RN
 * adapters on-device. Private key material is written ONLY through these ports and is dropped
 * from memory on {@link KeyStore.destroy}; {@link PersistentVault.wipe} additionally erases the
 * on-disk blob and key for sign-out (Requirements 7.1, 7.2, 7.4, 8.1).
 */

import {
  encodePreKeyRecord,
  type IdentityRecord,
  type InvitedThreadRef,
  type KeyStore,
  type MessageRow,
  type OneTimePreKeyRecord,
  type ShadowThreadRef,
  type SignalAddress,
  type SignalProtocolStore,
  type SignedPreKeyRecord,
} from '@chat-app/crypto';
import { Buffer } from 'buffer';

import type { CryptoBox } from './crypto-box';

// ---------------------------------------------------------------------------
// Injected platform ports.
// ---------------------------------------------------------------------------

/** Small, hardware-backed secure key/value storage (Android Keystore via expo-secure-store). */
export interface SecureKeyStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Bulk key/value blob storage (AsyncStorage); values are always encrypted before write. */
export interface BlobStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Dependencies for {@link createPersistentVault}. */
export interface PersistentVaultDeps {
  secure: SecureKeyStorage;
  blob: BlobStorage;
  crypto: CryptoBox;
  /** CSPRNG used to mint the data-encryption key on first use. */
  getRandomValues: <T extends ArrayBufferView>(array: T) => T;
}

// ---------------------------------------------------------------------------
// On-disk document shape (all byte fields base64-encoded so the doc is JSON-safe).
// ---------------------------------------------------------------------------

const DOC_VERSION = 1;

interface SerializedOneTimePreKey {
  keyId: number;
  publicKey: string;
  privateKey: string;
}

interface SerializedSignedPreKey {
  keyId: number;
  publicKey: string;
  privateKey: string;
  signature: string;
}

interface SerializedIdentity {
  uid: string;
  registrationId: number;
  identityKeyPublic: string;
  identityKeyPrivate: string;
  signedPreKey: SerializedSignedPreKey;
  oneTimePreKeys: SerializedOneTimePreKey[];
  createdAt: number;
}

/** Accumulated libsignal store state (sessions, remote identities, remaining prekeys). */
interface SignalSection {
  sessions: Record<string, string>;
  identities: Record<string, string>;
  preKeys: Record<string, string>;
  signedPreKeys: Record<string, string>;
}

/**
 * One persisted shadow alias→thread mapping (Shadow Chat, design Component 6 / Requirement 9.2).
 * `aliasHash` is the opaque HMAC of the normalised alias under the device-local alias key; the
 * plaintext/normalised alias is NEVER stored here. `ref` is the full {@link ShadowThreadRef}
 * (`peerUid`, `threadId`, and any optional `pinVerifier`); it is round-tripped as a whole so a
 * later-added optional field (e.g. the per-chat PIN's hash-only `pinVerifier`) is preserved without
 * a schema change.
 */
interface SerializedAliasEntry {
  aliasHash: string;
  ref: ShadowThreadRef;
}

/**
 * Device-local Shadow Chat Invites record (design "Data Models → InvitedThreadRecord"). The shared
 * 32-byte `threadKey` is base64-encoded so the JSON document is text-safe before AES encryption; the
 * rest of the {@link InvitedThreadRef} (peerUid, threadId, routing, state, inviteId, optional alias /
 * pinVerifier) is stored verbatim. Encrypted at rest like every other vault field; never on the wire.
 */
interface SerializedInvitedThread {
  /** base64-encoded shared 32-byte per-thread key (the HMAC key for this thread's id). */
  threadKey: string;
  /** Every other field of the {@link InvitedThreadRef} except the raw-bytes `threadKey`. */
  ref: Omit<InvitedThreadRef, 'threadKey'>;
}

/**
 * Device-local Shadow Chat secrets and alias mappings (Shadow Chat, design Component 6 /
 * Requirements 9.1, 9.5, 9.7, 9.8, 9.9). The master secret and alias-HMAC key are base64-encoded
 * byte strings; the alias entries are hash-only mappings. Living inside this AES-encrypted vault
 * document means the shadow secrets are encrypted at rest (never an unencrypted location, Req 9.5),
 * survive app restarts (Req 9.8, 9.9), and are never transmitted off-device (Req 9.1). Absent until
 * the shadow feature is provisioned in real-PIN mode.
 */
interface ShadowSecretsSection {
  /** base64-encoded shadow master secret; absent/empty ⇒ not provisioned. */
  masterSecret?: string;
  /** base64-encoded alias-HMAC key; absent/empty ⇒ not provisioned. */
  aliasKey?: string;
  /** Hash-only alias→thread mappings; `[]`/absent ⇒ none bound. */
  aliasEntries?: SerializedAliasEntry[];
  /** Shadow Chat Invites: invited-thread records incl. the shared `threadKey`; `[]`/absent ⇒ none. */
  invitedThreads?: SerializedInvitedThread[];
}

interface VaultDoc {
  version: number;
  identity: SerializedIdentity | null;
  deviceId: string | null;
  sequences: Record<string, number>;
  messages: Record<string, MessageRow>;
  /** Per-conversation disappearing-message timer in ms, keyed by peer uid (Req 4.1). */
  timers: Record<string, number>;
  /** KeyStore-port session blobs (interface completeness; the live ratchet uses `signal`). */
  keyStoreSessions: Record<string, string>;
  /** `null` until seeded from the identity on first use, then accumulates across launches. */
  signal: SignalSection | null;
  /**
   * Salted app-PIN verifiers for the decoy-PIN / duress app state (Signature Feature 4, §6). Stored
   * as PBKDF2 hashes, never plaintext (§6.2 / D8). Absent until the user sets a PIN.
   */
  appPins?: { real?: string; decoy?: string };
  /**
   * Hidden-chat unlock-secret verifiers, keyed by peer uid (Signature Feature 1, §3). Salted PBKDF2
   * hashes; presence of a key marks the chat hidden. Living in the encrypted vault keeps even the
   * existence of a hidden chat off plaintext storage.
   */
  hiddenChats?: Record<string, string>;
  /** Recent failed-unlock timestamps (unix ms) for the rate-limit / lockout policy (§3.1, §6.2). */
  unlockFailures?: number[];
  /**
   * Device-local Shadow Chat secrets + alias→thread mappings (Shadow Chat, design Component 6).
   * Encrypted at rest within this vault document and reused across launches, so a provisioned
   * shadow store survives restarts (Requirements 9.8, 9.9) and never lands in an unencrypted
   * location (Req 9.5). Absent until the feature is provisioned in real-PIN mode.
   */
  shadowSecrets?: ShadowSecretsSection;
  /**
   * Shadow Chat Invites device-local row→thread association (Req 14): maps a shadow `threadId` to the
   * persisted message-row ids belonging to it, so "Clear / Revoke shadow chat" can purge exactly that
   * thread's history. Additive and device-local only — it adds no wire/envelope/codec field and never
   * touches the `MessageRow` wire shape or the frozen backend. Absent ⇒ no shadow rows tagged yet.
   */
  shadowRowThreads?: Record<string, string[]>;
}

const emptyDoc = (): VaultDoc => ({
  version: DOC_VERSION,
  identity: null,
  deviceId: null,
  sequences: {},
  messages: {},
  timers: {},
  keyStoreSessions: {},
  signal: null,
  appPins: {},
  hiddenChats: {},
  unlockFailures: [],
  shadowSecrets: {},
});

/** Find a stored message row by its conversation + LOCAL `(direction, seq)`, or `undefined`. */
function findRow(
  doc: VaultDoc,
  remoteUid: string,
  direction: 'in' | 'out',
  seq: number,
): MessageRow | undefined {
  return Object.values(doc.messages).find(
    (row) => row.remoteUid === remoteUid && row.direction === direction && row.seq === seq,
  );
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));
const addressKey = (address: SignalAddress): string => `${address.uid}:${address.deviceId}`;

function serializeIdentity(record: IdentityRecord): SerializedIdentity {
  return {
    uid: record.uid,
    registrationId: record.registrationId,
    identityKeyPublic: b64(record.identityKeyPublic),
    identityKeyPrivate: b64(record.identityKeyPrivate),
    signedPreKey: {
      keyId: record.signedPreKey.keyId,
      publicKey: b64(record.signedPreKey.publicKey),
      privateKey: b64(record.signedPreKey.privateKey),
      signature: b64(record.signedPreKey.signature),
    },
    oneTimePreKeys: record.oneTimePreKeys.map((key) => ({
      keyId: key.keyId,
      publicKey: b64(key.publicKey),
      privateKey: b64(key.privateKey),
    })),
    createdAt: record.createdAt,
  };
}

function deserializeIdentity(stored: SerializedIdentity): IdentityRecord {
  const signedPreKey: SignedPreKeyRecord = {
    keyId: stored.signedPreKey.keyId,
    publicKey: unb64(stored.signedPreKey.publicKey),
    privateKey: unb64(stored.signedPreKey.privateKey),
    signature: unb64(stored.signedPreKey.signature),
  };
  const oneTimePreKeys: OneTimePreKeyRecord[] = stored.oneTimePreKeys.map((key) => ({
    keyId: key.keyId,
    publicKey: unb64(key.publicKey),
    privateKey: unb64(key.privateKey),
  }));
  return {
    uid: stored.uid,
    registrationId: stored.registrationId,
    identityKeyPublic: unb64(stored.identityKeyPublic),
    identityKeyPrivate: unb64(stored.identityKeyPrivate),
    signedPreKey,
    oneTimePreKeys,
    createdAt: stored.createdAt,
  };
}

/** Seed the libsignal store section from a freshly-generated identity (recipient prekeys). */
function seedSignalSection(record: IdentityRecord): SignalSection {
  const preKeys: Record<string, string> = {};
  for (const key of record.oneTimePreKeys) {
    preKeys[String(key.keyId)] = b64(encodePreKeyRecord(key.publicKey, key.privateKey));
  }
  const signedPreKeys: Record<string, string> = {
    [String(record.signedPreKey.keyId)]: b64(
      encodePreKeyRecord(record.signedPreKey.publicKey, record.signedPreKey.privateKey),
    ),
  };
  return { sessions: {}, identities: {}, preKeys, signedPreKeys };
}

/** Constant-time-ish byte comparison (length + content); inputs are public key bytes. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// The vault: hydrate once, serialize writes, encrypt the whole document.
// ---------------------------------------------------------------------------

/** Storage keys, namespaced by uid so distinct accounts never share material. */
const dekKey = (uid: string): string => `chat.vault.dek.v1.${uid}`;
const blobKey = (uid: string): string => `chat.vault.blob.v1.${uid}`;
/** Data-encryption key length: 32-byte AES key + 32-byte MAC key (see CryptoBox). */
const DEK_LENGTH = 64;

/**
 * The encrypted on-device document plus the in-memory cache and write serialization. The
 * {@link KeyStore} and {@link SignalProtocolStore} adapters both operate on the same cached
 * document, so a single encrypted blob holds all state and writes are coherent.
 */
export interface PersistentVault {
  /** Read from the (lazily hydrated) document. */
  read<T>(fn: (doc: VaultDoc) => T): Promise<T>;
  /** Mutate the document and durably persist before resolving. */
  mutate<T>(fn: (doc: VaultDoc) => T): Promise<T>;
  /** Drop the in-memory document (sign-out teardown); the on-disk blob is retained. */
  release(): void;
  /** Erase the on-disk blob AND the data-encryption key (explicit sign-out wipe, 7.4). */
  wipe(): Promise<void>;
}

/**
 * Build a {@link PersistentVault} for `uid`. The data-encryption key is loaded from secure
 * storage or minted (CSPRNG) and stored on first use; the document is loaded and decrypted
 * lazily on first access. A decrypt failure (corrupt blob / missing key) is surfaced, not
 * silently discarded, so the caller can present a recoverable setup failure.
 */
export function createPersistentVault(uid: string, deps: PersistentVaultDeps): PersistentVault {
  const { secure, blob, crypto, getRandomValues } = deps;

  let cached: VaultDoc | null = null;
  let hydrating: Promise<VaultDoc> | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let released = false;

  const loadOrCreateDek = async (): Promise<Uint8Array> => {
    const existing = await secure.getItem(dekKey(uid));
    if (existing !== null) {
      return unb64(existing);
    }
    const fresh = getRandomValues(new Uint8Array(DEK_LENGTH));
    await secure.setItem(dekKey(uid), b64(fresh));
    return fresh;
  };

  const hydrate = async (): Promise<VaultDoc> => {
    const dek = await loadOrCreateDek();
    const raw = await blob.getItem(blobKey(uid));
    if (raw === null) {
      return emptyDoc();
    }
    let parsed: VaultDoc;
    try {
      const json = await crypto.decrypt(raw, dek);
      parsed = JSON.parse(json) as VaultDoc;
    } catch (err) {
      throw new Error(
        `Encrypted store could not be opened (${err instanceof Error ? err.message : 'unknown error'}).`,
      );
    }
    // Normalize against the current shape so older/partial documents load safely.
    return { ...emptyDoc(), ...parsed };
  };

  const ready = (): Promise<VaultDoc> => {
    if (cached !== null) {
      return Promise.resolve(cached);
    }
    if (hydrating === null) {
      hydrating = hydrate().then((doc) => {
        cached = doc;
        return doc;
      });
    }
    return hydrating;
  };

  const persist = async (doc: VaultDoc): Promise<void> => {
    const dek = await loadOrCreateDek();
    const encrypted = await crypto.encrypt(JSON.stringify(doc), dek);
    await blob.setItem(blobKey(uid), encrypted);
  };

  return {
    async read<T>(fn: (doc: VaultDoc) => T): Promise<T> {
      const doc = await ready();
      return fn(doc);
    },

    async mutate<T>(fn: (doc: VaultDoc) => T): Promise<T> {
      const doc = await ready();
      const result = fn(doc);
      // Serialize writes so concurrent mutations can't interleave a half-written blob.
      const write = writeChain.then(() => persist(doc));
      writeChain = write.catch(() => undefined);
      await write;
      return result;
    },

    release(): void {
      released = true;
      cached = null;
      hydrating = null;
    },

    async wipe(): Promise<void> {
      // Let any in-flight write settle before erasing, so wipe is final.
      await writeChain.catch(() => undefined);
      await blob.removeItem(blobKey(uid));
      await secure.removeItem(dekKey(uid));
      cached = null;
      hydrating = null;
      released = true;
    },
  };
}

// ---------------------------------------------------------------------------
// KeyStore adapter over the vault.
// ---------------------------------------------------------------------------

/** A persistent {@link KeyStore} backed by the encrypted {@link PersistentVault}. */
export function createPersistentKeyStore(vault: PersistentVault): KeyStore {
  return {
    async saveIdentity(record: IdentityRecord): Promise<void> {
      await vault.mutate((doc) => {
        doc.identity = serializeIdentity(record);
      });
    },
    async loadIdentity(uid: string): Promise<IdentityRecord | null> {
      return vault.read((doc) =>
        doc.identity !== null && doc.identity.uid === uid ? deserializeIdentity(doc.identity) : null,
      );
    },
    async saveDeviceId(deviceId: string): Promise<void> {
      await vault.mutate((doc) => {
        doc.deviceId = deviceId;
      });
    },
    async loadDeviceId(): Promise<string | null> {
      return vault.read((doc) => doc.deviceId);
    },

    async loadSession(addr: SignalAddress): Promise<Uint8Array | null> {
      return vault.read((doc) => {
        const stored = doc.keyStoreSessions[addressKey(addr)];
        return stored !== undefined ? unb64(stored) : null;
      });
    },
    async saveSession(addr: SignalAddress, record: Uint8Array): Promise<void> {
      await vault.mutate((doc) => {
        doc.keyStoreSessions[addressKey(addr)] = b64(record);
      });
    },
    async consumeOneTimePreKey(keyId: number): Promise<void> {
      await vault.mutate((doc) => {
        if (doc.identity !== null) {
          doc.identity.oneTimePreKeys = doc.identity.oneTimePreKeys.filter((key) => key.keyId !== keyId);
        }
      });
    },

    async nextSeq(recipientUid: string): Promise<number> {
      return vault.mutate((doc) => {
        const next = (doc.sequences[recipientUid] ?? 0) + 1;
        doc.sequences[recipientUid] = next;
        return next;
      });
    },

    async appendMessage(row: MessageRow): Promise<void> {
      await vault.mutate((doc) => {
        doc.messages[row.id] = { ...row };
      });
    },
    async updateMessageStatus(id, status): Promise<void> {
      await vault.mutate((doc) => {
        const row = doc.messages[id];
        if (row !== undefined) {
          row.status = status;
        }
      });
    },
    async loadMessages(): Promise<MessageRow[]> {
      // Persisted history for relaunch rehydration (CC4): every stored row, copied out so a
      // mutation of the returned value can't reach back into the cached document.
      return vault.read((doc) => Object.values(doc.messages).map((row) => ({ ...row })));
    },
    async applyReaction(remoteUid, direction, seq, emoji): Promise<void> {
      await vault.mutate((doc) => {
        const row = findRow(doc, remoteUid, direction, seq);
        if (row === undefined || row.deleted === true) {
          return;
        }
        const reactions = row.reactions ?? [];
        if (!reactions.includes(emoji)) {
          row.reactions = [...reactions, emoji];
        }
      });
    },
    async applyEdit(remoteUid, direction, seq, body): Promise<void> {
      await vault.mutate((doc) => {
        const row = findRow(doc, remoteUid, direction, seq);
        if (row === undefined || row.deleted === true) {
          return;
        }
        row.plaintext = body;
        row.edited = true;
      });
    },
    async applyDelete(remoteUid, direction, seq): Promise<void> {
      await vault.mutate((doc) => {
        const row = findRow(doc, remoteUid, direction, seq);
        if (row === undefined) {
          return;
        }
        row.plaintext = null;
        row.deleted = true;
        row.edited = false;
        delete row.reactions;
      });
    },
    async setConversationTimer(remoteUid, ttlMs): Promise<void> {
      await vault.mutate((doc) => {
        doc.timers[remoteUid] = Math.max(0, ttlMs);
      });
    },
    async loadConversationTimers(): Promise<Record<string, number>> {
      return vault.read((doc) => ({ ...doc.timers }));
    },
    async purgeMessages(ids): Promise<void> {
      await vault.mutate((doc) => {
        for (const id of ids) {
          const row = doc.messages[id];
          if (row !== undefined) {
            // Best-effort secure erase: overwrite the plaintext before dropping the row, so the
            // cleartext is gone from the re-encrypted blob (OS backups remain out of scope).
            row.plaintext = null;
            delete doc.messages[id];
          }
        }
      });
    },

    destroy(): void {
      // Release the in-memory document; the encrypted blob is retained for the next launch.
      // Explicit sign-out wipe goes through PersistentVault.wipe.
      vault.release();
    },
  };
}

// ---------------------------------------------------------------------------
// SignalProtocolStore adapter over the vault.
// ---------------------------------------------------------------------------

/**
 * Build a persistent {@link SignalProtocolStore} backed by the vault, projecting the device's
 * {@link IdentityRecord} for the identity-key/registration surfaces and accumulating sessions,
 * remote identities, and remaining prekeys in the encrypted document. On first use the libsignal
 * section is seeded from the identity's published prekeys; thereafter it is loaded as-is so
 * prekey consumption and ratchet state survive a relaunch.
 */
export function createPersistentSignalProtocolStore(
  vault: PersistentVault,
  record: IdentityRecord,
): SignalProtocolStore {
  const identityKeyPair = { publicKey: record.identityKeyPublic, privateKey: record.identityKeyPrivate };

  // Ensure the signal section exists exactly once; seed it from the identity on first launch.
  const ensureSection = (): Promise<SignalSection> =>
    vault.mutate((doc) => {
      if (doc.signal === null) {
        doc.signal = seedSignalSection(record);
      }
      return doc.signal;
    });
  let sectionReady: Promise<SignalSection> | null = null;
  const section = (): Promise<SignalSection> => {
    if (sectionReady === null) {
      sectionReady = ensureSection();
    }
    return sectionReady;
  };

  return {
    async getIdentityKeyPair() {
      return identityKeyPair;
    },
    async getLocalRegistrationId() {
      return record.registrationId;
    },

    async loadSession(address) {
      await section();
      return vault.read((doc) => {
        const stored = doc.signal?.sessions[addressKey(address)];
        return stored !== undefined ? unb64(stored) : null;
      });
    },
    async storeSession(address, recordBytes) {
      await section();
      await vault.mutate((doc) => {
        if (doc.signal !== null) {
          doc.signal.sessions[addressKey(address)] = b64(recordBytes);
        }
      });
    },

    async loadPreKey(keyId) {
      await section();
      return vault.read((doc) => {
        const stored = doc.signal?.preKeys[String(keyId)];
        return stored !== undefined ? unb64(stored) : null;
      });
    },
    async removePreKey(keyId) {
      await section();
      await vault.mutate((doc) => {
        if (doc.signal !== null) {
          delete doc.signal.preKeys[String(keyId)];
        }
      });
    },

    async loadSignedPreKey(keyId) {
      await section();
      return vault.read((doc) => {
        const stored = doc.signal?.signedPreKeys[String(keyId)];
        return stored !== undefined ? unb64(stored) : null;
      });
    },

    async saveIdentity(address, identityKey) {
      await section();
      return vault.mutate((doc) => {
        if (doc.signal === null) {
          return false;
        }
        const key = addressKey(address);
        const existing = doc.signal.identities[key];
        const changed = existing !== undefined && !bytesEqual(unb64(existing), identityKey);
        doc.signal.identities[key] = b64(identityKey);
        return changed;
      });
    },
    async isTrustedIdentity(address, identityKey) {
      await section();
      return vault.read((doc) => {
        const existing = doc.signal?.identities[addressKey(address)];
        return existing === undefined || bytesEqual(unb64(existing), identityKey);
      });
    },
    async loadIdentityKey(address) {
      await section();
      return vault.read((doc) => {
        const stored = doc.signal?.identities[addressKey(address)];
        return stored !== undefined ? unb64(stored) : null;
      });
    },
  };
}
