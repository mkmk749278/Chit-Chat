// Crypto runtime polyfills (CSPRNG, WebCrypto subtle, Buffer) MUST load before any
// @chat-app/crypto code runs — keep this import first.
import './src/polyfills';

import { registerRootComponent } from 'expo';
import messaging from '@react-native-firebase/messaging';

import App from './App';
import { presentWakeNotification, setupNotifications } from './src/push/local-notifications';

// Offline push (Req 6.2/6.3): a background handler MUST be registered at the entry point (outside the
// React tree) so the OS can deliver our CONTENT-FREE data wake-push (`{type:'wake'}`) while the app is
// backgrounded/quit. On a wake we present a GENERIC local notification (no sender, no content — the
// body is still end-to-end encrypted) so the user is alerted that something arrived; tapping it opens
// the app, which reconnects and drains the encrypted offline queue over the WebSocket. Without this,
// a backgrounded/killed app showed nothing until it was manually reopened ("messages only come when
// I open the app"). Best-effort: never throw out of the entry point.
try {
  messaging().setBackgroundMessageHandler(async () => {
    await presentWakeNotification();
  });
} catch {
  // FCM unavailable (e.g. a build without google-services.json) — degrade silently to no wake pushes.
}

// Request notification permission + create the Android channel once at startup so the wake alert can
// actually be shown. Best-effort and fire-and-forget — a denied permission just means no offline
// alerts; the queue still drains on the next foreground reconnect.
void setupNotifications();

// Expo entry point. Registers the root component so the app can boot.
registerRootComponent(App);
