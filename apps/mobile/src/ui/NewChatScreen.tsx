/**
 * New chat — pushed over the Chats tab from the ✎ / FAB (UX directive: navigation is
 * Chats / Calls / Settings; starting a chat is an action, not a destination).
 *
 * Starts an encrypted chat from a phone number entered with a country selector: India
 * (default) needs just the 10-digit national number — `+91` is prepended; other countries
 * pick their code. The composed E.164 is resolved to a recipient by the container. Known
 * peers are listed for one-tap reopening.
 */

import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { CountryPhoneInput } from './CountryPhoneInput';
import { avatarColor, initials, useTheme } from './theme';

export interface ContactRow {
  id: string;
  name: string;
}

export function NewChatScreen({
  contacts,
  onStartChat,
  onBack,
  onLongPressRow,
}: {
  contacts: ContactRow[];
  /** Start (or reopen) a chat. `idOrE164` is an existing peer id or a new E.164 number. */
  onStartChat: (idOrE164: string, name: string) => void;
  onBack: () => void;
  /**
   * Press-and-hold on a recent-contact row (Shadow Chat, Requirement 11.1): opens the row's
   * long-press overlay menu in the container (which offers "Shadow chat" in real mode). `id` is the
   * peer id, `name` the display name. Optional so the screen stays presentational.
   */
  onLongPressRow?: (id: string, name: string) => void;
}): React.JSX.Element {
  const t = useTheme();
  const [e164, setE164] = useState('');
  const [valid, setValid] = useState(false);

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12}>
          <Text style={[styles.back, { color: t.brandSoft }]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: t.text }]}>New chat</Text>
      </View>

      <View style={styles.form}>
        <CountryPhoneInput onChange={(value, isValid) => { setE164(value); setValid(isValid); }} />
        <Pressable
          style={[styles.startButton, { backgroundColor: t.brand }, !valid && styles.startDisabled]}
          disabled={!valid}
          onPress={() => onStartChat(e164, e164)}
          accessibilityRole="button"
        >
          <Text style={[styles.startText, { color: t.onBrand }]}>Start chat</Text>
        </Pressable>
        <Text style={[styles.hint, { color: t.faint }]}>
          India: just the 10-digit number. Elsewhere: pick the country code.
        </Text>
      </View>

      {contacts.length > 0 && (
        <>
          <Text style={[styles.section, { color: t.faint }]}>RECENT</Text>
          <FlatList
            data={contacts}
            keyExtractor={(c) => c.id}
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => onStartChat(item.id, item.name)}
                onLongPress={
                  onLongPressRow !== undefined ? () => onLongPressRow(item.id, item.name) : undefined
                }
                accessibilityRole="button"
              >
                <View style={[styles.avatar, { backgroundColor: avatarColor(item.id) }]}>
                  <Text style={styles.avatarText}>{initials(item.name)}</Text>
                </View>
                <Text style={[styles.rowName, { color: t.text }]} numberOfLines={1}>
                  {item.name}
                </Text>
                <Text style={[styles.rowAction, { color: t.brandSoft }]}>Open</Text>
              </Pressable>
            )}
          />
        </>
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
    paddingTop: 16,
    paddingBottom: 12,
    gap: 8,
  },
  back: { fontSize: 28, fontWeight: '600', paddingRight: 2 },
  title: { fontSize: 24, fontWeight: '800' },
  form: { paddingHorizontal: 20, marginBottom: 12 },
  startButton: { marginTop: 12, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  startDisabled: { opacity: 0.45 },
  startText: { fontWeight: '700', fontSize: 15 },
  hint: { fontSize: 12, marginTop: 8 },
  section: { fontSize: 12, fontWeight: '700', paddingHorizontal: 24, marginBottom: 4, marginTop: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 12,
    gap: 14,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  rowName: { flex: 1, fontSize: 16, fontWeight: '600' },
  rowAction: { fontSize: 13, fontWeight: '700' },
});
