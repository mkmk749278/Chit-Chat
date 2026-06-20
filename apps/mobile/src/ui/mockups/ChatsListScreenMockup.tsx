/**
 * MOCKUP — Modernized Chats list (P3).
 *
 * A minimal, Signal/WhatsApp-like list: a search bar on top, rows with avatar +
 * name + last-message preview + time + unread pill, and a floating compose button
 * built from the dependency-free icon set. Hard-coded sample data only.
 */

import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Icon } from './Icon.mockup';
import {
  avatarColor,
  initials,
  radius,
  spacing,
  type,
  useTheme,
  type Theme,
} from './theme.mockup';

interface ChatRow {
  id: string;
  name: string;
  preview: string;
  time: string;
  unread: number;
}

const SAMPLE_CHATS: ChatRow[] = [
  { id: 'u-maya', name: 'Maya Patel', preview: 'See you in a few!', time: '09:10', unread: 0 },
  { id: 'u-leo', name: 'Leo Nguyen', preview: 'You: sent the files 🔒', time: '08:42', unread: 0 },
  { id: 'u-aria', name: 'Aria Costa', preview: 'Can you call me later?', time: 'Yesterday', unread: 3 },
  { id: 'u-sam', name: 'Sam Okoye', preview: '🔒 Encrypted message', time: 'Yesterday', unread: 1 },
  { id: 'u-team', name: 'Design Sync', preview: 'Priya: pushed the mockups', time: 'Mon', unread: 0 },
  { id: 'u-dad', name: 'Dad', preview: 'Thanks! 🙏', time: 'Sun', unread: 0 },
];

export function ChatsListScreenMockup(): React.JSX.Element {
  const t = useTheme();
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const visible =
    trimmed.length === 0
      ? SAMPLE_CHATS
      : SAMPLE_CHATS.filter((c) => c.name.toLowerCase().includes(trimmed));

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: t.text }]}>Chats</Text>
      </View>

      {/* Search bar with a leading search glyph. */}
      <View style={[styles.search, { backgroundColor: t.field }]}>
        <Icon name="search" size={18} color={t.faint} />
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
        renderItem={({ item }) => <ChatRowView row={item} theme={t} />}
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: t.divider }]} />
        )}
      />

      {/* Floating compose button using the icon set. */}
      <Pressable
        style={[styles.fab, { backgroundColor: t.brand }]}
        accessibilityRole="button"
        accessibilityLabel="Start new chat"
      >
        <Icon name="compose" size={24} color={t.onBrand} />
      </Pressable>
    </View>
  );
}

function ChatRowView({ row, theme: t }: { row: ChatRow; theme: Theme }): React.JSX.Element {
  return (
    <Pressable style={styles.row} accessibilityRole="button" accessibilityLabel={row.name}>
      <View style={[styles.avatar, { backgroundColor: avatarColor(row.id) }]}>
        <Text style={styles.avatarText}>{initials(row.name)}</Text>
      </View>
      <View style={styles.rowBody}>
        <Text style={[styles.rowName, { color: t.text }]} numberOfLines={1}>
          {row.name}
        </Text>
        <Text style={[styles.rowPreview, { color: t.subtext }]} numberOfLines={1}>
          {row.preview}
        </Text>
      </View>
      <View style={styles.rowMeta}>
        <Text style={[styles.rowTime, { color: row.unread > 0 ? t.brand : t.faint }]}>{row.time}</Text>
        {row.unread > 0 && (
          <View style={[styles.badge, { backgroundColor: t.brand }]}>
            <Text style={styles.badgeText}>{row.unread}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.lg, paddingBottom: spacing.sm },
  title: { ...type.title },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.xl,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  searchInput: { flex: 1, paddingVertical: spacing.md, ...type.body },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '700' },
  rowBody: { flex: 1, marginLeft: spacing.md },
  rowName: { ...type.heading },
  rowPreview: { ...type.meta, marginTop: 3 },
  rowMeta: { alignItems: 'flex-end', gap: spacing.xs + 2 },
  rowTime: { ...type.caption },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xs + 2,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 86 },
  fab: {
    position: 'absolute',
    right: spacing.xl,
    bottom: spacing.xl,
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
});
