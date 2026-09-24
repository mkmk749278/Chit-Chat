/**
 * Unit tests for {@link createAccountClient} (permanent account deletion). A fake HttpClient
 * records the request; no network or native module is involved.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { HttpClient, HttpRequest, HttpResponse } from '@chat-app/crypto';

import { createAccountClient } from '../api/api-clients';

function fakeHttp(respond: (req: HttpRequest) => HttpResponse | Error): { http: HttpClient; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    async send(req: HttpRequest): Promise<HttpResponse> {
      requests.push(req);
      const res = respond(req);
      if (res instanceof Error) throw res;
      return res;
    },
  };
  return { http, requests };
}

test('deletes via POST /api/account/delete with the bearer token', async () => {
  const { http, requests } = fakeHttp(() => ({ status: 204, headers: {}, body: '' }));
  const client = createAccountClient(http, () => 'tok', 'https://api.example.test');

  assert.deepEqual(await client.deleteAccount(), { ok: true, status: 204 });
  assert.equal(requests[0]!.method, 'POST');
  assert.equal(requests[0]!.url, 'https://api.example.test/api/account/delete');
  assert.equal(requests[0]!.headers?.Authorization, 'Bearer tok');
});

test('reports a server failure without throwing (safe to retry)', async () => {
  const { http } = fakeHttp(() => ({ status: 503, headers: {}, body: '' }));
  const client = createAccountClient(http, () => 'tok', 'https://api.example.test');
  assert.deepEqual(await client.deleteAccount(), { ok: false, status: 503 });
});

test('reports a network failure as status 0', async () => {
  const { http } = fakeHttp(() => new Error('offline'));
  const client = createAccountClient(http, () => 'tok', 'https://api.example.test');
  assert.deepEqual(await client.deleteAccount(), { ok: false, status: 0 });
});

test('never calls the server without a token', async () => {
  const { http, requests } = fakeHttp(() => ({ status: 204, headers: {}, body: '' }));
  const client = createAccountClient(http, () => null, 'https://api.example.test');
  assert.deepEqual(await client.deleteAccount(), { ok: false, status: 0 });
  assert.equal(requests.length, 0);
});
