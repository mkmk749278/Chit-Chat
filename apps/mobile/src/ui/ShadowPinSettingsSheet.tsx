/**
 * `ShadowPinSettingsSheet` — the per-chat PIN settings action for an OPEN shadow thread (Shadow
 * Chat, design Component 8 "Optional per-chat PIN — changeable anytime"; task 16.1, Requirements
 * 12.5, 12.7, 12.8).
 *
 * Reachable from the conversation overflow menu ONLY when an open shadow thread is viewed in
 * App_Mode `real` (the container passes `onSubmit` only then; the entry point is absent/inert
 * otherwise, Req 12.8). It lets the user ADD, CHANGE, or REMOVE the thread's per-chat PIN later:
 *   - entering a non-empty PIN and saving SETS or CHANGES the lock; and
 *   - the "Remove PIN" row REMOVES it, so the chat opens directly on the next alias match.
 *
 * Both paths delegate to {@link ShadowPinSettingsSheetProps.onSubmit}, which the container backs with
 * `getShadowSecretStore().setThreadPin('real', threadId, newPin | null)`. That hashes the PIN with
 * PBKDF2 (`secret-hash.ts`) off the UI thread; the work is awaited behind the shared {@link runBusy}
 * busy gate, so a spinner shows and the controls are disabled while it runs — the UI never freezes
 * (Requirement 12.7). Any failure surfaces a GENERIC inline message; success dismisses the sheet.
 *
 * Rendered through the {@link SheetModal} `Modal` portal (top z-order), consistent with the other
 * shadow overlays.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput } from 'react-native';

import { SheetItem, SheetModal, sheetStyles } from './action-sheet';
import { runBusy } from './async-submit';
import { useTheme } from './theme';

export interface ShadowPinSettingsSheetProps {
  /** Whether the sheet is visible. */
  visible: boolean;
  /** Dismiss without changing the PIN. */
  onClose: () => void;
  /**
   * Set/change (non-empty `newPin`) or remove (`null`) the per-chat PIN off the UI thread. Rejecting
   * (throwing) surfaces a generic inline failure and leaves the sheet open.
   */
  onSubmit: (newPin: string | null) => Promise<void>;
}


/** The per-chat PIN add/change/remove sheet. See the module doc. */
export function ShadowPinSettingsSheet({
  visible,
  onClose,
  onSubmit,
}: ShadowPinSettingsSheetProps): React.JSX.Element {
  const t = useTheme();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setPin('');
    setBusy(false);
    setError(null);
  };

  // Dismiss is blocked while a hash is in flight so the operation can settle (Req 12.7).
  const close = (): void => {
    if (busy) {
      return;
    }
    reset();
    onClose();
  };

  // Shared runner for BOTH the set/change (`newPin` non-empty) and the remove (`newPin === null`)
  // paths: one busy flag, one generic error surface. `runBusy` guards re-entrancy so a double-tap
  // (or tapping Save then Remove) can never launch two concurrent hashes.
  const run = (newPin: string | null): void => {
    setError(null);
    void runBusy({
      enabled: !busy,
      busy,
      setBusy,
      action: async () => {
        try {
          await onSubmit(newPin);
          reset();
          onClose();
        } catch {
          // Generic failure only — never reveal anything shadow-specific (Req 8.1 family).
          setError('Could not update the PIN. Please try again.');
        }
      },
    });
  };

  const save = (): void => {
    const trimmed = pin.trim();
    if (trimmed.length === 0) {
      return;
    }
    run(trimmed);
  };


  const pinEmpty = pin.trim().length === 0;

  return (
    <SheetModal visible={visible} onClose={close} theme={t}>
      <Text style={[sheetStyles.sheetTitle, { color: t.text }]}>Shadow chat PIN</Text>
      <Text style={[sheetStyles.sheetHint, { color: t.subtext }]}>
        Add, change, or remove this chat's PIN. With a PIN set, re-entering its alias asks for the PIN
        first; leave it off to open directly. There is no recovery if you forget it.
      </Text>

      <Text style={[styles.label, { color: t.faint }]}>NEW PIN</Text>
      <TextInput
        style={[styles.input, { backgroundColor: t.field, color: t.text }]}
        placeholder="Enter a new PIN"
        placeholderTextColor={t.faint}
        value={pin}
        onChangeText={(next) => {
          setPin(next);
          setError(null);
        }}
        secureTextEntry
        keyboardType="number-pad"
        editable={!busy}
        accessibilityLabel="New per-chat PIN"
      />

      {error !== null && <Text style={[styles.fieldError, { color: t.danger }]}>{error}</Text>}

      <Pressable
        style={[styles.saveButton, { backgroundColor: t.brand }, (pinEmpty || busy) && styles.saveDisabled]}
        onPress={save}
        disabled={pinEmpty || busy}
        accessibilityRole="button"
        accessibilityLabel="Save per-chat PIN"
        accessibilityState={{ disabled: pinEmpty || busy, busy }}
      >
        {busy ? (
          <ActivityIndicator color={t.onBrand} />
        ) : (
          <Text style={[styles.saveText, { color: t.onBrand }]}>Save PIN</Text>
        )}
      </Pressable>

      <SheetItem label="Remove PIN" destructive theme={t} busy={busy} disabled={busy} onPress={() => run(null)} />
      <SheetItem label="Cancel" theme={t} disabled={busy} onPress={close} />
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 11, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 },
  input: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  fieldError: { fontSize: 12, marginTop: 6 },
  saveButton: { marginTop: 16, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  saveDisabled: { opacity: 0.45 },
  saveText: { fontWeight: '700', fontSize: 15 },
});
