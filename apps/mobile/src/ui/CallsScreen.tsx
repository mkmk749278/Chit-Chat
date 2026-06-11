/**
 * Calls tab (UX directive navigation: Chats / Calls / Settings).
 *
 * Private calling ships in a later phase; until then this is a calm, honest empty state —
 * no fake rows, no "coming soon" countdowns, just the promise stated plainly in the
 * product's voice.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useTheme } from './theme';

export function CallsScreen(): React.JSX.Element {
  const t = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: t.text }]}>Calls</Text>
      </View>
      <View style={styles.empty}>
        <Text style={styles.emptyIcon}>📞</Text>
        <Text style={[styles.emptyTitle, { color: t.text }]}>Private calls</Text>
        <Text style={[styles.emptyBody, { color: t.subtext }]}>
          End-to-end encrypted calling is on its way. Your conversations stay private —
          voice included.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  title: { fontSize: 30, fontWeight: '800' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 48, paddingBottom: 80 },
  emptyIcon: { fontSize: 40, marginBottom: 12 },
  emptyTitle: { fontSize: 17, fontWeight: '700' },
  emptyBody: { fontSize: 13, textAlign: 'center', marginTop: 6, lineHeight: 19 },
});
