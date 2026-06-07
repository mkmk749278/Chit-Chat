/**
 * Mobile `Sign_In_Screen` (Phase 1, task 6.6; design Client Component 7: UI).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 7: UI", and `requirements.md` → Requirements 1.1, 1.5, 6.1.
 *
 * Presentational React Native component: phone-number + OTP inputs wired to the shared
 * `AuthService` through injected callbacks. On a rejected credential the entered phone
 * number is retained and a non-technical error is shown (1.5). Unlike the web screen
 * there is no ephemerality-warning gate (mobile persists to the encrypted SQLCipher
 * store, so messaging is never gated — Requirement 7.7 is web-only).
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

export interface SignInScreenProps {
  onRequestOtp: (e164: string) => Promise<boolean>;
  onConfirmOtp: (code: string) => Promise<boolean>;
}

export function SignInScreen({ onRequestOtp, onConfirmOtp }: SignInScreenProps): React.JSX.Element {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const e164Valid = /^\+[1-9]\d{6,14}$/.test(phone.trim());
  const codeValid = /^\d{6}$/.test(code.trim());

  const requestCode = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const ok = await onRequestOtp(phone.trim());
      if (ok) {
        setCodeRequested(true);
      } else {
        setError('We could not send a code to that number. Check it and try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const ok = await onConfirmOtp(code.trim());
      if (!ok) {
        // Retain the entered phone number on a rejected credential (1.5).
        setError('Sign-in did not succeed. Request a new code and try again.');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>chat-app</Text>

      <Text style={styles.label}>Phone number</Text>
      <TextInput
        style={styles.input}
        keyboardType="phone-pad"
        placeholder="+15551234567"
        value={phone}
        editable={!busy}
        onChangeText={setPhone}
        accessibilityLabel="Phone number"
      />

      {!codeRequested ? (
        <Pressable
          style={[styles.button, (!e164Valid || busy) && styles.buttonDisabled]}
          disabled={!e164Valid || busy}
          onPress={() => void requestCode()}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Send code</Text>
        </Pressable>
      ) : (
        <>
          <Text style={styles.label}>Verification code</Text>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            placeholder="123456"
            value={code}
            editable={!busy}
            onChangeText={setCode}
            accessibilityLabel="Verification code"
          />
          <Pressable
            style={[styles.button, (!codeValid || busy) && styles.buttonDisabled]}
            disabled={!codeValid || busy}
            onPress={() => void confirmCode()}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Verify &amp; sign in</Text>
          </Pressable>
        </>
      )}

      {error !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff', padding: 24, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700', textAlign: 'center', marginBottom: 24 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 12 },
  input: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    fontSize: 15,
  },
  button: {
    marginTop: 16,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#2563eb',
    alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: '#93c5fd' },
  buttonText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  error: { color: '#b91c1c', fontSize: 13, marginTop: 16 },
});
