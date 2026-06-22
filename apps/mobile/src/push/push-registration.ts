/**
 * `apps/mobile` — FCM push registration orchestration (Phase 2, Req 6.2/6.3; production-readiness
 * roadmap P0 "offline push", mobile half).
 *
 * Wires the device's FCM token to the backend so it can send content-free WAKE pushes while the user
 * is offline (the backend `FcmPushSender` delivers a data-only `{type:'wake'}` message; the client
 * connects and drains the encrypted offline queue — plaintext never traverses the push transport,
 * invariant C1).
 *
 * This module is platform-agnostic and fully unit-testable: the Firebase-specific surface is injected
 * as a {@link PushPlatform} (the real one lives in `firebase-push-platform.ts`, the only file that
 * imports `@react-native-firebase/messaging`). Everything here is best-effort — every path swallows
 * errors so a push failure can NEVER break bootstrap, messaging, or sign-out; push is an optimization
 * on top of store-and-forward.
 */

import type { PushTokenClient } from '../api/api-clients';

/**
 * The narrow platform surface this orchestration drives, so it can be faked in tests and so the only
 * file importing the native FCM module is the thin adapter that implements this.
 */
export interface PushPlatform {
  /**
   * Request notification permission (if not already granted) and return the current FCM token, or
   * `null` when permission was denied or no token is available. Must not throw.
   */
  acquireToken(): Promise<string | null>;
  /** Subscribe to FCM token rotations; returns an unsubscribe. Must not throw. */
  onTokenRefresh(listener: (token: string) => void): () => void;
  /** Delete the local FCM token (on explicit sign-out). Must not throw. */
  deleteToken(): Promise<void>;
}

/** Injected collaborators so registration is testable and decoupled from controller wiring. */
export interface PushRegistrationDeps {
  /** Uploads/revokes the token for a device, selected by its libsignal registration id. */
  client: PushTokenClient;
  /** This device's libsignal registration id (selects which device the token belongs to). */
  registrationId: number;
  /** The Firebase Messaging adapter, or `null` when FCM is unavailable (→ the whole flow no-ops). */
  platform: PushPlatform | null;
}

/** Detaches the token-refresh listener registered by {@link registerPushToken}. */
export type Unsubscribe = () => void;

const NO_OP: Unsubscribe = () => undefined;

/**
 * Register this device's FCM token with the backend and keep it fresh. Best-effort and idempotent:
 * if FCM is unavailable, permission is denied, or the upload fails, it returns a no-op unsubscribe —
 * the app still works, just without offline wake pushes.
 */
export async function registerPushToken(deps: PushRegistrationDeps): Promise<Unsubscribe> {
  const { platform } = deps;
  if (platform === null) {
    return NO_OP;
  }
  try {
    const token = await platform.acquireToken();
    if (token !== null && token.length > 0) {
      await deps.client.setPushToken(deps.registrationId, token);
    }
    // Re-upload whenever FCM rotates the token, so the backend never holds a stale one.
    const unsubscribe = platform.onTokenRefresh((next) => {
      if (typeof next === 'string' && next.length > 0) {
        void deps.client.setPushToken(deps.registrationId, next);
      }
    });
    return typeof unsubscribe === 'function' ? unsubscribe : NO_OP;
  } catch {
    // FCM unavailable / permission flow failed: degrade silently to no offline push.
    return NO_OP;
  }
}

/**
 * Revoke this device's push token on explicit sign-out (Req 6.4): tell the backend to stop pushing
 * (empty token) and delete the local FCM token so a new sign-in mints a fresh one. Best-effort.
 */
export async function revokePushToken(deps: PushRegistrationDeps): Promise<void> {
  try {
    await deps.client.setPushToken(deps.registrationId, '');
  } catch {
    // ignore — backend revocation is best-effort
  }
  if (deps.platform === null) {
    return;
  }
  try {
    await deps.platform.deleteToken();
  } catch {
    // ignore — local token deletion is best-effort
  }
}
