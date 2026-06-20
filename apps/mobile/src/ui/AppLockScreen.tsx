/**
 * App-lock screen — PIN gate for the decoy-PIN / duress app state (Signature Feature 4, §6).
 *
 * Presentational: collects a PIN and reports it via {@link onUnlock}; the container resolves it to
 * the real or decoy state (or a lockout) through the secure-gate. There is NO indicator of which
 * mode is active and NO "forgot PIN" flow that could reveal which PIN is real (§6.1, §6.2): a wrong
 * PIN and a lockout produce the same neutral messaging. While locked out, entry is disabled and a
 * single coarse countdown is shown (§3.1 timing-only feedback, no attempt counter).
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { runBusy, submitGate } from './async-submit';
import { useTheme } from './theme';

export interface AppLockScreenProps {
  /**
   * Submit the entered PIN. The container resolves real/decoy/locked/invalid and updates state. May
   * return a promise: while it is pending the unlock hash is in flight, so the screen shows a spinner
   * and disables the control until it resolves (Requirement 1.3).
   */
  onUnlock: (pin: string) => void | Promise<void>;
  /** A neutral error to show after a failed attempt (wrong PIN or lockout), else `null`. */
  error?: string | null;
  /** Whether entry is currently disabled by a lockout. */
  locked?: boolean;
  /** True while the unlock hash is in flight, when the container drives the busy state itself. */
  busy?: boolean;
}

export function AppLockScreen({
  onUnlock,
  error = null,
  locked = false,
  busy: busyProp = false,
}: AppLockScreenProps): React.JSX.Element {
  const t = useTheme();
  const [pin, setPin] = useState('');
  const [busyLocal, setBusyLocal] = useState(false);
  const valid = /^\d{4,6}$/.test(pin);
  // In-flight if either the container says so or our own awaited submit is running.
  const busy = busyProp || busyLocal;
  const { disabled, showProgress } = submitGate({ valid, locked, busy });

  const submit = (): void => {
    void runBusy({
      enabled: valid && !locked,
      busy: busyLocal,
      setBusy: setBusyLocal,
      action: async () => {
        await onUnlock(pin);
        setPin('');
      },
    });
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={styles.body}>
        <Text style={[styles.title, { color: t.text }]}>Enter PIN</Text>
        <Text style={[styles.hint, { color: t.faint }]}>Your PIN unlocks the app.</Text>
        <TextInput
          style={[styles.input, { color: t.text, backgroundColor: t.field }]}
          value={pin}
          onChangeText={setPin}
          keyboardType="number-pad"
          secureTextEntry
          editable={!locked && !busy}
          maxLength={6}
          accessibilityLabel="PIN"
          onSubmitEditing={submit}
          returnKeyType="go"
        />
        {error !== null && <Text style={[styles.error, { color: t.danger }]}>{error}</Text>}
        <Pressable
          style={[styles.button, { backgroundColor: t.brand }, disabled && styles.buttonDisabled]}
          disabled={disabled}
          onPress={submit}
          accessibilityRole="button"
          accessibilityLabel="Unlock"
          accessibilityState={{ disabled, busy: showProgress }}
        >
          {showProgress ? (
            <ActivityIndicator color={t.onBrand} accessibilityLabel="Unlocking" />
          ) : (
            <Text style={[styles.buttonText, { color: t.onBrand }]}>Unlock</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center' },
  body: { paddingHorizontal: 32 },
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  hint: { fontSize: 14, textAlign: 'center', marginTop: 8, marginBottom: 24 },
  input: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 22,
    letterSpacing: 8,
    textAlign: 'center',
  },
  error: { fontSize: 13, textAlign: 'center', marginTop: 12 },
  button: { marginTop: 20, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
