import { HttpException } from '@nestjs/common';
import type { AddOneTimePreKeysResponse, AuthContext } from '@chat-app/types';

import { FirebaseAuthGuard } from '../auth';
import type { RateLimiterService } from '../redis';
import { DevicesController } from './devices.controller';
import type { DevicesService } from './devices.service';
import type { AddOneTimePreKeysDto } from './dto';

/**
 * Unit tests for {@link DevicesController.addPreKeys} (CC2 replenishment). Pure orchestration
 * over {@link DevicesService} + the rate limiter, exercised with stubs rather than booting Nest.
 */

const AUTH: AuthContext = { uid: 'caller-uid', tokenExp: 9_999_999_999 };
const DTO: AddOneTimePreKeysDto = { registrationId: 7, oneTimePreKeys: [{ keyId: 100, publicKey: 'YQ==' }] };

function make(allowed = true): {
  controller: DevicesController;
  addOneTimePreKeys: jest.Mock;
} {
  const addOneTimePreKeys = jest.fn().mockResolvedValue({ added: 1 } as AddOneTimePreKeysResponse);
  const devices = { addOneTimePreKeys } as unknown as DevicesService;
  const rateLimiter = { hit: jest.fn().mockResolvedValue({ allowed }) } as unknown as RateLimiterService;
  return { controller: new DevicesController(devices, rateLimiter), addOneTimePreKeys };
}

describe('DevicesController.addPreKeys', () => {
  it('appends prekeys via the service and returns the count', async () => {
    const { controller, addOneTimePreKeys } = make();
    const res = await controller.addPreKeys(AUTH, DTO);
    expect(res).toEqual({ added: 1 });
    expect(addOneTimePreKeys).toHaveBeenCalledWith('caller-uid', DTO);
  });

  it('rejects with 429 when the rate limit is exceeded, without calling the service', async () => {
    const { controller, addOneTimePreKeys } = make(false);
    await expect(controller.addPreKeys(AUTH, DTO)).rejects.toBeInstanceOf(HttpException);
    expect(addOneTimePreKeys).not.toHaveBeenCalled();
  });

  it('guards the route with FirebaseAuthGuard (401 for unauthenticated callers)', () => {
    const guards = Reflect.getMetadata('__guards__', DevicesController.prototype.addPreKeys) as unknown[];
    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toContain(FirebaseAuthGuard);
  });
});
