/**
 * Mobile `Conversation_Screen` (Phase 1, task 6.7; design Client Component 7: UI).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 7: UI", and `requirements.md` → 6.1, 6.2, 6.4, 6.5, 6.6, 6.8, 6.9.
 *
 * Presentational React Native component: renders a {@link ConversationState} produced by
 * the shared `ConversationReducer` (from `@chat-app/crypto`) and reports user intent via
 * callbacks. It holds no state and does no I/O, so it shares the exact render contract
 * with the web `ConversationScreen` (Requirement 6.7). The container owns the reducer,
 * transport, and crypto wiring.
 */

import React from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { ConversationState, RenderableMessage } from '@chat-app/crypto';

export interface ConversationScreenProps {
  state: ConversationState;
  selfLabel: string;
  onComposerChange: (text: string) => void;
  onSend: () => void;
}

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
}: ConversationScreenProps): React.JSX.Element {
  const connected = state.connection === 'connected';
  // On mobile the reducer is never gated (webWarningAcknowledged starts true), so this
  // matches the composer validity; the same predicate as web keeps behaviour identical.
  const canSend = state.composer.canSend && state.webWarningAcknowledged;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.selfLabel}>{selfLabel}</Text>
        <View style={styles.connection}>
          <View
            style={[styles.dot, { backgroundColor: connected ? '#16a34a' : '#dc2626' }]}
          />
          <Text style={{ color: connected ? '#127a3d' : '#9a3412', fontSize: 13 }}>
            {connected ? 'Connected' : 'Disconnected'}
          </Text>
        </View>
      </View>

      <FlatList
        style={styles.list}
        data={state.messages}
        keyExtractor={(m) => `${m.direction}:${m.seq}`}
        renderItem={({ item }) => <MessageRow message={item} />}
        ListEmptyComponent={<Text style={styles.empty}>No messages yet. Say hello.</Text>}
      />

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={state.composer.text}
          placeholder="Type a message"
          onChangeText={onComposerChange}
          accessibilityLabel="Message"
        />
        <Pressable
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          disabled={!canSend}
          onPress={onSend}
          accessibilityRole="button"
        >
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function MessageRow({ message }: { message: RenderableMessage }): React.JSX.Element {
  const outbound = message.direction === 'out';
  const isError = message.status === 'delivery-error' || message.status === 'failed';
  return (
    <View
      style={[
        styles.message,
        {
          alignSelf: outbound ? 'flex-end' : 'flex-start',
          backgroundColor: outbound ? '#dbeafe' : '#f1f5f9',
        },
      ]}
    >
      <Text style={[styles.messageText, message.text === null && styles.messageTextMissing]}>
        {message.text === null ? '⚠ message unavailable' : message.text}
      </Text>
      <Text style={[styles.messageStatus, isError && { color: '#b91c1c' }]}>
        {STATUS_LABEL[message.status]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  selfLabel: { fontWeight: '600', fontSize: 15 },
  connection: { flexDirection: 'row', alignItems: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  list: { flex: 1, paddingHorizontal: 16 },
  empty: { color: '#94a3b8', textAlign: 'center', marginTop: 24 },
  message: { maxWidth: '78%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12, marginVertical: 4 },
  messageText: { fontSize: 15 },
  messageTextMissing: { fontStyle: 'italic' },
  messageStatus: { fontSize: 11, color: '#64748b', marginTop: 2 },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
  },
  input: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    fontSize: 15,
  },
  sendButton: {
    marginLeft: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#2563eb',
  },
  sendButtonDisabled: { backgroundColor: '#93c5fd' },
  sendButtonText: { color: '#fff', fontWeight: '600' },
});
