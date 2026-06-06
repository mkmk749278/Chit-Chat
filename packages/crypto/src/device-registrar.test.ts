import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PublicPreKeyBundleOut } from '@chat-app/types';

import { BackoffPolicy } from './backoff-policy';
import {
  DefaultDeviceRegistrar,
  type RegistrarAuth,
} from './device-registrar';
import type { IdentityManager } from './identity-manager';
import type { HttpClient, HttpRequest, HttpResponse, IdentityRecord, KeyStore } from './ports';

const REGISTER_URL = 'https://api.example.test/api/devices/register';

const PUBLIC_BUNDLE: PublicPreKeyBundleOut = {
  registrationId: 7,
  identityKey: Buffer.from('idk').toString('base64'),
  signedPreKey: {
    keyId: 0,
    publicKey: Buffer.from('spk').toString('base64'),
    signature: Buffer.from('sig').toString('base64'),
  },
  oneTimePreKeys: [{ keyId: 0, publicKey: Buffer.from('otp').toString('base64') }],
};

/** Scriptable HttpClient returning queued responses (or throwing for a transport failure). */
class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  private readonly queue: Array<HttpResponse | 'throw'>;
  constructor(...responses: Array<HttpResponse | 'throw'>) {
    this.queue = responses;
  }
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    const next = this.queue.shift();
    if (next === undefined || next === 'throw') {
      throw new Error('transport failure');
    }
    return next;
  }
}

const res = (status: number, body: unknown = {}): HttpResponse => ({
  status,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

function fakeKeyStore(
  init: { deviceId?: string | null; identity?: IdentityRecord | null } = {},
): KeyStore & { ref: { deviceId: string | null } } {
  const ref = { deviceId: init.deviceId ?? null };
  const identity = init.identity ?? null;
  const store = {
    async loadDeviceId(): Promise<string | null> {
      return ref.deviceId;
    },
    async saveDeviceId(id: string): Promise<void> {
      ref.deviceId = id;
    },
    async loadIdentity(): Promise<IdentityRecord | null> {
      return identity;
    },
  } as unknown as KeyStore;
  return Object.assign(store, { ref });
}

function fakeIdentityManager(): IdentityManager {
  return {
    async ensureIdentity(): Promise<PublicPreKeyBundleOut> {
      return PUBLIC_BUNDLE;
    },
    async getPublicBundle(): Promise<PublicPreKeyBundleOut> {
      return PUBLIC_BUNDLE;
    },
  };
}

function fakeAuth(overrides: Partial<RegistrarAuth> = {}): RegistrarAuth {
  return {
    getCurrentToken: () => 'token-1',
    getCurrentUid: () => 'alice',
    refreshWithRetry: async () => 'token-refreshed',
    ...overrides,
  };
}

function buildRegistrar(opts: {
  http: HttpClient;
  keyStore?: KeyStore;
  auth?: RegistrarAuth;
  sleeps?: number[];
}): DefaultDeviceRegistrar {
  let clock = 0;
  return new DefaultDeviceRegistrar(
    {
      httpClient: opts.http,
      keyStore: opts.keyStore ?? fakeKeyStore(),
      identityManager: fakeIdentityManager(),
      auth: opts.auth ?? fakeAuth(),
      backoff: new BackoffPolicy({ rng: () => 0 }),
    },
    {
      registerUrl: REGISTER_URL,
      now: () => clock,
      sleep: async (ms: number) => {
        opts.sleeps?.push(ms);
        clock += ms; // advance the budget clock by each slept interval
      },
    },
  );
}

// --- idempotence (Property 10) ----------------------------------------------

test('returns the stored deviceId without any network call when already registered (Property 10, 3.7)', async () => {
  const http = new FakeHttp(); // empty: any request would throw
  const keyStore = fakeKeyStore({
    deviceId: 'dev-stored',
    identity: { uid: 'alice' } as unknown as IdentityRecord,
  });
  const registrar = buildRegistrar({ http, keyStore });

  const result = await registrar.ensureRegistered();

  assert.deepEqual(result, { status: 'registered', deviceId: 'dev-stored' });
  assert.equal(http.requests.length, 0, 'no network call when stored deviceId + identity exist');
});

// --- 201 --------------------------------------------------------------------

test('HTTP 201 persists and exposes the deviceId (3.3)', async () => {
  const http = new FakeHttp(res(201, { deviceId: 'dev-new' }));
  const keyStore = fakeKeyStore();
  const registrar = buildRegistrar({ http, keyStore });

  const result = await registrar.ensureRegistered();

  assert.deepEqual(result, { status: 'registered', deviceId: 'dev-new' });
  assert.equal(keyStore.ref.deviceId, 'dev-new');
  // Bearer token + JSON body were sent.
  assert.equal(http.requests[0]!.headers?.Authorization, 'Bearer token-1');
  assert.equal(http.requests[0]!.method, 'POST');
});

test('a 201 without a usable deviceId surfaces service-unavailable', async () => {
  const http = new FakeHttp(res(201, {}));
  const registrar = buildRegistrar({ http });
  assert.deepEqual(await registrar.ensureRegistered(), { status: 'service-unavailable' });
});

// --- 400 --------------------------------------------------------------------

test('HTTP 400 records the offending field and does not retry the same payload (3.5)', async () => {
  const http = new FakeHttp(
    res(400, { message: ['registrationId must not be less than 1'] }),
    res(201, { deviceId: 'should-not-be-reached' }),
  );
  const registrar = buildRegistrar({ http });

  const result = await registrar.ensureRegistered();

  assert.deepEqual(result, { status: 'invalid', field: 'registrationId' });
  assert.equal(http.requests.length, 1, 'the same payload is not retried after 400');
});

// --- 401 --------------------------------------------------------------------

test('HTTP 401 refreshes the token and retries once, then succeeds (3.4)', async () => {
  const http = new FakeHttp(res(401), res(201, { deviceId: 'dev-after-refresh' }));
  let refreshCalls = 0;
  const auth = fakeAuth({
    refreshWithRetry: async () => {
      refreshCalls += 1;
      return 'token-2';
    },
  });
  const registrar = buildRegistrar({ http, auth });

  const result = await registrar.ensureRegistered();

  assert.deepEqual(result, { status: 'registered', deviceId: 'dev-after-refresh' });
  assert.equal(refreshCalls, 1);
  assert.equal(http.requests.length, 2);
});

test('two consecutive 401s surface sign-in-required (3.4)', async () => {
  const http = new FakeHttp(res(401), res(401));
  const registrar = buildRegistrar({ http });
  assert.deepEqual(await registrar.ensureRegistered(), { status: 'sign-in-required' });
});

test('no signed-in uid yields sign-in-required without a network call (3.1)', async () => {
  const http = new FakeHttp();
  const registrar = buildRegistrar({ http, auth: fakeAuth({ getCurrentUid: () => null }) });
  assert.deepEqual(await registrar.ensureRegistered(), { status: 'sign-in-required' });
  assert.equal(http.requests.length, 0);
});

// --- 503 / timeout backoff (3.6, 3.8, 3.9) ----------------------------------

test('HTTP 503 retries with backoff and then succeeds (3.6)', async () => {
  const http = new FakeHttp(res(503), res(503), res(201, { deviceId: 'dev-eventually' }));
  const sleeps: number[] = [];
  const registrar = buildRegistrar({ http, sleeps });

  const result = await registrar.ensureRegistered();

  assert.deepEqual(result, { status: 'registered', deviceId: 'dev-eventually' });
  assert.equal(sleeps.length, 2, 'backed off once per 503 before the eventual success');
});

test('a transport failure/timeout is retried with backoff (3.8)', async () => {
  const http = new FakeHttp('throw', res(201, { deviceId: 'dev-after-timeout' }));
  const sleeps: number[] = [];
  const registrar = buildRegistrar({ http, sleeps });

  const result = await registrar.ensureRegistered();

  assert.deepEqual(result, { status: 'registered', deviceId: 'dev-after-timeout' });
  assert.equal(sleeps.length, 1);
});

test('persistent 503 past the cumulative budget surfaces service-unavailable (3.9)', async () => {
  // Every send is a 503; the injected sleep advances the clock so the 5-min budget elapses.
  const many: HttpResponse[] = Array.from({ length: 100 }, () => res(503));
  const http = new FakeHttp(...many);
  const registrar = buildRegistrar({ http });

  const result = await registrar.ensureRegistered();
  assert.deepEqual(result, { status: 'service-unavailable' });
});
