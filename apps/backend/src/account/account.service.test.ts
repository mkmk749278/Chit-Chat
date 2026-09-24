import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import type { AuthContext } from '@chat-app/types';

import { FirebaseAuthGuard, type FirebaseAdminService } from '../auth';
import { UserEntity, type TransactionService } from '../database';
import type { RateLimiterService, TokenCacheService } from '../redis';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

/**
 * Unit tests for permanent account deletion. The service is driven with a fake EntityManager,
 * Redis, and Firebase Admin; the controller with stubs — no Nest boot, no database.
 */

const AUTH: AuthContext = { uid: 'alice', tokenExp: 9_999_999_999 };

function harness(opts: { firebaseFails?: boolean } = {}) {
  const calls: string[] = [];
  const mgr = {
    delete: jest.fn(async () => {
      calls.push('db');
    }),
  };
  const transactions = {
    runInTransaction: <T>(cb: (m: typeof mgr) => Promise<T>): Promise<T> => cb(mgr),
  } as unknown as TransactionService;
  const del = jest.fn(async () => {
    calls.push('redis');
    return 1;
  });
  const redis = { del } as unknown as ConstructorParameters<typeof AccountService>[1];
  const deleteUser = jest.fn(async () => {
    calls.push('firebase');
    if (opts.firebaseFails) throw new Error('firebase unreachable');
  });
  const firebaseAdmin = { deleteUser } as unknown as FirebaseAdminService;
  return { service: new AccountService(transactions, redis, firebaseAdmin), mgr, del, deleteUser, calls };
}

describe('AccountService.deleteAccount', () => {
  it('deletes the user row (cascading devices/prekeys), per-user Redis state, then the Firebase user', async () => {
    const { service, mgr, del, deleteUser, calls } = harness();

    await service.deleteAccount('alice');

    expect(mgr.delete).toHaveBeenCalledWith(UserEntity, { firebaseUid: 'alice' });
    expect(del).toHaveBeenCalledWith(
      'inbox:alice',
      'offline:alice',
      'presence:alice',
      'lastseen:alice',
      'blob-quota:alice',
      'push-wake:alice',
    );
    expect(deleteUser).toHaveBeenCalledWith('alice');
    // Own data first, sign-in identity last — so a retry after a Firebase failure converges.
    expect(calls).toEqual(['db', 'redis', 'firebase']);
  });

  it('propagates a Firebase failure after our own data is already gone (retry-safe)', async () => {
    const { service, calls } = harness({ firebaseFails: true });
    await expect(service.deleteAccount('alice')).rejects.toThrow('firebase unreachable');
    expect(calls).toEqual(['db', 'redis', 'firebase']);
  });
});

describe('AccountController.deleteAccount', () => {
  function make(opts: { allowed?: boolean; fails?: boolean } = {}) {
    const deleteAccount = opts.fails
      ? jest.fn().mockRejectedValue(new Error('firebase unreachable'))
      : jest.fn().mockResolvedValue(undefined);
    const accounts = { deleteAccount } as unknown as AccountService;
    const rateLimiter = {
      hit: jest.fn().mockResolvedValue({ allowed: opts.allowed ?? true }),
    } as unknown as RateLimiterService;
    const tokenDelete = jest.fn().mockResolvedValue(undefined);
    const tokenCache = { delete: tokenDelete } as unknown as TokenCacheService;
    return { controller: new AccountController(accounts, rateLimiter, tokenCache), deleteAccount, tokenDelete };
  }

  it('deletes ONLY the caller account and evicts the cached token', async () => {
    const { controller, deleteAccount, tokenDelete } = make();
    await controller.deleteAccount(AUTH, 'Bearer tok-123');
    expect(deleteAccount).toHaveBeenCalledWith('alice');
    expect(tokenDelete).toHaveBeenCalledWith('tok-123');
  });

  it('maps a partial failure to 503 so the client retries', async () => {
    const { controller, tokenDelete } = make({ fails: true });
    await expect(controller.deleteAccount(AUTH, 'Bearer tok')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(tokenDelete).not.toHaveBeenCalled();
  });

  it('rejects with 429 over the per-user limit without deleting anything', async () => {
    const { controller, deleteAccount } = make({ allowed: false });
    await expect(controller.deleteAccount(AUTH, 'Bearer tok')).rejects.toBeInstanceOf(HttpException);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('is guarded by FirebaseAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', AccountController.prototype.deleteAccount) as unknown[];
    expect(guards).toContain(FirebaseAuthGuard);
  });
});
