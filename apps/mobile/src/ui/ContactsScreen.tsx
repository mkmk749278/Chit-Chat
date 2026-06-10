/**
 * Contacts tab / New chat (design/mockups screen 04).
 *
 * Phase 1 has no server-side contact directory yet, so this screen starts a chat from a
 * name + phone number entered locally (the recipient lookup against the backend lands
 * with the Messaging wiring). Known peers (chats already started) are listed for
 * one-tap reopening.
 */

import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { avatarColor, initials, useTheme } from './theme';

export interface ContactRow {
  id: string;
  name: string;
}

export function ContactsScreen({
  contacts,
  onStartChat,
}: {
  contacts: ContactRow[];
  /** Start (or reopen) a chat with a peer. `name` is the display label. */
  onStartChat: (id: string, name: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const filtered =
    trimmed.length === 0
      ? contacts
      : contacts.filter((c) => c.name.toLowerCase().includes(trimmed.toLowerCase()));
  // A phone-number-looking query can start a brand-new chat.
  const phoneLike = /^\+?[0-9][0-9 ]{5,16}$/.test(trimmed);

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: t.text }]}>New chat</Text>
      </View>

      <View style={[styles.search, { backgroundColor: t.field }]}>
        <TextInput
          style={[styles.searchInput, { color: t.text }]}
          placeholder="🔍  Search name or phone number"
          placeholderTextColor={t.faint}
          value={query}
          onChangeText={setQuery}
          accessibilityLabel="Search contacts"
        />
      </View>

      {phoneLike && (
        <Pressable
          style={styles.row}
          onPress={() => onStartChat(trimmed.replace(/\s+/g, ''), trimmed)}
          accessibilityRole="button"
        >
          <View style={[styles.avatar, { backgroundColor: t.field }]}>
            <Text style={[styles.avatarPlus, { color: t.brandSoft }]}>＋</Text>
          </View>
          <View style={styles.rowBody}>
            <Text style={[styles.rowName, { color: t.text }]}>Chat with {trimmed}</Text>
            <Text style={[styles.rowSub, { color: t.subtext }]}>Start an encrypted chat</Text>
          </View>
          <Text style={[styles.rowAction, { color: t.brandSoft }]}>Chat</Text>
        </Pressable>
      )}

      <Text style={[styles.section, { color: t.faint }]}>ON LUMIN</Text>
      <FlatList
        data={filtered}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => onStartChat(item.id, item.name)}
            accessibilityRole="button"
          >
            <View style={[styles.avatar, { backgroundColor: avatarColor(item.id) }]}>
              <Text style={styles.avatarText}>{initials(item.name)}</Text>
            </View>
            <View style={styles.rowBody}>
              <Text style={[styles.rowName, { color: t.text }]}>{item.name}</Text>
              <Text style={[styles.rowSecure, { color: t.secure }]}>🔒 secure</Text>
            </View>
            <Text style={[styles.rowAction, { color: t.brandSoft }]}>Chat</Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: t.subtext }]}>
            {trimmed.length === 0
              ? 'No contacts yet. Type a phone number above to start an encrypted chat.'
              : phoneLike
                ? ''
                : 'No matches. Type a full phone number to start a new chat.'}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  title: { fontSize: 30, fontWeight: '800' },
  search: {
    marginHorizontal: 20,
    borderRadius: 13,
    paddingHorizontal: 6,
    marginBottom: 16,
  },
  searchInput: { paddingHorizontal: 12, paddingVertical: 12, fontSize: 14 },
  section: { fontSize: 12, fontWeight: '700', paddingHorizontal: 24, marginBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  avatarPlus: { fontSize: 20, fontWeight: '700' },
  rowBody: { flex: 1, marginLeft: 14 },
  rowName: { fontSize: 16, fontWeight: '700' },
  rowSub: { fontSize: 12, marginTop: 2 },
  rowSecure: { fontSize: 12, marginTop: 2 },
  rowAction: { fontSize: 13, fontWeight: '700' },
  empty: { textAlign: 'center', marginTop: 32, paddingHorizontal: 40, fontSize: 13 },
});
