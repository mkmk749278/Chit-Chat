import { HttpException } from '@nestjs/common';
import type { AddOneTimePreKeysResponse, AuthContext } from '@chat-app/types';

import { FirebaseAuthGuard, type FirebaseAdminService } from '../auth';
import type { RateLimiterService } from '../redis';
import { DevicesController } from './devices.controller';
import type { DevicesService } from './devices.service';
import type { AddOneTimePreKeysDto, RegisterDeviceDto } from './dto';

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
  const firebaseAdmin = { getVerifiedPhoneNumber: jest.fn() } as unknown as FirebaseAdminService;
  return { controller: new DevicesController(devices, rateLimiter, firebaseAdmin), addOneTimePreKeys };
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

describe('DevicesController.register — discovery phone number', () => {
  const REGISTER_DTO = {
    registrationId: 7,
    identityKey: 'aWQ=',
    signedPreKey: { keyId: 1, publicKey: 'cGs=', signature: 'c2ln' },
    oneTimePreKeys: [{ keyId: 1, publicKey: 'b3Q=' }],
    phoneNumber: '+15550000001',
  } as unknown as RegisterDeviceDto;

  function makeRegister(verifiedPhone: string | undefined) {
    const registerDevice = jest.fn().mockResolvedValue({ deviceId: 'd1' });
    const devices = { registerDevice } as unknown as DevicesService;
    const rateLimiter = { hit: jest.fn().mockResolvedValue({ allowed: true }) } as unknown as RateLimiterService;
    const getVerifiedPhoneNumber = jest.fn().mockResolvedValue(verifiedPhone);
    const firebaseAdmin = { getVerifiedPhoneNumber } as unknown as FirebaseAdminService;
    return {
      controller: new DevicesController(devices, rateLimiter, firebaseAdmin),
      registerDevice,
      getVerifiedPhoneNumber,
    };
  }

  it('stores the phone from the verified token, never the client-supplied one', async () => {
    const { controller, registerDevice, getVerifiedPhoneNumber } = makeRegister(undefined);
    await controller.register({ ...AUTH, phoneNumber: '+15550000009' }, REGISTER_DTO);
    expect(registerDevice).toHaveBeenCalledWith('caller-uid', REGISTER_DTO, '+15550000009');
    expect(getVerifiedPhoneNumber).not.toHaveBeenCalled();
  });

  it('falls back to the Firebase account phone when the token has no phone claim', async () => {
    const { controller, registerDevice } = makeRegister('+15550000009');
    await controller.register(AUTH, REGISTER_DTO);
    expect(registerDevice).toHaveBeenCalledWith('caller-uid', REGISTER_DTO, '+15550000009');
  });

  it('stores no phone at all rather than trusting the client value', async () => {
    const { controller, registerDevice } = makeRegister(undefined);
    await controller.register(AUTH, REGISTER_DTO);
    // The client claimed +15550000001; with no verified number nothing is stored.
    expect(registerDevice).toHaveBeenCalledWith('caller-uid', REGISTER_DTO, undefined);
  });
});
