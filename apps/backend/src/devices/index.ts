/**
 * Public surface of the backend DevicesModule.
 */

export { DevicesModule } from './devices.module';
export { DevicesController } from './devices.controller';
export { DevicesService } from './devices.service';
export { RegisterDeviceDto, SignedPreKeyDto, OneTimePreKeyDto } from './dto';
export {
  SignedPreKeyVerificationPipe,
  INVALID_SIGNED_PREKEY_SIGNATURE_MESSAGE,
} from './signed-prekey-verification.pipe';
