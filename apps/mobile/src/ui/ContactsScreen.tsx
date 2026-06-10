/**
 * Contacts tab / New chat (design/mockups screen 04).
 *
 * Starts an encrypted chat from a phone number entered with a country selector: for India
 * (default) a 10-digit national number is enough — the `+91` code is prepended; other
 * countries pick their code. The composed E.164 is resolved to a recipient UID by the
 * backend directory (`onStartChat`). Known peers (chats already started) are listed for
 * one-tap reopening, filterable by name.
 */

import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CountryPhoneInput } from './CountryPhoneInput';
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
  /** Start (or reopen) a chat. `idOrE164` is an existing peer id or a new E.164 number. */
  onStartChat: (idOrE164: string, name: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [e164, setE164] = useState('');
  const [valid, setValid] = useState(false);
  const [query, setQuery] = useState('');

  const trimmed = query.trim();
  const filtered =
    trimmed.length === 0
      ? contacts
      : contacts.filter((c) => c.name.toLowerCase().includes(trimmed.toLowerCase()));

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: t.text }]}>New chat</Text>
      </View>

      <Text style={[styles.section, { color: t.faint }]}>START A NEW CHAT</Text>
      <View style={styles.newChat}>
        <CountryPhoneInput onChange={(value, isValid) => { setE164(value); setValid(isValid); }} />
        <Pressable
          style={[styles.startButton, { backgroundColor: t.brand }, !valid && styles.startDisabled]}
          disabled={!valid}
          onPress={() => onStartChat(e164, e164)}
          accessibilityRole="button"
        >
          <Text style={[styles.startText, { color: t.onBrand }]}>Start encrypted chat</Text>
        </Pressable>
        <Text style={[styles.hint, { color: t.subtext }]}>
          India: just your 10-digit number. Other countries: pick the code.
        </Text>
      </View>

      <Text style={[styles.section, { color: t.faint }]}>ON LUMIN</Text>
      <View style={[styles.search, { backgroundColor: t.field }]}>
        <TextInput
          style={[styles.searchInput, { color: t.text }]}
          placeholder="🔍  Search your chats by name"
          placeholderTextColor={t.faint}
          value={query}
          onChangeText={setQuery}
          accessibilityLabel="Search contacts"
        />
      </View>
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
            No chats yet. Enter a phone number above to start an encrypted chat.
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
  section: { fontSize: 12, fontWeight: '700', paddingHorizontal: 24, marginBottom: 8, marginTop: 8 },
  newChat: { paddingHorizontal: 20, marginBottom: 8 },
  startButton: { marginTop: 12, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  startDisabled: { opacity: 0.45 },
  startText: { fontWeight: '700', fontSize: 15 },
  hint: { fontSize: 12, marginTop: 8 },
  search: {
    marginHorizontal: 20,
    borderRadius: 13,
    paddingHorizontal: 6,
    marginBottom: 12,
  },
  searchInput: { paddingHorizontal: 12, paddingVertical: 12, fontSize: 14 },
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
  rowBody: { flex: 1, marginLeft: 14 },
  rowName: { fontSize: 16, fontWeight: '700' },
  rowSecure: { fontSize: 12, marginTop: 2 },
  rowAction: { fontSize: 13, fontWeight: '700' },
  empty: { textAlign: 'center', marginTop: 32, paddingHorizontal: 40, fontSize: 13 },
});
