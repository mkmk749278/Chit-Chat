import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { AuthContext, ResolvePhoneResponse } from '@chat-app/types';

import { FirebaseAuthGuard } from '../auth';
import type { RateLimiterService } from '../redis';
import { DirectoryController } from './directory.controller';
import { ResolvePhoneDto } from './dto';
import type { DirectoryService } from './directory.service';

/**
 * Unit tests for {@link DirectoryController} (phone→UID contact discovery). The controller
 * is orchestration over {@link DirectoryService} + {@link RateLimiterService}, so it is
 * exercised directly with stubs rather than booting Nest:
 *
 * - a successful resolve returns the service's `{ uid }`, keyed by the request phone number;
 * - an unknown number → the service throws {@link NotFoundException} (404), propagated;
 * - an over-limit caller is rejected with HTTP 429 before the service is consulted;
 * - a rate-limiter failure fails OPEN (the lookup still runs);
 * - the route is guarded by {@link FirebaseAuthGuard} (401 for unauthenticated callers),
 *   asserted via the guard metadata Nest reads at runtime.
 *
 * The ResolvePhoneDto E.164 validation itself is enforced by the global ValidationPipe and
 * covered separately; these tests focus on controller behavior.
 */

const AUTH: AuthContext = { uid: 'caller-uid', tokenExp: 9_999_999_999 };
const RESPONSE: ResolvePhoneResponse = { uid: 'recipient-uid' };

const dto = (phoneNumber: string): ResolvePhoneDto => Object.assign(new ResolvePhoneDto(), { phoneNumber });

function makeController(overrides: {
  resolvePhone?: jest.Mock;
  whoAmI?: jest.Mock;
  hit?: jest.Mock;
}): { controller: DirectoryController; resolvePhone: jest.Mock; whoAmI: jest.Mock; hit: jest.Mock } {
  const resolvePhone = overrides.resolvePhone ?? jest.fn().mockResolvedValue(RESPONSE);
  const whoAmI =
    overrides.whoAmI ?? jest.fn().mockResolvedValue({ storedPhone: '+919618579123', deviceCount: 1 });
  const hit = overrides.hit ?? jest.fn().mockResolvedValue({ allowed: true });
  const controller = new DirectoryController(
    { resolvePhone, whoAmI } as unknown as DirectoryService,
    { hit } as unknown as RateLimiterService,
  );
  return { controller, resolvePhone, whoAmI, hit };
}

describe('DirectoryController.resolve', () => {
  it('returns the resolved uid from the service on success', async () => {
    const { controller, resolvePhone } = makeController({});

    const result = await controller.resolve(AUTH, dto('+919618579123'));

    expect(result).toBe(RESPONSE);
    expect(resolvePhone).toHaveBeenCalledWith('+919618579123');
  });

  it('propagates NotFoundException (404) when no user owns the number', async () => {
    const resolvePhone = jest.fn().mockRejectedValue(new NotFoundException());
    const { controller } = makeController({ resolvePhone });

    await expect(controller.resolve(AUTH, dto('+919999999999'))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects with 429 when the per-uid rate limit is exceeded, before consulting the service', async () => {
    const hit = jest.fn().mockResolvedValue({ allowed: false });
    const { controller, resolvePhone } = makeController({ hit });

    await expect(controller.resolve(AUTH, dto('+919618579123'))).rejects.toMatchObject({
      constructor: HttpException,
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    expect(resolvePhone).not.toHaveBeenCalled();
    expect(hit).toHaveBeenCalledWith('directory:caller-uid', 60, 60);
  });

  it('fails open (still resolves) when the rate-limiter throws', async () => {
    const hit = jest.fn().mockRejectedValue(new Error('redis down'));
    const { controller, resolvePhone } = makeController({ hit });

    const result = await controller.resolve(AUTH, dto('+919618579123'));

    expect(result).toBe(RESPONSE);
    expect(resolvePhone).toHaveBeenCalledWith('+919618579123');
  });

  it('guards the resolve route with FirebaseAuthGuard (401 for unauthenticated callers)', () => {
    const guards = Reflect.getMetadata('__guards__', DirectoryController.prototype.resolve) as unknown[];
    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toContain(FirebaseAuthGuard);
  });
});

describe('DirectoryController.me (diagnostics)', () => {
  it('reports the token phone (from AuthContext) alongside the stored phone + device count', async () => {
    const whoAmI = jest.fn().mockResolvedValue({ storedPhone: '+919618579123', deviceCount: 2 });
    const { controller } = makeController({ whoAmI });

    const result = await controller.me({ uid: 'caller-uid', phoneNumber: '+919618579123', tokenExp: 9_999_999_999 });

    expect(result).toEqual({
      uid: 'caller-uid',
      tokenPhone: '+919618579123',
      storedPhone: '+919618579123',
      deviceCount: 2,
    });
    expect(whoAmI).toHaveBeenCalledWith('caller-uid');
  });

  it('reports tokenPhone null when the verified token carries no phone claim', async () => {
    const whoAmI = jest.fn().mockResolvedValue({ storedPhone: null, deviceCount: 0 });
    const { controller } = makeController({ whoAmI });

    const result = await controller.me(AUTH); // AUTH has no phoneNumber

    expect(result.tokenPhone).toBeNull();
    expect(result.storedPhone).toBeNull();
  });

  it('guards the me route with FirebaseAuthGuard', () => {
    const guards = Reflect.getMetadata('__guards__', DirectoryController.prototype.me) as unknown[];
    expect(guards).toContain(FirebaseAuthGuard);
  });
});
