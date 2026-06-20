'use client';

/**
 * Web `Conversation_Screen` (Phase 1, design Client Component 7: UI).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 7: UI", and `requirements.md` → Requirements 6.1, 6.2, 6.4,
 *   6.5, 6.6, 6.8, 6.9.
 *
 * A purely presentational component: it renders a {@link ConversationState} produced
 * by the shared `ConversationReducer` (from `@chat-app/crypto`) and reports user intent
 * back through callbacks. It holds NO state and performs NO I/O of its own, so the exact
 * same render logic is shared with the Mobile_App (Requirement 6.7) and stays trivially
 * testable. The container (see `ChatApp`) owns the reducer, transport, and crypto wiring.
 *
 * Rendering rules driven entirely by the reducer state:
 *   - the connection indicator reflects `state.connection` (6.6);
 *   - messages render ascending by `seq`, each once, with a per-message status (6.2, 6.5);
 *   - an inbound delivery-error renders no plaintext (6.9);
 *   - the composer's send control is enabled only when the reducer says so and, on web,
 *     once the ephemerality warning has been acknowledged (6.3, 6.4, 7.7, 8.3).
 */

import type { CSSProperties, FormEvent } from 'react';

import type { ConversationState, RenderableMessage } from '@chat-app/crypto';

export interface ConversationScreenProps {
  /** The render state produced by the shared reducer. */
  state: ConversationState;
  /** The signed-in user's display label (e.g. UID or phone), shown in the header. */
  selfLabel: string;
  /** Called on every composer keystroke with the new raw text (6.3, 6.4). */
  onComposerChange: (text: string) => void;
  /** Called when the user submits the composer (only fired when sending is allowed). */
  onSend: () => void;
  /**
   * Clear this conversation's LOCAL history (the "Clear chat" action, local-only). When provided, a
   * "Clear chat" control is rendered in the header; clicking it confirms, then invokes this callback
   * (the container purges the conversation's in-memory rows and dispatches `conversation-cleared`).
   * Passed ONLY for a SURFACE conversation — absent for a shadow thread, keeping parity with mobile.
   */
  onClearChat?: () => void;
}

/** Human-readable, non-technical label for each message status (6.5, 6.8, 6.9). */
const STATUS_LABEL: Record<RenderableMessage['status'], string> = {
  sending: 'Sending…',
  sent: 'Sent',
  failed: 'Failed',
  received: 'Received',
  'delivery-error': 'Could not be decrypted',
};

export function ConversationScreen({
  state,
  selfLabel,
  onComposerChange,
  onSend,
  onClearChat,
}: ConversationScreenProps): JSX.Element {
  const connected = state.connection === 'connected';
  // On web the reducer gates messaging until the ephemerality warning is acknowledged
  // (7.7, 8.3); combined with the reducer's own composer validation (6.3, 6.4).
  const canSend = state.composer.canSend && state.webWarningAcknowledged;

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (canSend) {
      onSend();
    }
  };

  // Local-only Clear chat: confirm, then let the container purge this conversation's in-memory rows
  // and dispatch `conversation-cleared`. The chat stays open (now empty); this is "clear history".
  const handleClearChat = (): void => {
    if (onClearChat === undefined) {
      return;
    }
    const ok =
      typeof window === 'undefined' ||
      window.confirm('Clear chat? This removes this chat’s messages from this device. It can’t be undone.');
    if (ok) {
      onClearChat();
    }
  };

  return (
    <section aria-label="Conversation" style={styles.screen}>
      <header style={styles.header}>
        <span style={styles.selfLabel}>{selfLabel}</span>
        <span style={styles.headerRight}>
          <span
            role="status"
            aria-label={connected ? 'Connected' : 'Disconnected'}
            style={{ ...styles.connection, color: connected ? '#127a3d' : '#9a3412' }}
          >
            <span
              style={{
                ...styles.connectionDot,
                backgroundColor: connected ? '#16a34a' : '#dc2626',
              }}
            />
            {connected ? 'Connected' : 'Disconnected'}
          </span>
          {onClearChat !== undefined && (
            <button type="button" style={styles.clearButton} onClick={handleClearChat} aria-label="Clear chat">
              Clear chat
            </button>
          )}
        </span>
      </header>

      <ul style={styles.messageList} aria-label="Messages">
        {state.messages.length === 0 ? (
          <li style={styles.empty}>No messages yet. Say hello.</li>
        ) : (
          state.messages.map((message) => (
            <MessageRow key={`${message.direction}:${message.seq}`} message={message} />
          ))
        )}
      </ul>

      <form style={styles.composer} onSubmit={handleSubmit}>
        <input
          aria-label="Message"
          style={styles.input}
          value={state.composer.text}
          placeholder="Type a message"
          onChange={(event) => onComposerChange(event.target.value)}
        />
        <button type="submit" style={styles.sendButton} disabled={!canSend}>
          Send
        </button>
      </form>
    </section>
  );
}

/** A single rendered message row, aligned by direction and labelled by status. */
function MessageRow({ message }: { message: RenderableMessage }): JSX.Element {
  const outbound = message.direction === 'out';
  const isError = message.status === 'delivery-error';
  return (
    <li
      style={{
        ...styles.message,
        alignSelf: outbound ? 'flex-end' : 'flex-start',
        backgroundColor: outbound ? '#dbeafe' : '#f1f5f9',
      }}
    >
      <span style={{ ...styles.messageText, fontStyle: message.text === null ? 'italic' : 'normal' }}>
        {message.text === null ? '⚠ message unavailable' : message.text}
      </span>
      <span style={{ ...styles.messageStatus, color: isError || message.status === 'failed' ? '#b91c1c' : '#64748b' }}>
        {STATUS_LABEL[message.status]}
      </span>
    </li>
  );
}

const styles: Record<string, CSSProperties> = {
  screen: { display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 640, margin: '0 auto' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #e2e8f0',
  },
  selfLabel: { fontWeight: 600 },
  headerRight: { display: 'inline-flex', alignItems: 'center', gap: 12 },
  clearButton: {
    padding: '4px 10px',
    borderRadius: 8,
    border: '1px solid #fecaca',
    background: '#fef2f2',
    color: '#b91c1c',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
  },
  connection: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 },
  connectionDot: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block' },
  messageList: {
    listStyle: 'none',
    margin: 0,
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    flex: 1,
    overflowY: 'auto',
  },
  empty: { color: '#94a3b8', textAlign: 'center', marginTop: 24 },
  message: { maxWidth: '75%', padding: '8px 12px', borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 2 },
  messageText: { fontSize: 15, wordBreak: 'break-word' },
  messageStatus: { fontSize: 11 },
  composer: { display: 'flex', gap: 8, padding: 16, borderTop: '1px solid #e2e8f0' },
  input: { flex: 1, padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 15 },
  sendButton: { padding: '10px 20px', borderRadius: 8, border: 'none', backgroundColor: '#2563eb', color: '#fff', fontWeight: 600, cursor: 'pointer' },
};
