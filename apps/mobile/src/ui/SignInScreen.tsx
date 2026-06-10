/**
 * Mobile `Sign_In_Screen` (Phase 1, task 6.6; design Client Component 7: UI).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 7: UI", and `requirements.md` → Requirements 1.1, 1.5, 6.1.
 *
 * Presentational React Native component: a country selector + national-number input are
 * combined into an E.164 number and passed to the shared `AuthService` via injected
 * callbacks. On a rejected request the entered number is retained and a non-technical
 * message is shown, plus the raw provider error code to aid diagnosis (1.5).
 */

import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useTheme } from './theme';

/** A selectable country: ISO code, display name, E.164 dialing code, and flag emoji. */
interface Country {
  iso: string;
  name: string;
  dial: string;
  flag: string;
}

/** Curated country list (dialing codes). Extend as needed. */
const COUNTRIES: readonly Country[] = [
  { iso: 'IN', name: 'India', dial: '+91', flag: '🇮🇳' },
  { iso: 'US', name: 'United States', dial: '+1', flag: '🇺🇸' },
  { iso: 'GB', name: 'United Kingdom', dial: '+44', flag: '🇬🇧' },
  { iso: 'CA', name: 'Canada', dial: '+1', flag: '🇨🇦' },
  { iso: 'AU', name: 'Australia', dial: '+61', flag: '🇦🇺' },
  { iso: 'AE', name: 'United Arab Emirates', dial: '+971', flag: '🇦🇪' },
  { iso: 'SA', name: 'Saudi Arabia', dial: '+966', flag: '🇸🇦' },
  { iso: 'SG', name: 'Singapore', dial: '+65', flag: '🇸🇬' },
  { iso: 'DE', name: 'Germany', dial: '+49', flag: '🇩🇪' },
  { iso: 'FR', name: 'France', dial: '+33', flag: '🇫🇷' },
  { iso: 'PK', name: 'Pakistan', dial: '+92', flag: '🇵🇰' },
  { iso: 'BD', name: 'Bangladesh', dial: '+880', flag: '🇧🇩' },
  { iso: 'LK', name: 'Sri Lanka', dial: '+94', flag: '🇱🇰' },
  { iso: 'NP', name: 'Nepal', dial: '+977', flag: '🇳🇵' },
  { iso: 'NG', name: 'Nigeria', dial: '+234', flag: '🇳🇬' },
  { iso: 'ZA', name: 'South Africa', dial: '+27', flag: '🇿🇦' },
];

/** Map a Firebase auth error code to a friendly, non-technical message. */
function friendlyError(code: string | undefined): string {
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'That phone number looks invalid. Check the country and number.';
    case 'auth/operation-not-allowed':
      return 'Phone sign-in is not enabled for this app yet.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a while and try again.';
    case 'auth/quota-exceeded':
      return 'The daily SMS limit was reached. Try again later.';
    case 'auth/app-not-authorized':
    case 'auth/missing-client-identifier':
      return 'App verification failed. The app build is not authorized for this Firebase project.';
    default:
      return code !== undefined && code.length > 0
        ? `We could not send a code (${code}). Check the number and try again.`
        : 'We could not send a code to that number. Check it and try again.';
  }
}

export interface SignInScreenProps {
  onRequestOtp: (e164: string) => Promise<{ ok: boolean; error?: string }>;
  /** Confirm the OTP; `e164` is the number the code was sent to (for the profile). */
  onConfirmOtp: (code: string, e164: string) => Promise<boolean>;
}

export function SignInScreen({ onRequestOtp, onConfirmOtp }: SignInScreenProps): React.JSX.Element {
  const t = useTheme();
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nationalNumber, setNationalNumber] = useState('');
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // National significant number = digits only; E.164 = dial code + that.
  const nationalDigits = useMemo(() => nationalNumber.replace(/\D/g, ''), [nationalNumber]);
  const e164 = `${country.dial}${nationalDigits}`;
  const e164Valid = /^\+[1-9]\d{6,14}$/.test(e164);
  const codeValid = /^\d{6}$/.test(code.trim());

  const requestCode = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const result = await onRequestOtp(e164);
      if (result.ok) {
        setCodeRequested(true);
      } else {
        setError(friendlyError(result.error));
      }
    } finally {
      setBusy(false);
    }
  };

  const confirmCode = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      const ok = await onConfirmOtp(code.trim(), e164);
      if (!ok) {
        setError('Sign-in did not succeed. Request a new code and try again.');
        setCode('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[styles.screen, { backgroundColor: t.bg }]}>
      <View style={[styles.logo, { backgroundColor: t.brand }]}>
        <Text style={styles.logoGlyph}>🔒</Text>
      </View>
      <Text style={[styles.title, { color: t.text }]}>Lumin Chat</Text>
      <Text style={[styles.subtitle, { color: t.subtext }]}>
        Private, end-to-end encrypted messaging
      </Text>

      <Text style={[styles.label, { color: t.subtext }]}>Phone number</Text>
      <View style={styles.phoneRow}>
        <Pressable
          style={[styles.countryButton, { backgroundColor: t.surface, borderColor: t.divider }]}
          disabled={busy || codeRequested}
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Country: ${country.name}, ${country.dial}`}
        >
          <Text style={[styles.countryButtonText, { color: t.text }]}>
            {country.flag} {country.dial} ▾
          </Text>
        </Pressable>
        <TextInput
          style={[
            styles.numberInput,
            { backgroundColor: t.surface, borderColor: t.divider, color: t.text },
          ]}
          keyboardType="phone-pad"
          placeholder="9618579123"
          placeholderTextColor={t.faint}
          value={nationalNumber}
          editable={!busy && !codeRequested}
          onChangeText={setNationalNumber}
          accessibilityLabel="National phone number"
        />
      </View>

      {!codeRequested ? (
        <Pressable
          style={[
            styles.button,
            { backgroundColor: t.brand },
            (!e164Valid || busy) && styles.buttonDisabled,
          ]}
          disabled={!e164Valid || busy}
          onPress={() => void requestCode()}
          accessibilityRole="button"
        >
          <Text style={[styles.buttonText, { color: t.onBrand }]}>Send code</Text>
        </Pressable>
      ) : (
        <>
          <Text style={[styles.label, { color: t.subtext }]}>Verification code</Text>
          <TextInput
            style={[
              styles.input,
              { backgroundColor: t.surface, borderColor: t.divider, color: t.text },
            ]}
            keyboardType="number-pad"
            placeholder="123456"
            placeholderTextColor={t.faint}
            value={code}
            editable={!busy}
            onChangeText={setCode}
            accessibilityLabel="Verification code"
          />
          <Pressable
            style={[
              styles.button,
              { backgroundColor: t.brand },
              (!codeValid || busy) && styles.buttonDisabled,
            ]}
            disabled={!codeValid || busy}
            onPress={() => void confirmCode()}
            accessibilityRole="button"
          >
            <Text style={[styles.buttonText, { color: t.onBrand }]}>Verify &amp; sign in</Text>
          </Pressable>
        </>
      )}

      {error !== null && (
        <Text style={[styles.error, { color: t.danger }]} accessibilityRole="alert">
          {error}
        </Text>
      )}

      <View style={[styles.privacyCard, { backgroundColor: t.brandFill }]}>
        <Text style={[styles.privacyTitle, { color: t.secure }]}>🔒 End-to-end encrypted</Text>
        <Text style={[styles.privacyBody, { color: t.subtext }]}>
          Messages are encrypted on your device. We can't read them — and we don't store
          them.
        </Text>
      </View>

      <Modal
        visible={pickerOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerOpen(false)}>
          <View style={[styles.modalSheet, { backgroundColor: t.surface }]}>
            <Text style={[styles.modalTitle, { color: t.text }]}>Select country</Text>
            <FlatList
              data={COUNTRIES}
              keyExtractor={(item) => item.iso}
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.countryRow, { borderBottomColor: t.divider }]}
                  onPress={() => {
                    setCountry(item);
                    setPickerOpen(false);
                  }}
                  accessibilityRole="button"
                >
                  <Text style={[styles.countryRowText, { color: t.text }]}>
                    {item.flag}  {item.name}
                  </Text>
                  <Text style={[styles.countryRowDial, { color: t.subtext }]}>{item.dial}</Text>
                </Pressable>
              )}
            />
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 24, justifyContent: 'center' },
  logo: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18,
  },
  logoGlyph: { fontSize: 36 },
  title: { fontSize: 28, fontWeight: '800', textAlign: 'center' },
  subtitle: { fontSize: 14, textAlign: 'center', marginTop: 6, marginBottom: 28 },
  label: { fontSize: 13, fontWeight: '600', marginBottom: 6, marginTop: 12 },
  phoneRow: { flexDirection: 'row', gap: 8 },
  countryButton: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 13,
    borderWidth: 1,
    justifyContent: 'center',
  },
  countryButtonText: { fontSize: 15, fontWeight: '600' },
  numberInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 13,
    borderWidth: 1,
    fontSize: 15,
  },
  input: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 13,
    borderWidth: 1,
    fontSize: 15,
  },
  button: {
    marginTop: 18,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { fontWeight: '700', fontSize: 16 },
  error: { fontSize: 13, marginTop: 16 },
  privacyCard: { borderRadius: 16, padding: 16, marginTop: 28 },
  privacyTitle: { fontSize: 13, fontWeight: '700' },
  privacyBody: { fontSize: 12, marginTop: 6, lineHeight: 17 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 32,
    maxHeight: '70%',
  },
  modalTitle: { fontSize: 16, fontWeight: '700', marginBottom: 12 },
  countryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  countryRowText: { fontSize: 15 },
  countryRowDial: { fontSize: 15 },
});
