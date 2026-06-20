/**
 * Shared bottom-sheet primitives (`SheetModal` + `SheetItem`) used by the conversation action
 * sheets (timer / safety / verify / hide) and reused by the Contact/Profile screen so the redesign
 * does not duplicate sheet chrome. Extracted verbatim from `ConversationScreen` (P3 declutter); the
 * busy/disabled behaviour is the P1 in-progress pattern (Requirement 1.3).
 */

import React from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { Theme } from './theme';

/** A bottom-sheet-style modal used by every action panel. */
export function SheetModal({
  visible,
  onClose,
  theme: t,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  theme: Theme;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Dismiss">
        <Pressable style={[styles.sheet, { backgroundColor: t.surface }]} onPress={() => undefined}>
          <ScrollView>{children}</ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/** A single tappable row inside a {@link SheetModal}. */
export function SheetItem({
  label,
  onPress,
  theme: t,
  destructive,
  disabled = false,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  theme: Theme;
  destructive?: boolean;
  /** When true, the row is non-interactive and dimmed. */
  disabled?: boolean;
  /** When true, a spinner replaces the label while an action is in flight (Requirement 1.3). */
  busy?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.sheetItem, { borderTopColor: t.divider }, (disabled || busy) && styles.sheetItemDisabled]}
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
    >
      {busy ? (
        <ActivityIndicator color={t.brandSoft} accessibilityLabel={label} />
      ) : (
        <Text style={[styles.sheetItemText, { color: destructive === true ? t.danger : t.brandSoft }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export const sheetStyles = StyleSheet.create({
  sheetTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  sheetHint: { fontSize: 12, marginBottom: 12, lineHeight: 17 },
});

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 28,
    maxHeight: '70%',
  },
  sheetItem: { paddingVertical: 14, borderTopWidth: 1 },
  sheetItemDisabled: { opacity: 0.5 },
  sheetItemText: { fontSize: 15, fontWeight: '600', textAlign: 'center' },
});
