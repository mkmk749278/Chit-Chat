/**
 * `apps/mobile` auth adapters barrel.
 *
 * Re-exports the mobile platform binding of the shared `AuthTokenProvider` port so the
 * app bootstrap can construct it without reaching into the file directly.
 */

export { FirebaseAuthAdapter } from './firebase-auth.adapter';
