// Crypto runtime polyfills (CSPRNG, WebCrypto subtle, Buffer) MUST load before any
// @chat-app/crypto code runs — keep this import first.
import './src/polyfills';

import { registerRootComponent } from 'expo';
import messaging from '@react-native-firebase/messaging';

import App from './App';

// Offline push (Req 6.2/6.3): a background handler MUST be registered at the entry point (outside the
// React tree) so the OS can deliver our CONTENT-FREE data wake-push (`{type:'wake'}`) while the app is
// backgrounded/quit. The wake carries no content — the client drains the encrypted offline queue over
// the WebSocket on its next (re)connect — so the handler itself has no work to do here; registering it
// is what lets FCM deliver the data message at all. Best-effort: never throw out of the entry point.
try {
  messaging().setBackgroundMessageHandler(async () => {
    // Intentionally empty: the data-only wake exists purely to nudge delivery; the queue is drained
    // by the foreground WebSocket reconnect. (A headless-task WS drain can be added later if needed.)
  });
} catch {
  // FCM unavailable (e.g. a build without google-services.json) — degrade silently to no wake pushes.
}

// Expo entry point. Registers the root component so the app can boot.
registerRootComponent(App);
