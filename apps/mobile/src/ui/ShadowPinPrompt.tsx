/**
 * `ShadowPinPrompt` — the per-chat PIN re-entry prompt for opening a PIN-protected shadow thread
 * (Shadow Chat, design "Optional per-chat PIN"; task 15.1 item 3, Requirements 12.3, 12.4, 12.7).
 *
 * When a resolved `/alias` points at a shadow thread whose `AliasEntry` carries a `pinVerifier`, the
 * mobile search handler asks for the PIN through this prompt before opening the thread. Verification
 * runs through {@link ShadowPinPromptProps.onVerify}, which the container backs with
 * `secret-hash.verifySecret` (PBKDF2). That work is awaited behind the shared {@link runBusy} busy
 * gate, so a spinner shows and the submit control is disabled while it runs — the UI never freezes
 * (Requirement 12.7).
 *
 * A wrong PIN surfaces only a GENERIC failure message (no shadow-specific signal) and leaves the
 * prompt open for another try; the thread is not opened (Requirement 12.4). Dismissing the prompt
 * cancels the re-entry. Rendered through the {@link SheetModal} `Modal` portal (top z-order).
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput } from 'react-native';

import { SheetModal, sheetStyles } from './action-sheet';
import { runBusy } from './async-submit';
import { useTheme } from './theme';

export interface ShadowPinPromptProps {
  /** Whether the prompt is visible. */
  visible: boolean;
  /** Verify the entered PIN off the UI thread; resolves true when it matches the stored verifier. */
  onVerify: (pin: string) => Promise<boolean>;
  /** Called once the PIN verified — the container opens the thread and dismisses the prompt. */
  onVerified: () => void;
  /** Called when the user dismisses without a successful verification (cancel). */
  onCancel: () => void;
}

/** The per-chat PIN re-entry prompt. See the module doc. */
export function ShadowPinPrompt({
  visible,
  onVerify,
  onVerified,
  onCancel,
}: ShadowPinPromptProps): React.JSX.Element {
  const t = useTheme();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const reset = (): void => {
    setPin('');
    setBusy(false);
    setFailed(false);
  };

  const cancel = (): void => {
    reset();
    onCancel();
  };

  const submit = (): void => {
    if (pin.trim().length === 0) {
      return;
    }
    setFailed(false);
    void runBusy({
      enabled: !busy,
      busy,
      setBusy,
      action: async () => {
        const ok = await onVerify(pin);
        if (ok) {
          reset();
          onVerified();
        } else {
          // Generic failure only — no shadow-specific signal (Req 12.4). Stay open for retry.
          setFailed(true);
          setPin('');
        }
      },
    });
  };

  return (
    <SheetModal visible={visible} onClose={cancel} theme={t}>
      <Text style={[sheetStyles.sheetTitle, { color: t.text }]}>Enter PIN</Text>
      <Text style={[sheetStyles.sheetHint, { color: t.subtext }]}>
        This conversation is locked. Enter its PIN to continue.
      </Text>
      <TextInput
        style={[styles.input, { backgroundColor: t.field, color: t.text }]}
        placeholder="PIN"
        placeholderTextColor={t.faint}
        value={pin}
        onChangeText={(next) => {
          setPin(next);
          setFailed(false);
        }}
        secureTextEntry
        keyboardType="number-pad"
        editable={!busy}
        onSubmitEditing={submit}
        accessibilityLabel="Per-chat PIN"
      />
      {failed && <Text style={[styles.fieldError, { color: t.danger }]}>Incorrect PIN.</Text>}
      <Pressable
        style={[styles.button, { backgroundColor: t.brand }, (pin.trim().length === 0 || busy) && styles.disabled]}
        onPress={submit}
        disabled={pin.trim().length === 0 || busy}
        accessibilityRole="button"
        accessibilityLabel="Unlock shadow chat"
        accessibilityState={{ disabled: pin.trim().length === 0 || busy, busy }}
      >
        {busy ? (
          <ActivityIndicator color={t.onBrand} />
        ) : (
          <Text style={[styles.buttonText, { color: t.onBrand }]}>Unlock</Text>
        )}
      </Pressable>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  input: { borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15 },
  fieldError: { fontSize: 12, marginTop: 6 },
  button: { marginTop: 16, paddingVertical: 13, borderRadius: 14, alignItems: 'center' },
  disabled: { opacity: 0.45 },
  buttonText: { fontWeight: '700', fontSize: 15 },
});
