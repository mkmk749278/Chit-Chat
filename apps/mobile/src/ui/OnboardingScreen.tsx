/**
 * Onboarding after phone verification (UX directive: Phone Verification → Display Name →
 * Optional PIN; total under 60 seconds, then straight to the chat screen).
 *
 * Two quick steps, both presentational:
 *  1. Display name — what friends see. Required, 1–32 chars.
 *  2. PIN — optional 4–6 digit app lock. Prominent "Skip" keeps the flow fast; security
 *     is offered, never imposed (directive: powerful but invisible).
 *
 * The container persists the results (v1: in-session; durable profile/PIN storage is part
 * of the backend wiring pass).
 */

import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { runBusy, submitGate } from './async-submit';
import { useTheme } from './theme';

export function OnboardingScreen({
  onDone,
}: {
  /**
   * Called once with the chosen name and PIN (`null` when skipped). May return a promise: setting a
   * PIN hashes it, so while it is pending the screen shows a spinner and disables the control
   * (Requirement 1.3).
   */
  onDone: (displayName: string, pin: string | null) => void | Promise<void>;
}): React.JSX.Element {
  const t = useTheme();
  const [step, setStep] = useState<'name' | 'pin'>('name');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);

  const nameValid = name.trim().length >= 1 && name.trim().length <= 32;
  const pinValid = /^\d{4,6}$/.test(pin);
  const pinGate = submitGate({ valid: pinValid, busy });

  const setPinAndContinue = (): void => {
    void runBusy({
      enabled: pinValid,
      busy,
      setBusy,
      action: () => onDone(name.trim(), pin),
    });
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      {step === 'name' ? (
        <>
          <Text style={[styles.title, { color: t.text }]}>What's your name?</Text>
          <Text style={[styles.subtitle, { color: t.subtext }]}>
            This is what friends see. You can change it any time.
          </Text>
          <TextInput
            style={[styles.input, { backgroundColor: t.surface, borderColor: t.divider, color: t.text }]}
            placeholder="Your name"
            placeholderTextColor={t.faint}
            value={name}
            onChangeText={setName}
            maxLength={32}
            autoFocus
            accessibilityLabel="Display name"
          />
          <Pressable
            style={[styles.button, { backgroundColor: t.brand }, !nameValid && styles.buttonDisabled]}
            disabled={!nameValid}
            onPress={() => setStep('pin')}
            accessibilityRole="button"
          >
            <Text style={[styles.buttonText, { color: t.onBrand }]}>Continue</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={[styles.title, { color: t.text }]}>Add a PIN?</Text>
          <Text style={[styles.subtitle, { color: t.subtext }]}>
            An optional 4–6 digit PIN keeps the app locked to you. You can set one later in
            Settings.
          </Text>
          <TextInput
            style={[styles.input, { backgroundColor: t.surface, borderColor: t.divider, color: t.text }]}
            placeholder="••••"
            placeholderTextColor={t.faint}
            value={pin}
            onChangeText={setPin}
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            editable={!busy}
            accessibilityLabel="PIN"
          />
          <Pressable
            style={[styles.button, { backgroundColor: t.brand }, pinGate.disabled && styles.buttonDisabled]}
            disabled={pinGate.disabled}
            onPress={setPinAndContinue}
            accessibilityRole="button"
            accessibilityState={{ disabled: pinGate.disabled, busy: pinGate.showProgress }}
          >
            {pinGate.showProgress ? (
              <ActivityIndicator color={t.onBrand} accessibilityLabel="Setting PIN" />
            ) : (
              <Text style={[styles.buttonText, { color: t.onBrand }]}>Set PIN</Text>
            )}
          </Pressable>
          <Pressable
            style={styles.skip}
            onPress={() => {
              if (!busy) {
                void onDone(name.trim(), null);
              }
            }}
            disabled={busy}
            accessibilityRole="button"
          >
            <Text style={[styles.skipText, { color: t.subtext }]}>Skip for now</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, justifyContent: 'center' },
  title: { fontSize: 26, fontWeight: '800' },
  subtitle: { fontSize: 14, marginTop: 8, marginBottom: 24, lineHeight: 20 },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 13,
    borderWidth: 1,
    fontSize: 16,
  },
  button: { marginTop: 18, paddingVertical: 14, borderRadius: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontWeight: '700', fontSize: 16 },
  skip: { marginTop: 14, alignItems: 'center', paddingVertical: 8 },
  skipText: { fontSize: 14, fontWeight: '600' },
});
