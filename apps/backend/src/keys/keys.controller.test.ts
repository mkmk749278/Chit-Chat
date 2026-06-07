import { NotFoundException } from '@nestjs/common';
import type { AuthContext, PreKeyBundleResponse } from '@chat-app/types';

import { FirebaseAuthGuard } from '../auth';
import { KeysController } from './keys.controller';
import type { PreKeyClaimService } from './pre-key-claim.service';

/**
 * Unit tests for {@link KeysController} (task 4.4, Requirement 5.1). The controller is
 * pure orchestration over {@link PreKeyClaimService}, so it is exercised directly with a
 * stubbed service rather than booting Nest:
 *
 * - a successful claim returns the service's {@link PreKeyBundleResponse};
 * - a recipient with no device → the service throws {@link NotFoundException} (HTTP 404),
 *   which propagates unchanged;
 * - the route is protected by the Phase 0 {@link FirebaseAuthGuard} (HTTP 401 for an
 *   unauthenticated caller), asserted via the guard metadata Nest reads at runtime.
 */

const AUTH: AuthContext = { uid: 'caller-uid', tokenExp: 9_999_999_999 };

const BUNDLE: PreKeyBundleResponse = {
  deviceId: 'device-1',
  registrationId: 7,
  identityKey: 'aWRrZXk=',
  signedPreKey: { keyId: 0, publicKey: 'c3Br', signature: 'c2ln' },
  oneTimePreKey: { keyId: 1, publicKey: 'b3Rw' },
};

describe('KeysController.claim', () => {
  it('returns the claimed bundle from the service on success (5.1)', async () => {
    const claimForUser = jest.fn().mockResolvedValue(BUNDLE);
    const controller = new KeysController({ claimForUser } as unknown as PreKeyClaimService);

    const result = await controller.claim(AUTH, 'recipient-uid');

    expect(result).toBe(BUNDLE);
    expect(claimForUser).toHaveBeenCalledWith('recipient-uid');
  });

  it('propagates NotFoundException (404) when the recipient has no device (5.1)', async () => {
    const claimForUser = jest.fn().mockRejectedValue(new NotFoundException());
    const controller = new KeysController({ claimForUser } as unknown as PreKeyClaimService);

    await expect(controller.claim(AUTH, 'ghost-uid')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('guards the claim route with FirebaseAuthGuard (401 for unauthenticated callers)', () => {
    // Nest reads guards from this metadata key at request time; asserting it is present
    // verifies the route is authenticated without booting the HTTP layer.
    const guards = Reflect.getMetadata('__guards__', KeysController.prototype.claim) as unknown[];
    expect(Array.isArray(guards)).toBe(true);
    expect(guards).toContain(FirebaseAuthGuard);
  });
});
