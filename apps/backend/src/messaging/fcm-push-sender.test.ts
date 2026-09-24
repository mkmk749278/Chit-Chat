/**
 * Unit tests for {@link FcmPushSender} (Req 6.2/6.3; roadmap P0 offline push). Verifies it sends a
 * DATA-ONLY (content-free) multicast through the existing Firebase Admin app, self-degrades to a
 * no-op when Firebase isn't initialized (CI / no creds), and never throws — push is best-effort on
 * top of store-and-forward.
 */

jest.mock('firebase-admin/app', () => ({ getApps: jest.fn() }));
jest.mock('firebase-admin/messaging', () => ({ getMessaging: jest.fn() }));

import { getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

import { FIREBASE_APP_NAME } from '../auth/firebase-admin.service';
import { FcmPushSender } from './fcm-push-sender';

const getAppsMock = getApps as unknown as jest.Mock;
const getMessagingMock = getMessaging as unknown as jest.Mock;

/** A fake initialized Admin app registered under the backend's app name. */
const APP = { name: FIREBASE_APP_NAME } as const;

function withMessaging(sendImpl: jest.Mock): void {
  getAppsMock.mockReturnValue([APP]);
  getMessagingMock.mockReturnValue({ sendEachForMulticast: sendImpl });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('FcmPushSender.send', () => {
  it('sends a DATA-ONLY multicast carrying exactly the routing data', async () => {
    const sendEach = jest.fn(async (_message: unknown) => ({
      successCount: 2,
      failureCount: 0,
      responses: [],
    }));
    withMessaging(sendEach);

    await new FcmPushSender().send(['t1', 't2'], { type: 'wake' });

    expect(sendEach).toHaveBeenCalledTimes(1);
    const message = sendEach.mock.calls[0][0] as Record<string, unknown>;
    expect(message.tokens).toEqual(['t1', 't2']);
    expect(message.data).toEqual({ type: 'wake' });
    // Content-free: never a notification block (no banner text / sender plaintext on the wire).
    expect(message).not.toHaveProperty('notification');
  });

  it('is a no-op (no FCM call) when given no tokens', async () => {
    const sendEach = jest.fn();
    withMessaging(sendEach);

    await new FcmPushSender().send([], { type: 'wake' });

    expect(getMessagingMock).not.toHaveBeenCalled();
    expect(sendEach).not.toHaveBeenCalled();
  });

  it('self-degrades to a no-op when the Firebase app is not initialized', async () => {
    getAppsMock.mockReturnValue([]); // no apps (e.g. CI without FIREBASE_* creds)

    await expect(new FcmPushSender().send(['t1'], { type: 'wake' })).resolves.toBeUndefined();
    expect(getMessagingMock).not.toHaveBeenCalled();
  });

  it('never throws when the FCM send fails', async () => {
    const sendEach = jest.fn(async () => {
      throw new Error('fcm down');
    });
    withMessaging(sendEach);

    await expect(new FcmPushSender().send(['t1'], { type: 'wake' })).resolves.toBeUndefined();
  });

  it('never throws when some tokens fail (partial failure)', async () => {
    const sendEach = jest.fn(async () => ({ successCount: 1, failureCount: 1, responses: [] }));
    withMessaging(sendEach);

    await expect(new FcmPushSender().send(['t1', 't2'], { type: 'wake' })).resolves.toEqual({
      invalidTokens: [],
    });
    expect(sendEach).toHaveBeenCalledTimes(1);
  });

  it('reports only permanently invalid tokens for pruning', async () => {
    const sendEach = jest.fn(async () => ({
      successCount: 1,
      failureCount: 2,
      responses: [
        { success: true },
        { success: false, error: { code: 'messaging/registration-token-not-registered' } },
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    }));
    withMessaging(sendEach);

    const result = await new FcmPushSender().send(['t1', 't2', 't3'], { type: 'wake' });

    // t3 failed transiently and must be kept; only the unregistered t2 is pruned.
    expect(result).toEqual({ invalidTokens: ['t2'] });
  });

  it('collapses wake pushes so an offline device keeps only the newest', async () => {
    const sendEach = jest.fn(async (_message: unknown) => ({ successCount: 1, failureCount: 0, responses: [] }));
    withMessaging(sendEach);

    await new FcmPushSender().send(['t1'], { type: 'wake' });

    const message = sendEach.mock.calls[0][0] as { android: Record<string, unknown> };
    expect(message.android).toMatchObject({ priority: 'high', collapseKey: 'wake' });
  });
});
