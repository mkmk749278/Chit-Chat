// Crypto runtime polyfills (CSPRNG, WebCrypto subtle, Buffer) MUST load before any
// @chat-app/crypto code runs — keep this import first.
import './src/polyfills';

import { registerRootComponent } from 'expo';

import App from './App';

// Expo entry point. Registers the root component so the app can boot.
// Phase 0 ships a skeleton screen only; real UI lands in later phases.
registerRootComponent(App);
