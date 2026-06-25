/**
 * `apps/mobile` — local notification presentation for offline WAKE pushes (Phase 2, Req 6.2/6.3,
 * client half; production-readiness roadmap P0 "offline push").
 *
 * The backend sends a CONTENT-FREE, data-only wake push (`{type:'wake'}`) when a message is queued
 * for an offline recipient. While the app is backgrounded or killed there is no live WebSocket to
 * deliver over, so to alert the user that something arrived the FCM background handler presents a
 * GENERIC local notification through this module. It deliberately shows NO sender and NO message
 * content — the body is still end-to-end encrypted and can only be read once the app reopens,
 * reconnects, and drains the encrypted offline queue (cross-cutting invariant C1). Tapping the
 * notification opens the app, which reconnects and delivers the queued messages.
 *
 * This is the ONLY file that imports `expo-notifications`, mirroring how `firebase-push-platform.ts`
 * isolates the native FCM module. Every function is best-effort and total (never throws), so a
 * notifications failure can never break the push/messaging flow.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/** Android notification channel for incoming-message alerts (high importance ⇒ heads-up). */
const ANDROID_CHANNEL_ID = 'messages';

/**
 * Prepare local notifications: request OS permission (Android 13+ POST_NOTIFICATIONS / iOS alerts)
 * and create the Android message channel so wake alerts can be shown. Idempotent and best-effort —
 * a denied permission or a failure just means no offline alerts; the store-and-forward queue still
 * drains on the next foreground reconnect. Call once at startup.
 */
export async function setupNotifications(): Promise<void> {
  try {
    await Notifications.requestPermissionsAsync();
  } catch {
    // best-effort: a denied/unavailable permission just means no offline alerts.
  }
  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: 'Messages',
        importance: Notifications.AndroidImportance.HIGH,
      });
    } catch {
      // best-effort
    }
  }
}

/**
 * Present a GENERIC "New message" notification for a content-free wake push. Shows no sender and no
 * message text (the content is still encrypted) — just enough to prompt the user to open the app,
 * which reconnects and drains the encrypted offline queue. Best-effort; never throws. On Android the
 * notification is routed to the high-importance {@link ANDROID_CHANNEL_ID} channel (presented
 * immediately); on iOS it presents immediately with no trigger.
 */
export async function presentWakeNotification(): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: { title: 'New message', body: 'Open Lumin to read your messages.' },
      trigger: Platform.OS === 'android' ? { channelId: ANDROID_CHANNEL_ID } : null,
    });
  } catch {
    // best-effort: failing to present an alert must never break message delivery.
  }
}
