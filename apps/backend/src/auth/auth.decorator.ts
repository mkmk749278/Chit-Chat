/**
 * `@Auth()` param decorator — design Component 3 (Requirements 2.1, 13.1).
 *
 * Reads the verified {@link AuthContext} that {@link FirebaseAuthGuard} attached to
 * the request (`request.authContext`) and injects it into a controller handler
 * parameter, so handlers consume a typed identity instead of re-parsing headers:
 *
 * ```ts
 * @Post('register')
 * @UseGuards(FirebaseAuthGuard)
 * register(@Auth() auth: AuthContext, @Body() dto: RegisterDeviceDto) { ... }
 * ```
 *
 * The decorator is purely a read of guard-populated state — it performs no token
 * extraction or verification of its own, and never touches the database. It must
 * therefore only be used on routes also protected by {@link FirebaseAuthGuard};
 * when the context is absent (the decorator was used without the guard) it throws
 * an {@link UnauthorizedException} (401) rather than handing a controller an
 * undefined identity, so an unauthenticated request can never reach handler logic
 * (Requirements 2.1, 13.5).
 */

import {
  createParamDecorator,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthContext } from '@chat-app/types';

import type { AuthenticatedRequest } from './firebase-auth.guard';

/**
 * Injects the verified {@link AuthContext} populated by {@link FirebaseAuthGuard}.
 *
 * @throws UnauthorizedException when no `AuthContext` is present on the request —
 *   i.e. the route was not protected by the guard (fail closed, Requirement 13.5).
 */
export const Auth = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authContext = request.authContext;
    if (authContext === undefined) {
      // Fail closed: the decorator must never yield an unauthenticated identity.
      throw new UnauthorizedException('Unauthorized');
    }
    return authContext;
  },
);
