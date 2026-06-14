/**
 * `apps/mobile` — React Native wiring for the persistent encrypted store.
 *
 * Binds the platform-agnostic {@link createPersistentVault} to the device:
 *  - {@link SecureKeyStorage} → `expo-secure-store` (Android Keystore-backed) holds the
 *    64-byte data-encryption key. It never holds bulk data, only the key.
 *  - {@link BlobStorage} → `@react-native-async-storage/async-storage` holds the single
 *    AES-256-CBC+HMAC-encrypted document blob. Plaintext never reaches AsyncStorage.
 *  - {@link CryptoBox} → the WebCrypto `subtle` installed by `src/polyfills.ts` (msrcrypto)
 *    plus the native CSPRNG (`crypto.getRandomValues`).
 *
 * This module imports native modules and so is loaded only on-device; the persistence logic
 * it wires is tested separately against Node WebCrypto with in-memory fakes.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { createCryptoBox } from './crypto-box';
import {
  createPersistentVault,
  type BlobStorage,
  type PersistentVault,
  type SecureKeyStorage,
} from './persistent-store';

/** The polyfilled WebCrypto (`subtle` from msrcrypto, `getRandomValues` from the native CSPRNG). */
const webCrypto = (globalThis as unknown as { crypto?: Crypto }).crypto;

const secure: SecureKeyStorage = {
  async getItem(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value);
  },
  async removeItem(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
  },
};

const blob: BlobStorage = {
  async getItem(key: string): Promise<string | null> {
    return AsyncStorage.getItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await AsyncStorage.setItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    await AsyncStorage.removeItem(key);
  },
};

/**
 * Build the device-backed {@link PersistentVault} for a signed-in user. Throws if the runtime
 * WebCrypto is unavailable — that is a setup failure the controller surfaces and can retry,
 * never a silent fall back to a churn-prone in-memory store.
 */
export function createNativeVault(uid: string): PersistentVault {
  if (webCrypto?.subtle === undefined || webCrypto.getRandomValues === undefined) {
    throw new Error('Secure storage unavailable: WebCrypto subtle/getRandomValues missing.');
  }
  const crypto = createCryptoBox({
    subtle: webCrypto.subtle,
    getRandomValues: <T extends ArrayBufferView>(array: T): T =>
      webCrypto.getRandomValues(array as unknown as ArrayBufferView) as unknown as T,
  });
  return createPersistentVault(uid, {
    secure,
    blob,
    crypto,
    getRandomValues: <T extends ArrayBufferView>(array: T): T =>
      webCrypto.getRandomValues(array as unknown as ArrayBufferView) as unknown as T,
  });
}
