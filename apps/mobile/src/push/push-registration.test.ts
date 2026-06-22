/**
 * Unit tests for the FCM push-registration orchestration (Req 6.2/6.4). Run under `node --test`; the
 * Firebase-specific surface is injected as a fake {@link PushPlatform}, so no native module is needed.
 *
 * They assert: an authorized device uploads its token and re-uploads on refresh; a denied/unavailable
 * platform no-ops without uploading; sign-out revokes (empty token) and deletes the local token; and
 * every path is best-effort (a failing upload never throws).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PushTokenClient } from '../api/api-clients';
import {
  registerPushToken,
  revokePushToken,
  type PushPlatform,
} from './push-registration';

function fakeClient(opts: { throws?: boolean } = {}): {
  client: PushTokenClient;
  calls: Array<{ registrationId: number; pushToken: string }>;
} {
  const calls: Array<{ registrationId: number; pushToken: string }> = [];
  const client: PushTokenClient = {
    async setPushToken(registrationId, pushToken) {
      calls.push({ registrationId, pushToken });
      if (opts.throws) {
        throw new Error('network down');
      }
      return true;
    },
  };
  return { client, calls };
}

function fakePlatform(opts: { token: string | null }): {
  platform: PushPlatform;
  fireRefresh: (t: string) => void;
  refreshUnsubbed: () => boolean;
  deleted: () => boolean;
} {
  let listener: ((t: string) => void) | null = null;
  let unsubbed = false;
  let deleted = false;
  const platform: PushPlatform = {
    async acquireToken() {
      return opts.token;
    },
    onTokenRefresh(l) {
      listener = l;
      return () => {
        unsubbed = true;
      };
    },
    async deleteToken() {
      deleted = true;
    },
  };
  return {
    platform,
    fireRefresh: (t) => listener?.(t),
    refreshUnsubbed: () => unsubbed,
    deleted: () => deleted,
  };
}

test('registers the acquired token and re-uploads on refresh', async () => {
  const { client, calls } = fakeClient();
  const { platform, fireRefresh } = fakePlatform({ token: 'tok-1' });

  const unsub = await registerPushToken({ client, registrationId: 42, platform });
  assert.deepEqual(calls, [{ registrationId: 42, pushToken: 'tok-1' }]);

  fireRefresh('tok-2');
  // allow the fire-and-forget upload in the refresh listener to settle
  await Promise.resolve();
  assert.deepEqual(calls[1], { registrationId: 42, pushToken: 'tok-2' });

  assert.equal(typeof unsub, 'function');
});

test('no platform (FCM unavailable) is a no-op — nothing uploaded', async () => {
  const { client, calls } = fakeClient();
  const unsub = await registerPushToken({ client, registrationId: 7, platform: null });
  assert.equal(calls.length, 0);
  assert.equal(typeof unsub, 'function');
});

test('a denied/empty token does not upload but still subscribes to refresh', async () => {
  const { client, calls } = fakeClient();
  const { platform, fireRefresh } = fakePlatform({ token: null });

  await registerPushToken({ client, registrationId: 1, platform });
  assert.equal(calls.length, 0);

  // A later refresh (e.g. permission granted afterwards) still uploads.
  fireRefresh('later-tok');
  await Promise.resolve();
  assert.deepEqual(calls[0], { registrationId: 1, pushToken: 'later-tok' });
});

test('registration never throws when the upload fails', async () => {
  const { client } = fakeClient({ throws: true });
  const { platform } = fakePlatform({ token: 'tok' });
  await assert.doesNotReject(registerPushToken({ client, registrationId: 9, platform }));
});

test('revoke uploads an empty token and deletes the local token', async () => {
  const { client, calls } = fakeClient();
  const fp = fakePlatform({ token: 'tok' });

  await revokePushToken({ client, registrationId: 5, platform: fp.platform });
  assert.deepEqual(calls, [{ registrationId: 5, pushToken: '' }]);
  assert.equal(fp.deleted(), true);
});

test('revoke never throws when the backend revoke fails', async () => {
  const { client } = fakeClient({ throws: true });
  const fp = fakePlatform({ token: 'tok' });
  await assert.doesNotReject(revokePushToken({ client, registrationId: 5, platform: fp.platform }));
});
