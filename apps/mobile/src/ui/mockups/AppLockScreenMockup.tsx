/**
 * MOCKUP — App-lock / unlock screen with the NEW non-freezing busy state (P1).
 *
 * The design's P1 fix moves the expensive PBKDF2 derivation off the JS thread and
 * makes the unlock flow explicitly async with in-progress UI, so a multi-second
 * hash never looks like a frozen app. This mockup demonstrates the UX half of that
 * fix: tapping "Unlock" shows an ActivityIndicator and disables the input/button
 * while "verifying", then resolves.
 *
 * >> PRODUCTION NOTE: here the busy state is simulated with a 1.2s timeout. In the
 * >> real app the button awaits the container's `onUnlock`, which runs PBKDF2 via
 * >> the native, off-thread provider (`react-native-quick-crypto`) — see design
 * >> Components 2–4. No fake timers ship; only the busy/disabled UI does.
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { radius, spacing, type, useTheme } from './theme.mockup';

// Simulated verification latency for the demo only.
const SIMULATED_VERIFY_MS = 1200;

export interface AppLockScreenMockupProps {
  /** Demo callback fired after the simulated verification completes. */
  onUnlocked?: () => void;
}

export function AppLockScreenMockup({ onUnlocked }: AppLockScreenMockupProps): React.JSX.Element {
  const t = useTheme();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{4,6}$/.test(pin);

  const submit = (): void => {
    if (!valid || busy) {
      return;
    }
    // Enter the busy state immediately: disable controls + show spinner. In the
    // real app the heavy hash runs off-thread while this state is shown.
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      setPin('');
      onUnlocked?.();
    }, SIMULATED_VERIFY_MS);
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
          editable={!busy}
          maxLength={6}
          accessibilityLabel="PIN"
          onSubmitEditing={submit}
          returnKeyType="go"
        />

        <Pressable
          style={[
            styles.button,
            { backgroundColor: t.brand },
            (!valid || busy) && styles.buttonDisabled,
          ]}
          disabled={!valid || busy}
          onPress={submit}
          accessibilityRole="button"
          accessibilityLabel="Unlock"
          accessibilityState={{ busy, disabled: !valid || busy }}
        >
          {busy ? (
            <View style={styles.busyRow}>
              <ActivityIndicator color={t.onBrand} />
              <Text style={[styles.buttonText, { color: t.onBrand }]}>Verifying…</Text>
            </View>
          ) : (
            <Text style={[styles.buttonText, { color: t.onBrand }]}>Unlock</Text>
          )}
        </Pressable>

        {busy && (
          <Text style={[styles.busyNote, { color: t.faint }]}>
            Checking your PIN securely — the app stays responsive.
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center' },
  body: { paddingHorizontal: spacing.xxl },
  title: { ...type.title, textAlign: 'center' },
  hint: { ...type.body, textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.xl },
  input: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    fontSize: 22,
    letterSpacing: 8,
    textAlign: 'center',
  },
  button: {
    marginTop: spacing.xl,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { ...type.heading },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  busyNote: { ...type.meta, textAlign: 'center', marginTop: spacing.md },
});
