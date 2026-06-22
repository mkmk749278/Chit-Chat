/**
 * Chats tab — conversation list (UX directive: "Simple. Clean. Fast. Familiar.").
 *
 * Presentational: an instant, Spotlight-style search field over the chat rows (filters as
 * you type, no separate screen), then avatar / preview / time / unread rows. No privacy
 * controls are visible here (directive: security stays invisible on the list); the FAB and
 * the empty state route to the New-chat screen.
 */

import React, { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { runBusy } from './async-submit';
import { Icon } from './icons';
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
  onSearchSubmit,
  revealing: revealingProp = false,
  onLongPressRow,
}: {
  chats: ChatSummary[];
  onOpenChat: (id: string) => void;
  onNewChat: () => void;
  /**
   * Called when the user submits the search field (return key). Used for the hidden-chat secret
   * entry (Signature Feature 1, §3.3): a matching secret reveals that one chat; a non-match is
   * indistinguishable from an ordinary failed search. The reveal checks the secret against EVERY
   * hidden chat (no short-circuit, §3.1), so it can take real time — it may return a promise, during
   * which the search bar shows a spinner and is disabled (Requirement 1.3, 4.6). Optional so the
   * screen stays presentational.
   */
  onSearchSubmit?: (text: string) => void | Promise<void>;
  /** True while a hidden-chat reveal is in flight, when the container drives the state itself. */
  revealing?: boolean;
  /**
   * Press-and-hold on a chat row (Shadow Chat, Requirement 11.1): opens the row's long-press overlay
   * menu in the container (which offers "Shadow chat" in real mode). `id` is the peer id, `name` the
   * display name. Optional so the screen stays presentational.
   */
  onLongPressRow?: (id: string, name: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const [revealingLocal, setRevealingLocal] = useState(false);
  // In-flight if either the container says so or our own awaited reveal is running.
  const revealing = revealingProp || revealingLocal;
  const trimmed = query.trim().toLowerCase();
  const visible =
    trimmed.length === 0 ? chats : chats.filter((c) => c.name.toLowerCase().includes(trimmed));

  const submitSearch = (): void => {
    if (onSearchSubmit === undefined) {
      return;
    }
    const text = query;
    void runBusy({
      enabled: !revealingLocal,
      busy: revealingLocal,
      setBusy: setRevealingLocal,
      action: async () => {
        // Pass the raw query through; the secure-gate checks it against all hidden-chat candidates
        // without short-circuiting (§3.1 timing safety) — that flow is intentionally untouched here.
        await onSearchSubmit(text);
        setQuery('');
      },
    });
  };

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
          <Icon name="compose" size={20} color={t.brandSoft} />
        </Pressable>
      </View>

      <View style={[styles.search, { backgroundColor: t.field }]}>
        <View style={styles.searchIcon}>
          <Icon name="search" size={18} color={t.faint} />
        </View>
        <TextInput
          style={[styles.searchInput, { color: t.text }]}
          placeholder="Search"
          placeholderTextColor={t.faint}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={submitSearch}
          editable={!revealing}
          returnKeyType="search"
          accessibilityLabel="Search chats"
        />
        {revealing && (
          <ActivityIndicator style={styles.searchSpinner} color={t.brandSoft} accessibilityLabel="Revealing" />
        )}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(c) => c.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => {
          const unread = item.unread > 0;
          return (
            <Pressable
              style={({ pressed }) => [
                styles.card,
                { backgroundColor: unread ? t.brandFill : t.surface, shadowColor: '#000' },
                unread && { borderLeftWidth: 4, borderLeftColor: t.brand },
                pressed && styles.cardPressed,
              ]}
              onPress={() => onOpenChat(item.id)}
              onLongPress={onLongPressRow !== undefined ? () => onLongPressRow(item.id, item.name) : undefined}
              accessibilityRole="button"
            >
              <View style={[styles.avatar, { backgroundColor: avatarColor(item.id) }]}>
                <Text style={styles.avatarText}>{initials(item.name)}</Text>
              </View>
              <View style={styles.rowBody}>
                <Text style={[styles.rowName, { color: t.text }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text
                  style={[
                    styles.rowPreview,
                    { color: unread ? t.text : t.subtext, fontWeight: unread ? '600' : '400' },
                  ]}
                  numberOfLines={1}
                >
                  {item.preview}
                </Text>
              </View>
              <View style={styles.rowMeta}>
                <Text style={[styles.rowTime, { color: unread ? t.brand : t.faint }]}>{item.time}</Text>
                {unread && (
                  <View style={[styles.badge, { backgroundColor: t.brand }]}>
                    <Text style={styles.badgeText}>{item.unread}</Text>
                  </View>
                )}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="chats" size={40} color={t.faint} />
            <Text style={[styles.emptyTitle, { color: t.text, marginTop: 12 }]}>
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
        <Icon name="compose" size={24} color={t.onBrand} />
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
  search: {
    marginHorizontal: 20,
    marginBottom: 10,
    borderRadius: 12,
    paddingHorizontal: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  searchIcon: { paddingLeft: 8 },
  searchInput: { flex: 1, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  searchSpinner: { marginRight: 10 },
  // Card-feed list: each chat is a rounded, shadowed card with spacing between rows.
  listContent: { paddingTop: 8, paddingHorizontal: 14, paddingBottom: 120 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
    paddingVertical: 14,
    paddingHorizontal: 16,
    marginBottom: 12,
    // Soft "floating card" shadow (iOS) + elevation (Android).
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2,
  },
  cardPressed: { transform: [{ scale: 0.985 }], opacity: 0.96 },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  rowBody: { flex: 1, marginLeft: 14 },
  rowName: { fontSize: 16.5, fontWeight: '700' },
  rowPreview: { fontSize: 13, marginTop: 3 },
  rowMeta: { alignItems: 'flex-end', gap: 7 },
  rowTime: { fontSize: 11.5, fontWeight: '600' },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  empty: { alignItems: 'center', marginTop: 96, paddingHorizontal: 40 },
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
});
