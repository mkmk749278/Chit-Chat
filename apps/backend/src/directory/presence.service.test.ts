import type { TransactionService } from '../database';
import type { PresenceRegistryService } from '../redis';
import { PresenceService } from './presence.service';

/**
 * Unit tests for {@link PresenceService} (Req 5.1, 5.2, 5.4). Exercised with fakes for the
 * transaction manager + presence registry, asserting the privacy-first contract:
 *   - an opted-out (or unknown) user is reported `{ online: null, lastSeen: null }`;
 *   - an opted-in online user is `{ online: true, lastSeen: null }`;
 *   - an opted-in offline user gets `online: false` and a COARSE last-seen (5-min bucket).
 */

function buildService(opts: {
  presenceEnabled?: boolean | undefined;
  userExists?: boolean;
  online?: boolean;
  lastSeen?: number | null;
}): { service: PresenceService; isOnline: jest.Mock; getLastSeen: jest.Mock; upsert: jest.Mock } {
  const userExists = opts.userExists ?? true;
  const manager = {
    findOne: jest.fn().mockResolvedValue(
      userExists ? { firebaseUid: 'u', presenceEnabled: opts.presenceEnabled ?? false } : null,
    ),
    upsert: jest.fn().mockResolvedValue(undefined),
  };
  const transactions = {
    runInTransaction: <T>(fn: (m: typeof manager) => Promise<T>): Promise<T> => fn(manager),
  } as unknown as TransactionService;
  const isOnline = jest.fn().mockResolvedValue(opts.online ?? false);
  const getLastSeen = jest.fn().mockResolvedValue(opts.lastSeen ?? null);
  const registry = { isOnline, getLastSeen } as unknown as PresenceRegistryService;
  return { service: new PresenceService(transactions, registry), isOnline, getLastSeen, upsert: manager.upsert };
}

describe('PresenceService.getPresence', () => {
  it('hides an opted-out user as { online: null, lastSeen: null } (Req 5.1)', async () => {
    const { service, isOnline } = buildService({ presenceEnabled: false, online: true });
    expect(await service.getPresence('u')).toEqual({ uid: 'u', online: null, lastSeen: null });
    // Never even consults the live registry for an opted-out user.
    expect(isOnline).not.toHaveBeenCalled();
  });

  it('hides an unknown user the same way as opted-out', async () => {
    const { service } = buildService({ userExists: false });
    expect(await service.getPresence('nope')).toEqual({ uid: 'nope', online: null, lastSeen: null });
  });

  it('reports an opted-in online user with no last-seen', async () => {
    const { service } = buildService({ presenceEnabled: true, online: true });
    expect(await service.getPresence('u')).toEqual({ uid: 'u', online: true, lastSeen: null });
  });

  it('coarsens last-seen to a 5-minute bucket for an opted-in offline user (Req 5.4)', async () => {
    // 10:07:43.500 → bucket floored to 10:05:00.
    const exact = Date.UTC(2026, 0, 1, 10, 7, 43, 500);
    const bucket = Date.UTC(2026, 0, 1, 10, 5, 0, 0);
    const { service } = buildService({ presenceEnabled: true, online: false, lastSeen: exact });
    expect(await service.getPresence('u')).toEqual({ uid: 'u', online: false, lastSeen: bucket });
  });

  it('returns null last-seen for an opted-in offline user with no record', async () => {
    const { service } = buildService({ presenceEnabled: true, online: false, lastSeen: null });
    expect(await service.getPresence('u')).toEqual({ uid: 'u', online: false, lastSeen: null });
  });
});

describe('PresenceService.setEnabled', () => {
  it('upserts the opt-in flag on the user row', async () => {
    const { service, upsert } = buildService({});
    await service.setEnabled('u', true);
    expect(upsert).toHaveBeenCalledWith(expect.anything(), { firebaseUid: 'u', presenceEnabled: true }, [
      'firebaseUid',
    ]);
  });
});
