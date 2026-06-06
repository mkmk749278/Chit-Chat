/**
 * Public surface of the backend AuthModule.
 */

export { AuthModule } from './auth.module';
export { FirebaseAdminService } from './firebase-admin.service';
export { TokenVerificationService } from './token-verification.service';
export { FirebaseAuthGuard, type AuthenticatedRequest } from './firebase-auth.guard';
export { Auth } from './auth.decorator';
export { UnauthorizedError } from './unauthorized.error';
export { FirebaseUnavailableError } from './firebase-unavailable.error';
export { ERROR_REPORTER, LoggingErrorReporter, type ErrorReporter } from './error-reporter';
