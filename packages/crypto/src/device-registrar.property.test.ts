import assert from 'node:assert/strict';
import { test } from 'node:test';

import fc from 'fast-check';

import type { PublicPreKeyBundleOut } from '@chat-app/types';

import { BackoffPolicy } from './backoff-policy';
import { DefaultDeviceRegistrar, type RegistrarAuth } from './device-registrar';
import type { IdentityManager } from './identity-manager';
import type { HttpClient, HttpRequest, HttpResponse, IdentityRecord, KeyStore } from './ports';

const BUNDLE: PublicPreKeyBundleOut = {
  registrationId: 7,
  identityKey: 'aWs=',
  signedPreKey: { keyId: 0, publicKey: 'c3Br', signature: 'c2ln' },
  oneTimePreKeys: [{ keyId: 0, publicKey: 'b3Rw' }],
};

class CountingHttp implements HttpClient {
  count = 0;
  async send(_request: HttpRequest): Promise<HttpResponse> {
    this.count += 1;
    // Always succeed so a registration that DOES hit the network completes deterministically.
    return { status: 201, headers: {}, body: JSON.stringify({ deviceId: 'dev-fresh' }) };
  }
}

function keyStore(hasDeviceId: boolean, hasIdentity: boolean): KeyStore {
  let deviceId = hasDeviceId ? 'dev-stored' : null;
  const identity = hasIdentity ? ({ uid: 'alice' } as unknown as IdentityRecord) : null;
  return {
    async loadDeviceId() {
      return deviceId;
    },
    async saveDeviceId(id: string) {
      deviceId = id;
    },
    async loadIdentity() {
      return identity;
    },
  } as unknown as KeyStore;
}

const identityManager: IdentityManager = {
  async ensureIdentity() {
    return BUNDLE;
  },
  async getPublicBundle() {
    return BUNDLE;
  },
};

const auth: RegistrarAuth = {
  getCurrentToken: () => 'token-1',
  getCurrentUid: () => 'alice',
  refreshWithRetry: async () => 'token-2',
};

test('Property 10: registration is idempotent across launches', async () => {
  // Feature: phase1-client-messaging, Property 10: Registration idempotence across launches
  await fc.assert(
    fc.asyncProperty(fc.boolean(), fc.boolean(), async (hasDeviceId, hasIdentity) => {
      const http = new CountingHttp();
      const registrar = new DefaultDeviceRegistrar(
        {
          httpClient: http,
          keyStore: keyStore(hasDeviceId, hasIdentity),
          identityManager,
          auth,
          backoff: new BackoffPolicy({ rng: () => 0 }),
        },
        { registerUrl: 'https://api.example.test/api/devices/register', now: () => 0 },
      );

      const result = await registrar.ensureRegistered();

      if (hasDeviceId && hasIdentity) {
        // Both stored ⇒ no network request, stored deviceId returned (3.7).
        assert.equal(http.count, 0);
        assert.deepEqual(result, { status: 'registered', deviceId: 'dev-stored' });
      } else {
        // Missing either ⇒ exactly one registration request is issued.
        assert.equal(http.count, 1);
        assert.deepEqual(result, { status: 'registered', deviceId: 'dev-fresh' });
      }
    }),
    { numRuns: 100 },
  );
});
