import type { DevicesService } from '../devices';
import { PushNotificationService } from './push-notification.service';
import type { PushSender } from './push-sender';

/**
 * Unit tests for {@link PushNotificationService} (Req 6.2). Verifies it wakes only recipients
 * with registered tokens, sends a CONTENT-FREE payload (no message/sender data), and never
 * throws — push is best-effort on top of store-and-forward.
 */

function build(opts: { tokens?: string[]; getThrows?: boolean; sendThrows?: boolean }): {
  service: PushNotificationService;
  send: jest.Mock;
  getPushTokens: jest.Mock;
} {
  const getPushTokens = jest.fn(
    opts.getThrows ? () => Promise.reject(new Error('db down')) : async () => opts.tokens ?? [],
  );
  const devices = { getPushTokens } as unknown as DevicesService;
  const send = jest.fn(
    opts.sendThrows ? () => Promise.reject(new Error('fcm down')) : async () => undefined,
  );
  const sender = { send } as unknown as PushSender;
  return { service: new PushNotificationService(devices, sender), send, getPushTokens };
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
