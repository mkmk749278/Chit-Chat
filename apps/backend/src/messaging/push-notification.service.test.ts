import type { DevicesService } from '../devices';
import { PushNotificationService, WAKE_DEBOUNCE_SECONDS } from './push-notification.service';
import type { PushSender } from './push-sender';

/**
 * Unit tests for {@link PushNotificationService} (Req 6.2). Verifies it wakes only recipients
 * with registered tokens, sends a CONTENT-FREE payload (no message/sender data), and never
 * throws — push is best-effort on top of store-and-forward.
 */

function build(opts: {
  tokens?: string[];
  getThrows?: boolean;
  sendThrows?: boolean;
  invalidTokens?: string[];
  debounced?: boolean;
  redisThrows?: boolean;
}): {
  service: PushNotificationService;
  send: jest.Mock;
  getPushTokens: jest.Mock;
  removePushTokens: jest.Mock;
  set: jest.Mock;
} {
  const getPushTokens = jest.fn(
    opts.getThrows ? () => Promise.reject(new Error('db down')) : async () => opts.tokens ?? [],
  );
  const removePushTokens = jest.fn().mockResolvedValue(undefined);
  const devices = { getPushTokens, removePushTokens } as unknown as DevicesService;
  const send = jest.fn(
    opts.sendThrows
      ? () => Promise.reject(new Error('fcm down'))
      : async () => (opts.invalidTokens !== undefined ? { invalidTokens: opts.invalidTokens } : undefined),
  );
  const sender = { send } as unknown as PushSender;
  const set = opts.redisThrows
    ? jest.fn().mockRejectedValue(new Error('redis down'))
    : jest.fn().mockResolvedValue(opts.debounced ? null : 'OK');
  const redis = { set } as unknown as ConstructorParameters<typeof PushNotificationService>[2];
  return {
    service: new PushNotificationService(devices, sender, redis),
    send,
    getPushTokens,
    removePushTokens,
    set,
  };
}

describe('PushNotificationService.notify', () => {
  it('sends a content-free wake push to every registered token', async () => {
    const { service, send } = build({ tokens: ['t1', 't2'] });
    await service.notify('bob');
    expect(send).toHaveBeenCalledTimes(1);
    const [tokens, data] = send.mock.calls[0] as [string[], Record<string, string>];
    expect(tokens).toEqual(['t1', 't2']);
    // Content-free: routing metadata only, no message text or sender plaintext (Req 6.2/6.3).
    expect(data).toEqual({ type: 'wake' });
  });

  it('is a no-op when the recipient has no registered token', async () => {
    const { service, send } = build({ tokens: [] });
    await service.notify('bob');
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the token lookup fails', async () => {
    const { service, send } = build({ getThrows: true });
    await expect(service.notify('bob')).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('never throws when the push send fails', async () => {
    const { service } = build({ tokens: ['t1'], sendThrows: true });
    await expect(service.notify('bob')).resolves.toBeUndefined();
  });
});

describe('PushNotificationService.notify — bounding', () => {
  it('debounces: at most one wake per recipient per window', async () => {
    const { service, send, getPushTokens, set } = build({ tokens: ['t1'], debounced: true });
    await service.notify('bob');
    expect(set).toHaveBeenCalledWith('push-wake:bob', '1', 'EX', WAKE_DEBOUNCE_SECONDS, 'NX');
    expect(getPushTokens).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('fails open when the debounce store is unavailable', async () => {
    const { service, send } = build({ tokens: ['t1'], redisThrows: true });
    await service.notify('bob');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('prunes tokens the provider reports as permanently invalid', async () => {
    const { service, removePushTokens } = build({ tokens: ['t1', 't2'], invalidTokens: ['t2'] });
    await service.notify('bob');
    expect(removePushTokens).toHaveBeenCalledWith(['t2']);
  });

  it('does not touch the store when every token is valid', async () => {
    const { service, removePushTokens } = build({ tokens: ['t1'], invalidTokens: [] });
    await service.notify('bob');
    expect(removePushTokens).not.toHaveBeenCalled();
  });
});
