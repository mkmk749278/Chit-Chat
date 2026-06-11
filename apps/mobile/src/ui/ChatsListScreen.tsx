/**
 * Chats tab — conversation list (UX directive: "Simple. Clean. Fast. Familiar.").
 *
 * Presentational: an instant, Spotlight-style search field over the chat rows (filters as
 * you type, no separate screen), then avatar / preview / time / unread rows. No privacy
 * controls are visible here (directive: security stays invisible on the list); the FAB and
 * the empty state route to the New-chat screen.
 */

import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { avatarColor, initials, useTheme } from './theme';

export interface ChatSummary {
  /** Stable conversation id (the peer id). */
  id: string;
  /** Display name of the peer. */
  name: string;
  /** Preview line (e.g. "🔒 Encrypted message" or "You: …"). */
  preview: string;
  /** Short time label ("9:32", "Yesterday"). */
  time: string;
  /** Unread count (0 hides the badge). */
  unread: number;
}

export function ChatsListScreen({
  chats,
  onOpenChat,
  onNewChat,
}: {
  chats: ChatSummary[];
  onOpenChat: (id: string) => void;
  onNewChat: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const visible =
    trimmed.length === 0 ? chats : chats.filter((c) => c.name.toLowerCase().includes(trimmed));

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: t.text }]}>Chats</Text>
        <Pressable
          style={[styles.headerButton, { backgroundColor: t.field }]}
          onPress={onNewChat}
          accessibilityRole="button"
          accessibilityLabel="New chat"
        >
          <Text style={[styles.headerButtonText, { color: t.brandSoft }]}>✎</Text>
        </Pressable>
      </View>

      <View style={[styles.search, { backgroundColor: t.field }]}>
        <TextInput
          style={[styles.searchInput, { color: t.text }]}
          placeholder="Search"
          placeholderTextColor={t.faint}
          value={query}
          onChangeText={setQuery}
          accessibilityLabel="Search chats"
        />
      </View>

      <FlatList
        data={visible}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => onOpenChat(item.id)}
            accessibilityRole="button"
          >
            <View style={[styles.avatar, { backgroundColor: avatarColor(item.id) }]}>
              <Text style={styles.avatarText}>{initials(item.name)}</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.rowName, { color: t.text }]} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.rowPreview, { color: t.subtext }]} numberOfLines={1}>
                {item.preview}
              </Text>
            </View>
            <View style={styles.rowMeta}>
              <Text style={[styles.rowTime, { color: t.faint }]}>{item.time}</Text>
              {item.unread > 0 && (
                <View style={[styles.badge, { backgroundColor: t.brand }]}>
                  <Text style={styles.badgeText}>{item.unread}</Text>
                </View>
              )}
            </View>
          </Pressable>
        )}
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: t.divider }]} />
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>💬</Text>
            <Text style={[styles.emptyTitle, { color: t.text }]}>
              {trimmed.length > 0 ? 'No matches' : 'No chats yet'}
            </Text>
            <Text style={[styles.emptyBody, { color: t.subtext }]}>
              {trimmed.length > 0
                ? 'Try a different name.'
                : 'Tap + to start a private conversation.'}
            </Text>
          </View>
        }
      />

      <Pressable
        style={[styles.fab, { backgroundColor: t.brand }]}
        onPress={onNewChat}
        accessibilityRole="button"
        accessibilityLabel="Start new chat"
      >
        <Text style={[styles.fabText, { color: t.onBrand }]}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 10,
  },
  title: { fontSize: 30, fontWeight: '800' },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButtonText: { fontSize: 17, fontWeight: '700' },
  search: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 12,
    paddingHorizontal: 6,
  },
  searchInput: { paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  rowBody: { flex: 1, marginLeft: 14 },
  rowName: { fontSize: 16, fontWeight: '700' },
  rowPreview: { fontSize: 13, marginTop: 3 },
  rowMeta: { alignItems: 'flex-end', gap: 6 },
  rowTime: { fontSize: 12 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 86 },
  empty: { alignItems: 'center', marginTop: 96, paddingHorizontal: 40 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700' },
  emptyBody: { fontSize: 13, textAlign: 'center', marginTop: 6 },
  fab: {
    position: 'absolute',
    right: 24,
    bottom: 24,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
  },
  fabText: { fontSize: 30, lineHeight: 34, fontWeight: '600' },
});
