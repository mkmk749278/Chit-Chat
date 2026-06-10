/**
 * ResolvePhoneDto — runtime validation for `POST /api/directory/resolve`.
 *
 * Implements the `ResolvePhoneRequest` shape from `@chat-app/types`, adding the
 * class-validator rules the global ValidationPipe enforces before the handler runs. The
 * phone must be a well-formed E.164 number; a malformed body is rejected with HTTP 400
 * before any database access. The global pipe's `whitelist` + `forbidNonWhitelisted`
 * strips/rejects any property not declared here.
 */

import { Matches } from 'class-validator';
import type { ResolvePhoneRequest } from '@chat-app/types';

/**
 * E.164: a leading `+`, a non-zero leading digit, then 6..14 more digits. This is the exact
 * pattern the client's Sign_In_Screen builds and validates, so the two ends agree without
 * pulling in `libphonenumber-js` (an optional class-validator peer dependency).
 */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export class ResolvePhoneDto implements ResolvePhoneRequest {
  /** Recipient phone number in E.164 form (e.g. `+919618579123`). */
  @Matches(E164_PATTERN, { message: 'phoneNumber must be a valid E.164 number (e.g. +919618579123)' })
  phoneNumber!: string;
}
