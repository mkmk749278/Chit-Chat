/**
 * SignedPreKeyVerificationPipe — design Component 4, Requirement 2.9.
 *
 * Cryptographic validation step for `POST /api/devices/register`. After the global
 * ValidationPipe has confirmed the body is a structurally valid {@link RegisterDeviceDto}
 * (base64 key fields, required fields present — Requirements 2.7, 2.8), this pipe verifies
 * that the supplied signed prekey signature was actually produced over the signed prekey
 * public key by the private key paired with the supplied PUBLIC identity key.
 *
 * Verification is delegated to `@chat-app/crypto`'s {@link verifySignedPreKeySignature}
 * (the libsignal wrapper). If the signature does not verify, the pipe throws
 * {@link BadRequestException} (HTTP 400) with an "invalid signed prekey signature"
 * indication.
 *
 * Because NestJS pipes execute before the route handler runs, this check completes BEFORE
 * {@link DevicesService} performs any database access — a registration carrying a bad
 * signature is rejected with no `users`, `devices`, or prekey write attempted
 * (Requirement 2.9). Task 6.4's `DevicesController` applies this pipe on the request body.
 */

import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { verifySignedPreKeySignature } from '@chat-app/crypto';

import { RegisterDeviceDto } from './dto';

/** Client-facing error indication for a signed prekey whose signature fails verification. */
export const INVALID_SIGNED_PREKEY_SIGNATURE_MESSAGE = 'invalid signed prekey signature';

@Injectable()
export class SignedPreKeyVerificationPipe
  implements PipeTransform<RegisterDeviceDto, RegisterDeviceDto>
{
  /**
   * Verifies the signed prekey signature against the supplied public identity key and
   * returns the unchanged DTO on success.
   *
   * @throws {BadRequestException} (HTTP 400) when the signature does not verify, so the
   * request is rejected before any database access.
   */
  transform(value: RegisterDeviceDto): RegisterDeviceDto {
    let verified: boolean;
    try {
      verified = verifySignedPreKeySignature(
        value.identityKey,
        value.signedPreKey.publicKey,
        value.signedPreKey.signature,
      );
    } catch {
      // Structurally malformed key material (e.g. non-base64) is normally rejected earlier
      // by the ValidationPipe's @IsBase64 rules; if any slips through it can never be a
      // valid signature, so treat it as a verification failure rather than a 500.
      verified = false;
    }

    if (!verified) {
      throw new BadRequestException(INVALID_SIGNED_PREKEY_SIGNATURE_MESSAGE);
    }

    return value;
  }
}
