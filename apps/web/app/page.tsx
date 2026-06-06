'use client';

/**
 * Web app container (Phase 1, design Client Component 7: UI).
 *
 * Composes the shared, pure pieces into the running Web_App screen:
 *   - owns the single `ConversationState` via the shared `reduce` reducer from
 *     `@chat-app/crypto`, so the web renders through the exact same logic as mobile
 *     (Requirement 6.7);
 *   - shows `SignInScreen` (with the web ephemerality-warning gate) until the user has
 *     acknowledged the warning AND signed in, then shows `ConversationScreen` — gating
 *     all messaging on the acknowledgment (7.7, 8.3);
 *   - routes user intent (acknowledge / request OTP / confirm OTP / compose / send)
 *     through the injected {@link ChatController}, and feeds controller events back into
 *     the reducer.
 *
 * The {@link ChatController} is the seam to the crypto core; task 7.8 swaps the in-memory
 * demo controller for the real Firebase + Messaging wiring without touching the screens.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import {
  initialConversationState,
  reduce,
  type ConversationEvent,
} from '@chat-app/crypto';

import { ConversationScreen } from './components/ConversationScreen';
import { SignInScreen } from './components/SignInScreen';
import { createDemoController, type ChatController } from './lib/chat-controller';

export default function HomePage(): JSX.Element {
  // The controller is created once per mount; in task 7.8 this becomes the real
  // Firebase + Messaging controller. A ref keeps it stable across renders.
  const controllerRef = useRef<ChatController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createDemoController();
  }
  const controller = controllerRef.current;

  const [state, dispatch] = useReducer(reduce, undefined, () =>
    initialConversationState('web'),
  );
  const [uid, setUid] = useState<string | null>(null);
  // Per-conversation outbound sequence for the optimistic UI append (the real seq is
  // allocated by the shared SequenceAllocator once Messaging is wired in 7.8).
  const seqRef = useRef(0);

  // Feed controller-driven events (inbound messages, ack/timeout status) into the reducer.
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

  const onComposerChange = useCallback((text: string) => {
    dispatch({ type: 'composer-changed', text });
  }, []);

  const onSend = useCallback(() => {
    const text = state.composer.text.trim();
    if (text.length === 0) {
      return;
    }
    const seq = (seqRef.current += 1);
    // Optimistic UI: render the outbound message as `sending` immediately (design §12).
    dispatch({
      type: 'message-appended',
      message: { id: `local-${seq}`, seq, direction: 'out', text, status: 'sending' },
    });
    dispatch({ type: 'composer-changed', text: '' });
    void controller.send(text);
  }, [state.composer.text, controller]);

  // Gate entry to the Conversation_Screen on BOTH sign-in and the acknowledged warning.
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
      <ConversationScreen
        state={state}
        selfLabel={uid}
        onComposerChange={onComposerChange}
        onSend={onSend}
      />
    </div>
  );
}
