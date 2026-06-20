/**
 * `apps/mobile` — durable, encrypted-at-rest {@link ShadowSecretPersistence} (Shadow Chat,
 * design Component 6 "Durable encrypted persistence", task 12.1).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Durable encrypted persistence (UPDATED)"
 * and `.kiro/specs/shadow-chat/requirements.md` → Requirements 9.1, 9.5, 9.7, 9.8, 9.9.
 *
 * This is the PRODUCTION backing for the narrow {@link ShadowSecretPersistence} port that
 * `@chat-app/crypto`'s `ShadowSecretStore` consumes. It binds that port to the SAME on-device
 * encrypted vault the mobile {@link KeyStore} already uses — the {@link PersistentVault}'s single
 * AES-256-CBC+HMAC blob, whose data-encryption key lives in the hardware-backed Android Keystore
 * (`expo-secure-store`). The earlier in-memory adapter (`createInMemoryShadowSecretPersistence`)
 * lost all shadow state on restart; this adapter persists:
 *   - the shadow **master secret** (seeds `deriveShadowThreadId`),
 *   - the alias-HMAC **alias key** (keys `hashAlias` / `matchAlias`), and
 *   - the full set of hash-only **`AliasEntry<ShadowThreadRef>`** mappings (each `ref` including any
 *     optional `pinVerifier`),
 * so a provisioned shadow store is rehydrated from durable state on the next launch (Req 9.8, 9.9).
 *
 * **Encrypted only, never off-device (Req 9.1, 9.5, C1).** Every value is written ONLY into the
 * vault's encrypted document via {@link PersistentVault.mutate}; the secrets ride inside the AES
 * blob and never touch an unencrypted location, and nothing here performs any network I/O. Byte
 * material is base64-encoded purely so the JSON document is text-safe before it is encrypted.
 *
 * **Atomic writes (Req 9.7).** Each `save*` method is a single {@link PersistentVault.mutate}, which
 * serialises the whole document and persists it as ONE encrypted blob write. The write is therefore
 * all-or-nothing: it either replaces the blob in full or leaves the prior blob intact, so an aborted
 * write can never leave a partial mapping or any plaintext behind. Mutations are also serialised by
 * the vault's internal write chain, so concurrent binds cannot interleave a half-written document.
 *
 * The adapter is pure orchestration over the injected vault — no cryptography of its own and no RN
 * imports — so it round-trips identically under Node (tests) and on-device.
 */

import type {
  AliasEntry,
  ShadowSecretPersistence,
  ShadowThreadRef,
} from '@chat-app/crypto';
import { Buffer } from 'buffer';

import type { PersistentVault } from '../crypto/persistent-store';

/** Encode raw bytes to a JSON-/encryption-safe base64 string. */
const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** Decode a base64 string back to bytes; an empty/blank string yields `null` (not provisioned). */
const fromBase64 = (value: string | undefined): Uint8Array | null => {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return new Uint8Array(Buffer.from(value, 'base64'));
};

/**
 * Build the durable {@link ShadowSecretPersistence} over the encrypted {@link PersistentVault}. The
 * same vault instance the controller opens for identity/messaging state is reused, so the shadow
 * secrets share its single encrypted blob and its hardware-backed data-encryption key (no second
 * database, no second key).
 */
export function createVaultShadowSecretPersistence(vault: PersistentVault): ShadowSecretPersistence {
  return {
    async loadMasterSecret(): Promise<Uint8Array | null> {
      return vault.read((doc) => fromBase64(doc.shadowSecrets?.masterSecret));
    },

    async saveMasterSecret(masterSecret: Uint8Array): Promise<void> {
      // Single atomic mutate → one encrypted blob write (Req 9.7); encrypted at rest (Req 9.5).
      await vault.mutate((doc) => {
        const section = doc.shadowSecrets ?? {};
        section.masterSecret = toBase64(masterSecret);
        doc.shadowSecrets = section;
      });
    },

    async loadAliasKey(): Promise<Uint8Array | null> {
      return vault.read((doc) => fromBase64(doc.shadowSecrets?.aliasKey));
    },

    async saveAliasKey(aliasKey: Uint8Array): Promise<void> {
      await vault.mutate((doc) => {
        const section = doc.shadowSecrets ?? {};
        section.aliasKey = toBase64(aliasKey);
        doc.shadowSecrets = section;
      });
    },

    async loadAliasEntries(): Promise<ReadonlyArray<AliasEntry<ShadowThreadRef>>> {
      return vault.read((doc) =>
        // Copy out so a caller's mutation can't reach back into the cached document; the whole
        // `ref` (incl. any optional `pinVerifier`) is round-tripped intact.
        (doc.shadowSecrets?.aliasEntries ?? []).map((entry) => ({
          aliasHash: entry.aliasHash,
          ref: { ...entry.ref },
        })),
      );
    },

    async saveAliasEntry(entry: AliasEntry<ShadowThreadRef>): Promise<void> {
      // Atomic upsert keyed by the opaque aliasHash (re-binding the same alias replaces, never
      // duplicates). Only the hash + ref are stored — never the plaintext/normalised alias.
      await vault.mutate((doc) => {
        const section = doc.shadowSecrets ?? {};
        const existing = section.aliasEntries ?? [];
        const stored = { aliasHash: entry.aliasHash, ref: { ...entry.ref } };
        const next = existing.filter((candidate) => candidate.aliasHash !== entry.aliasHash);
        next.push(stored);
        section.aliasEntries = next;
        doc.shadowSecrets = section;
      });
    },
  };
}
