'use client';

/**
 * `RegistryConversation` — renders one conversation (surface OR shadow) out of the shared
 * {@link ConversationRegistry} (Shadow Chat, task 15.2 supporting wiring).
 *
 * After a shadow chat is created (long-press) or re-opened (typed `/alias`), the app navigates here.
 * The conversation's message history lives in the registry (keyed `shadow:${threadId}` or
 * `surface:${remoteUid}`), so it stays fully isolated from every other conversation (Correctness
 * Property 8) and a shadow thread never appears in the surface chat list. This view sources its
 * messages from `registry.getState(key)` and appends locally-composed outbound messages back into
 * the registry — shadow seqs use the `+1e9` offset so they stay disjoint from surface seqs.
 *
 * It reuses the shared presentational {@link ConversationScreen} by composing a render state from
 * the registry's per-thread state plus this view's local composer text. It performs no network I/O
 * (the demo web client has no live transport yet); the point of this view is to prove the created
 * shadow thread is real, openable, and isolated.
 */

import { useCallback, useRef, useState } from 'react';

import {
  SHADOW_SEQ_OFFSET,
  type ConversationKey,
  type ConversationRegistry,
  type ConversationState,
} from '@chat-app/crypto';

import { ConversationScreen } from './ConversationScreen';

export interface RegistryConversationProps {
  /** The shared per-thread registry holding this conversation's state. */
  registry: ConversationRegistry;
  /** Which conversation to render (surface or shadow). */
  conversationKey: ConversationKey;
  /** The signed-in user's display label. */
  selfLabel: string;
}

export function RegistryConversation({ registry, conversationKey, selfLabel }: RegistryConversationProps): JSX.Element {
  const [composerText, setComposerText] = useState('');
  // A monotonic tick to force a re-read of the (mutable) registry state after an append.
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);

  const isShadow = conversationKey.kind === 'shadow';
  // Per-conversation outbound seq: shadow seqs ride the +1e9 offset to stay disjoint from surface.
  const seqRef = useRef(isShadow ? SHADOW_SEQ_OFFSET : 0);

  const base = registry.getState(conversationKey);
  const viewState: ConversationState = {
    ...base,
    connection: 'connected',
    webWarningAcknowledged: true,
    composer: { text: composerText, canSend: composerText.trim().length > 0 },
  };

  const onSend = useCallback((): void => {
    const text = composerText.trim();
    if (text.length === 0) {
      return;
    }
    const seq = (seqRef.current += 1);
    // Route the optimistic outbound message into the right per-thread state. A shadow event carries
    // the threadId (+ peerUid); a surface event carries only the remoteUid.
    if (conversationKey.kind === 'shadow') {
      registry.apply({
        type: 'message-appended',
        message: { id: `local-${seq}`, seq, direction: 'out', text, status: 'sent' },
        remoteUid: conversationKey.peerUid,
        threadId: conversationKey.threadId,
      });
    } else {
      registry.apply({
        type: 'message-appended',
        message: { id: `local-${seq}`, seq, direction: 'out', text, status: 'sent' },
        remoteUid: conversationKey.remoteUid,
      });
    }
    setComposerText('');
    rerender();
  }, [composerText, conversationKey, registry, rerender]);

  // Local-only Clear chat: reset this SURFACE conversation's in-memory history to empty via
  // `conversation-cleared`, then re-read the registry. Offered for surface conversations only —
  // shadow threads are not cleared here (parity with mobile). The thread stays open, now empty.
  const onClearChat = useCallback((): void => {
    if (conversationKey.kind !== 'surface') {
      return;
    }
    registry.apply({ type: 'conversation-cleared', remoteUid: conversationKey.remoteUid });
    rerender();
  }, [conversationKey, registry, rerender]);

  return (
    <ConversationScreen
      state={viewState}
      selfLabel={selfLabel}
      onComposerChange={setComposerText}
      onSend={onSend}
      onClearChat={conversationKey.kind === 'surface' ? onClearChat : undefined}
    />
  );
}
