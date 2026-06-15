import { NotFoundException } from '@nestjs/common';

import { OneTimePreKeyEntity, type TransactionService } from '../database';
import { DevicesService } from './devices.service';
import type { AddOneTimePreKeysDto } from './dto';

/**
 * Unit tests for {@link DevicesService.addOneTimePreKeys} (CC2 — one-time prekey
 * replenishment). The transactional write is exercised with a fake EntityManager driven
 * through a stubbed {@link TransactionService}, without booting Nest or a database.
 */

function harness(): {
  service: DevicesService;
  mgr: { findOneBy: jest.Mock; insert: jest.Mock; delete: jest.Mock };
} {
  const mgr = { findOneBy: jest.fn(), insert: jest.fn(), delete: jest.fn() };
  const transactions = {
    runInTransaction: <T>(cb: (m: typeof mgr) => Promise<T>): Promise<T> => cb(mgr),
  } as unknown as TransactionService;
  return { service: new DevicesService(transactions), mgr };
}

const dto: AddOneTimePreKeysDto = {
  registrationId: 7,
  oneTimePreKeys: [
    { keyId: 100, publicKey: Buffer.from('a').toString('base64') },
    { keyId: 101, publicKey: Buffer.from('b').toString('base64') },
  ],
};

describe('DevicesService.addOneTimePreKeys', () => {
  it('appends the new prekeys to the device without deleting any', async () => {
    const { service, mgr } = harness();
    mgr.findOneBy.mockResolvedValueOnce({ id: 'u1' }).mockResolvedValueOnce({ id: 'd1' });

    const res = await service.addOneTimePreKeys('uid', dto);

    expect(res).toEqual({ added: 2 });
    expect(mgr.insert).toHaveBeenCalledTimes(1);
    const [entity, rows] = mgr.insert.mock.calls[0] as [unknown, Array<{ deviceId: string; keyId: number; publicKey: Buffer }>];
    expect(entity).toBe(OneTimePreKeyEntity);
    expect(rows).toHaveLength(2);
    expect(rows[0].deviceId).toBe('d1');
    expect(rows[0].keyId).toBe(100);
    expect(Buffer.isBuffer(rows[0].publicKey)).toBe(true);
    // Replenishment must never wipe the existing supply.
    expect(mgr.delete).not.toHaveBeenCalled();
  });

  it('throws 404 when the caller has no user record', async () => {
    const { service, mgr } = harness();
    mgr.findOneBy.mockResolvedValueOnce(null);
    await expect(service.addOneTimePreKeys('uid', dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(mgr.insert).not.toHaveBeenCalled();
  });

  it('throws 404 when no device matches the registrationId', async () => {
    const { service, mgr } = harness();
    mgr.findOneBy.mockResolvedValueOnce({ id: 'u1' }).mockResolvedValueOnce(null);
    await expect(service.addOneTimePreKeys('uid', dto)).rejects.toBeInstanceOf(NotFoundException);
    expect(mgr.insert).not.toHaveBeenCalled();
  });
});
