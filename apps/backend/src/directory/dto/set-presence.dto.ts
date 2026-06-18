/**
 * `SetPresenceDto` — request body for `POST /api/directory/presence` (Phase 2 Req 5.1).
 *
 * Implements the `SetPresenceRequest` shape from `@chat-app/types`, adding the class-validator
 * rule the global ValidationPipe enforces before the handler runs.
 */

import { IsBoolean } from 'class-validator';
import type { SetPresenceRequest } from '@chat-app/types';

export class SetPresenceDto implements SetPresenceRequest {
  @IsBoolean()
  enabled!: boolean;
}
