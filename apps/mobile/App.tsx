/**
 * Mobile app container (Phase 1, design Client Component 7: UI).
 *
 * Composes the shared, pure pieces into the running Mobile_App screen, mirroring the web
 * container: it owns the single `ConversationState` via the shared `reduce` reducer from
 * `@chat-app/crypto` (so mobile and web render through one path, Requirement 6.7), shows
 * `SignInScreen` until the user signs in, then `ConversationScreen`, and routes user
 * intent through the injected {@link ChatController}.
 *
 * The {@link ChatController} is the seam to the crypto core; task 6.9 swaps the in-memory
 * demo controller for the real Firebase (RN) + SQLCipher + native-libsignal + Messaging
 * wiring without touching the screens.
 */

import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { SafeAreaView, StyleSheet } from 'react-native';

import { initialConversationState, reduce } from '@chat-app/crypto';

import { createMobileController, type ChatController } from './src/app/chat-controller';
import { ConversationScreen } from './src/ui/ConversationScreen';
import { SignInScreen } from './src/ui/SignInScreen';

export default function App(): React.JSX.Element {
  const controllerRef = useRef<ChatController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createMobileController();
  }
  const controller = controllerRef.current;

  const [state, dispatch] = useReducer(reduce, undefined, () =>
    initialConversationState('mobile'),
  );
  const [uid, setUid] = useState<string | null>(null);

  useEffect(() => controller.subscribe((event) => dispatch(event)), [controller]);

  const requestOtp = useCallback((e164: string) => controller.requestOtp(e164), [controller]);

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

  const onComposerChange = useCallback((text: string) => {
    dispatch({ type: 'composer-changed', text });
  }, []);

  const onSend = useCallback(() => {
    const text = state.composer.text.trim();
    if (text.length === 0) {
      return;
    }
    // The controller owns the message lifecycle: it emits `message-appended` and the
    // subsequent status updates, which flow back into the reducer via `subscribe`.
    dispatch({ type: 'composer-changed', text: '' });
    void controller.send(text);
  }, [state.composer.text, controller]);

  return (
    <SafeAreaView style={styles.root}>
      {uid === null ? (
        <SignInScreen onRequestOtp={requestOtp} onConfirmOtp={confirmOtp} />
      ) : (
        <ConversationScreen
          state={state}
          selfLabel={uid}
          onComposerChange={onComposerChange}
          onSend={onSend}
        />
      )}
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#fff' },
});
