'use client';

/**
 * Web app container (Phase 1, design Client Component 7: UI; extended for Shadow Chat task 15.2).
 *
 * Composes the shared, pure pieces into the running Web_App screen:
 *   - shows `SignInScreen` (with the web ephemerality-warning gate) until the user has
 *     acknowledged the warning AND signed in, then shows the `ChatHomeScreen` (7.7, 8.3);
 *   - provisions the device-local shadow-secret store and the shared per-thread
 *     `ConversationRegistry` once at boot, and resolves the current `App_Mode`, so the chat home can
 *     drive the Shadow Chat long-press creation flow and the typed-`/alias` re-entry flow
 *     (Shadow Chat Requirements 11, 12);
 *   - routes auth intent (acknowledge / request OTP / confirm OTP) through the injected
 *     {@link ChatController}.
 *
 * The {@link ChatController} is the seam to the crypto core; task 7.8 swaps the in-memory demo
 * controller for the real Firebase + Messaging wiring without touching the screens.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  createConversationRegistry,
  initialConversationState,
  reduce,
  type AppMode,
  type ConversationEvent,
  type ConversationRegistry,
} from '@chat-app/crypto';

import { ChatHomeScreen, type DemoContact } from './components/ChatHomeScreen';
import { SignInScreen } from './components/SignInScreen';
import { createDemoController, type ChatController } from './lib/chat-controller';
import {
  createWebShadowSecretStore,
  registerShadowSecretSessionEndWipe,
  type WebShadowSecretStore,
} from './lib/shadow-secret-persistence';

/**
 * Demo contacts for the web home (the web client has no live directory yet — task 7.8 wires the
 * real contact source). Each row is long-pressable, so the Shadow Chat creation flow is reachable.
 */
const DEMO_CONTACTS: DemoContact[] = [
  { uid: 'demo-uid-alice', name: 'Alice' },
  { uid: 'demo-uid-bob', name: 'Bob' },
  { uid: 'demo-uid-carol', name: 'Carol' },
];

export default function HomePage(): JSX.Element {
  // The controller is created once per mount; in task 7.8 this becomes the real
  // Firebase + Messaging controller. A ref keeps it stable across renders.
  const controllerRef = useRef<ChatController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createDemoController();
  }
  const controller = controllerRef.current;

  // Provision the device-local shadow-secret store ONCE at boot, bound to the web in-memory
  // persistence adapter (Shadow Chat task 12.2). The web client keeps shadow secrets in JS memory
  // only — wiped on tab close / sign-out, never written to web storage (Requirement 9.5) — so the
  // store is ready to release shadow context + alias entries in real-PIN mode for the session.
  const shadowSecretRef = useRef<WebShadowSecretStore | null>(null);
  if (shadowSecretRef.current === null) {
    shadowSecretRef.current = createWebShadowSecretStore();
  }
  const shadowSecret = shadowSecretRef.current;

  // The shared per-thread conversation registry (surface + shadow), created once at boot. Shadow
  // threads opened via creation or `/alias` live here and are excluded from the surface chat list.
  const registryRef = useRef<ConversationRegistry | null>(null);
  if (registryRef.current === null) {
    registryRef.current = createConversationRegistry({ platform: 'web' });
  }
  const registry = registryRef.current;

  // Wipe the in-memory shadow secrets within the same event cycle the browser tears the session
  // down (page unload / tab close), mirroring the in-memory KeyStore's session-end wipe.
  useEffect(() => {
    return registerShadowSecretSessionEndWipe(shadowSecret.persistence);
  }, [shadowSecret]);

  const [state, dispatch] = useReducer(reduce, undefined, () =>
    initialConversationState('web'),
  );
  const [uid, setUid] = useState<string | null>(null);

  // The signed-in web session runs in real-PIN App_Mode (the web client has no decoy-PIN gate yet;
  // task 7.8 wires the real PIN entry). Exposed via a stable getter so the Shadow Chat menu/alias
  // resolution gate correctly. When a decoy/locked mode lands, only this getter changes.
  const getMode = useCallback<() => AppMode | null>(() => 'real', []);

  // Feed controller-driven events (inbound messages, ack/timeout status) into the reducer so the
  // web-warning gate state stays correct.
  useEffect(() => {
    return controller.subscribe((event: ConversationEvent) => dispatch(event));
  }, [controller]);

  const acknowledgeWarning = useCallback(() => {
    dispatch({ type: 'web-warning-acknowledged' });
  }, []);

  const requestOtp = useCallback(
    (e164: string) => controller.requestOtp(e164),
    [controller],
  );

  const confirmOtp = useCallback(
    async (code: string): Promise<boolean> => {
      const signedInUid = await controller.confirmOtp(code);
      if (signedInUid !== null) {
        setUid(signedInUid);
        return true;
      }
      return false;
    },
    [controller],
  );

  // Gate entry to the chat home on BOTH sign-in and the acknowledged warning.
  const signedInAndAcknowledged = uid !== null && state.webWarningAcknowledged;

  if (!signedInAndAcknowledged) {
    return (
      <SignInScreen
        warningAcknowledged={state.webWarningAcknowledged}
        onAcknowledgeWarning={acknowledgeWarning}
        onRequestOtp={requestOtp}
        onConfirmOtp={confirmOtp}
      />
    );
  }

  return (
    <div style={{ height: '100vh' }}>
      <ChatHomeScreen
        myUid={uid as string}
        shadowSecret={shadowSecret}
        registry={registry}
        getMode={getMode}
        contacts={DEMO_CONTACTS}
      />
    </div>
  );
}
