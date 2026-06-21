/**
 * `ShadowChatCreateSheet` — the shadow-chat creation sheet (Shadow Chat, design Component 7; task
 * 15.1, Requirements 11.4, 11.5, 11.6, 11.7, 12.1, 12.5, 12.6, 12.7).
 *
 * Opened from the "Shadow chat" action of {@link RowActionMenu} (real mode only). It collects:
 *   - an **Alias** (must start with `/`, validated INLINE through the SAME `normalizeAlias` the
 *     Alias_Resolver uses, so an invalid alias is refused and binds nothing — Requirement 11.5); and
 *   - an **optional per-chat PIN** that is **blank by default** and fully skippable (Requirements
 *     11.4, 12.1).
 *
 * On confirm it delegates to {@link ShadowChatCreateSheetProps.onCreate}; the container performs the
 * actual `ShadowSecretStore.bindAlias` + `ConversationRegistry.openShadowThread` and never disturbs
 * the contact's surface chat (Requirement 11.7). Binding involves PBKDF2 hashing of the optional PIN
 * (Req 12.6/12.7), so the confirm runs behind the shared {@link runBusy} busy gate — a spinner shows
 * and the control is disabled while the work is in flight, so the UI never freezes (Requirement
 * 12.7). Any failure surfaces a generic inline message and creates nothing.
 *
 * Rendered through the {@link SheetModal} `Modal` PORTAL (top z-order), consistent with the rest of
 * the shadow creation overlay (Requirement 11.8).
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { normalizeAlias } from '@chat-app/crypto';

import { SheetModal, sheetStyles } from './action-sheet';
import { runBusy } from './async-submit';
import { useTheme } from './theme';

export interface ShadowChatCreateSheetProps {
  /** Whether the sheet is visible. */
  visible: boolean;
  /** Dismiss without creating. */
  onClose: () => void;
  /** The contact's display name, shown for context. */
  contactName: string;
  /**
   * Create the shadow chat. `alias` is guaranteed grammatically valid (already normalised-checked);
   * `pin` is `undefined` when the optional field was left blank. Rejecting (throwing) surfaces a
   * generic inline failure and leaves the sheet open.
   */
  onCreate: (alias: string, pin?: string) => Promise<void>;
  /** Sheet title; defaults to "New shadow chat" (override e.g. for the Accept flow). */
  title?: string;
  /** Explanatory hint under the title; defaults to the new-chat copy. */
  hint?: string;
  /** Primary button label; defaults to "Create shadow chat". */
  submitLabel?: string;
}

/** The alias + optional-PIN creation sheet. See the module doc. */
export function ShadowChatCreateSheet({
  visible,
  onClose,
  contactName,
  onCreate,
  title = 'New shadow chat',
  hint,
  submitLabel = 'Create shadow chat',
}: ShadowChatCreateSheetProps): React.JSX.Element {
  const t = useTheme();
  const [alias, setAlias] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Inline validation through the SAME normaliser the resolver uses (Req 11.5).
  const aliasValid = normalizeAlias(alias) !== null;
  const showAliasError = alias.trim().length > 0 && !aliasValid;

  const reset = (): void => {
    setAlias('');
    setPin('');
    setError(null);
    setBusy(false);
  };

  const close = (): void => {
    reset();
    onClose();
  };

  const submit = (): void => {
    if (!aliasValid) {
      return;
    }
    setError(null);
    const trimmedPin = pin.trim();
    void runBusy({
      enabled: !busy,
      busy,
      setBusy,
      action: async () => {
        try {
          await onCreate(alias.trim(), trimmedPin.length > 0 ? trimmedPin : undefined);
          reset();
        } catch (err) {
          // Preserve the REAL failure reason instead of swallowing every throw into one opaque
          // string — that masking is what hid an on-device WebCrypto/derivation failure behind a
          // generic "try again" and made the defect undiagnosable. The controller/crypto-core
          // messages never contain the alias plaintext, the PIN, or any secret, so logging the
          // message is privacy-safe; we deliberately never log `alias` or `pin`.
          const reason = err instanceof Error ? err.message : String(err);
          // eslint-disable-next-line no-console
          console.error('[shadow-chat] create failed:', reason);
          // Surface the specific, actionable reason (e.g. "Secure storage is still setting up…")
          // when we have one; fall back to the generic message only when it is empty.
          setError(
            reason.length > 0 ? reason : 'Could not create the shadow chat. Please try again.',
          );
        }
      },
    });
  };

  return (
    <SheetModal visible={visible} onClose={close} theme={t}>
      <Text style={[sheetStyles.sheetTitle, { color: t.text }]}>{title}</Text>
      <Text style={[sheetStyles.sheetHint, { color: t.subtext }]}>
        {hint ??
          `A hidden conversation with ${contactName}. Re-enter it later by typing its alias in the search bar. Nothing about it appears in your chat list.`}
      </Text>

      <Text style={[styles.label, { color: t.faint }]}>ALIAS</Text>
      <TextInput
        style={[styles.input, { backgroundColor: t.field, color: t.text }]}
        placeholder="/secret1"
        placeholderTextColor={t.faint}
        value={alias}
        onChangeText={(next) => {
          setAlias(next);
          setError(null);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!busy}
        accessibilityLabel="Shadow chat alias"
      />
      {showAliasError && (
        <Text style={[styles.fieldError, { color: t.danger }]}>
          Must start with / and use only letters or numbers.
        </Text>
      )}

      <Text style={[styles.label, { color: t.faint, marginTop: 14 }]}>PIN (OPTIONAL)</Text>
      <TextInput
        style={[styles.input, { backgroundColor: t.field, color: t.text }]}
        placeholder="Leave blank for no PIN"
        placeholderTextColor={t.faint}
        value={pin}
        onChangeText={setPin}
        secureTextEntry
        keyboardType="number-pad"
        editable={!busy}
        accessibilityLabel="Optional per-chat PIN"
      />

      {error !== null && <Text style={[styles.fieldError, { color: t.danger }]}>{error}</Text>}

      <Pressable
        style={[
          styles.createButton,
          { backgroundColor: t.brand },
          (!aliasValid || busy) && styles.createDisabled,
        ]}
        onPress={submit}
        disabled={!aliasValid || busy}
        accessibilityRole="button"
        accessibilityLabel="Create shadow chat"
        accessibilityState={{ disabled: !aliasValid || busy, busy }}
      >
        {busy ? (
          <ActivityIndicator color={t.onBrand} />
        ) : (
          <Text style={[styles.createText, { color: t.onBrand }]}>{submitLabel}</Text>
        )}
      </Pressable>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 },
  input: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  fieldError: { fontSize: 12, marginTop: 6 },
  createButton: { marginTop: 18, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  createDisabled: { opacity: 0.45 },
  createText: { fontWeight: '700', fontSize: 15 },
});
