/**
 * Mobile `Conversation_Screen` (Phase 1, task 6.7; design Client Component 7: UI;
 * visual design: design/mockups screen 03).
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

import { avatarColor, initials, useTheme, type Theme } from './theme';

export interface ConversationScreenProps {
  state: ConversationState;
  /** Display name of the chat peer (header). */
  peerName: string;
  onComposerChange: (text: string) => void;
  onSend: () => void;
  /** Back to the chats list. */
  onBack: () => void;
}

const STATUS_LABEL: Record<RenderableMessage['status'], string> = {
  sending: '🕓',
  sent: '✓✓',
  failed: '⚠ failed',
  received: '',
  'delivery-error': '⚠ could not be decrypted',
};

export function ConversationScreen({
  state,
  peerName,
  onComposerChange,
  onSend,
  onBack,
}: ConversationScreenProps): React.JSX.Element {
  const t = useTheme();
  const connected = state.connection === 'connected';
  const canSend = state.composer.canSend && state.webWarningAcknowledged;

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { backgroundColor: t.surface, borderBottomColor: t.divider }]}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text style={[styles.back, { color: t.brandSoft }]}>‹</Text>
        </Pressable>
        <View style={[styles.avatar, { backgroundColor: avatarColor(peerName) }]}>
          <Text style={styles.avatarText}>{initials(peerName)}</Text>
        </View>
        <View style={styles.headerBody}>
          <Text style={[styles.peerName, { color: t.text }]} numberOfLines={1}>
            {peerName}
          </Text>
          <Text style={[styles.headerStatus, { color: connected ? t.secure : t.danger }]}>
            {connected ? 'end-to-end encrypted · online' : 'end-to-end encrypted · connecting…'}
          </Text>
        </View>
      </View>

      <FlatList
        style={styles.list}
        contentContainerStyle={styles.listContent}
        data={state.messages}
        keyExtractor={(m) => `${m.direction}:${m.seq}`}
        renderItem={({ item }) => <Bubble message={item} theme={t} />}
        ListHeaderComponent={
          <View style={[styles.notice, { backgroundColor: t.noticeFill }]}>
            <Text style={[styles.noticeText, { color: t.noticeText }]}>
              🔒 Messages are end-to-end encrypted. No one outside this chat can read them,
              not even Lumin.
            </Text>
          </View>
        }
      />

      <View style={[styles.composer, { backgroundColor: t.surface, borderTopColor: t.divider }]}>
        <TextInput
          style={[styles.input, { backgroundColor: t.field, color: t.text }]}
          value={state.composer.text}
          placeholder="Message…"
          placeholderTextColor={t.faint}
          onChangeText={onComposerChange}
          accessibilityLabel="Message"
        />
        <Pressable
          style={[styles.sendButton, { backgroundColor: t.brand }, !canSend && styles.sendDisabled]}
          disabled={!canSend}
          onPress={onSend}
          accessibilityRole="button"
          accessibilityLabel="Send"
        >
          <Text style={[styles.sendText, { color: t.onBrand }]}>➤</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Bubble({ message, theme: t }: { message: RenderableMessage; theme: Theme }): React.JSX.Element {
  const outbound = message.direction === 'out';
  const isError = message.status === 'delivery-error' || message.status === 'failed';
  const statusLabel = STATUS_LABEL[message.status];
  return (
    <View style={[styles.bubbleWrap, { alignSelf: outbound ? 'flex-end' : 'flex-start' }]}>
      <View
        style={[
          styles.bubble,
          outbound
            ? { backgroundColor: t.brand, opacity: message.status === 'sending' ? 0.55 : 1 }
            : { backgroundColor: t.bubbleIn, borderWidth: 1, borderColor: t.divider },
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            { color: outbound ? t.onBrand : t.text },
            message.text === null && styles.bubbleTextMissing,
          ]}
        >
          {message.text === null ? '⚠ message unavailable' : message.text}
        </Text>
      </View>
      {statusLabel.length > 0 && (
        <Text style={[styles.status, { color: isError ? t.danger : t.faint }]}>{statusLabel}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    gap: 10,
  },
  back: { fontSize: 26, fontWeight: '600', paddingRight: 2 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  headerBody: { flex: 1 },
  peerName: { fontSize: 16, fontWeight: '700' },
  headerStatus: { fontSize: 11, marginTop: 2 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  notice: { borderRadius: 12, paddingVertical: 8, paddingHorizontal: 14, marginBottom: 12, alignSelf: 'center' },
  noticeText: { fontSize: 10.5, textAlign: 'center' },
  bubbleWrap: { maxWidth: '80%', marginVertical: 3 },
  bubble: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9 },
  bubbleText: { fontSize: 15 },
  bubbleTextMissing: { fontStyle: 'italic' },
  status: { fontSize: 10, marginTop: 2, alignSelf: 'flex-end' },
  composer: { flexDirection: 'row', alignItems: 'center', padding: 12, borderTopWidth: 1, gap: 10 },
  input: { flex: 1, borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 15 },
  sendButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.4 },
  sendText: { fontSize: 16 },
});
