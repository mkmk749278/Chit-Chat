/**
 * SetPushTokenDto — runtime validation for `POST /api/devices/push-token` (Req 6.1).
 *
 * Implements the `SetPushTokenRequest` shape from `@chat-app/types`. Identifies the caller's
 * device by `registrationId` and sets its push token. An empty `pushToken` revokes it (Req 6.4).
 * The global ValidationPipe enforces these rules before any DB access.
 */

import { IsInt, IsString, MaxLength, Min } from 'class-validator';
import type { SetPushTokenRequest } from '@chat-app/types';

export class SetPushTokenDto implements SetPushTokenRequest {
  /** libsignal registration id of the device the token belongs to (>= 1). */
  @IsInt()
  @Min(1)
  registrationId!: number;

  /**
   * Platform push token (e.g. an FCM registration token). Bounded to a sane length; an empty
   * string is accepted and REVOKES the device's token (Req 6.4).
   */
  @IsString()
  @MaxLength(4096)
  pushToken!: string;
}
