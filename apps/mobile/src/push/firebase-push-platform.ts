/**
 * `apps/mobile` — the ONLY file that imports `@react-native-firebase/messaging`. It implements the
 * narrow {@link PushPlatform} the testable {@link registerPushToken} orchestration drives, keeping the
 * native dependency out of the rest of the codebase (and out of the Node test harness).
 *
 * `acquireToken` requests notification permission and returns the FCM token only when the user
 * granted (or provisionally granted) notifications; every method is total (never throws) so the
 * best-effort registration flow upstream stays simple.
 */

import messaging from '@react-native-firebase/messaging';

import type { PushPlatform } from './push-registration';

/** Build the real Firebase-backed {@link PushPlatform}. */
export function createFirebasePushPlatform(): PushPlatform {
  return {
    async acquireToken(): Promise<string | null> {
      try {
        const status = await messaging().requestPermission();
        const granted =
          status === messaging.AuthorizationStatus.AUTHORIZED ||
          status === messaging.AuthorizationStatus.PROVISIONAL;
        if (!granted) {
          return null;
        }
        const token = await messaging().getToken();
        return typeof token === 'string' && token.length > 0 ? token : null;
      } catch {
        return null;
      }
    },
    onTokenRefresh(listener: (token: string) => void): () => void {
      try {
        return messaging().onTokenRefresh(listener);
      } catch {
        return () => undefined;
      }
    },
    async deleteToken(): Promise<void> {
      try {
        await messaging().deleteToken();
      } catch {
        // best-effort
      }
    },
  };
}
