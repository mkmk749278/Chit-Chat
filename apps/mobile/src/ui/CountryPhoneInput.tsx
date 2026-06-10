/**
 * `CountryPhoneInput` — a country selector + national-number field that composes an E.164
 * number, shared by sign-in and the New-chat screen.
 *
 * For India (the default) a user types just their 10-digit national number; the `+91`
 * dialing code is prepended automatically. For other countries the user picks the country
 * and the matching code is prepended. The composed E.164 (e.g. `+919618579123`) and a
 * validity flag are reported through {@link CountryPhoneInputProps.onChange}.
 */

import React, { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useTheme } from './theme';

/** A selectable country: ISO code, display name, E.164 dialing code, and flag emoji. */
export interface Country {
  iso: string;
  name: string;
  dial: string;
  flag: string;
}

/** Curated country list (dialing codes). Extend as needed. */
export const COUNTRIES: readonly Country[] = [
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

/** E.164: leading `+`, non-zero first digit, then 6..14 more digits. */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export interface CountryPhoneInputProps {
  /** Called whenever the composed number changes, with its E.164 form and validity. */
  onChange: (e164: string, valid: boolean) => void;
  /** Disable interaction (e.g. while a request is in flight). */
  disabled?: boolean;
}

export function CountryPhoneInput({ onChange, disabled = false }: CountryPhoneInputProps): React.JSX.Element {
  const t = useTheme();
  const [country, setCountry] = useState<Country>(COUNTRIES[0]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [nationalNumber, setNationalNumber] = useState('');

  const nationalDigits = useMemo(() => nationalNumber.replace(/\D/g, ''), [nationalNumber]);

  const report = (dial: string, digits: string): void => {
    const e164 = `${dial}${digits}`;
    onChange(e164, E164_PATTERN.test(e164));
  };

  return (
    <>
      <View style={styles.phoneRow}>
        <Pressable
          style={[styles.countryButton, { backgroundColor: t.surface, borderColor: t.divider }]}
          disabled={disabled}
          onPress={() => setPickerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Country: ${country.name}, ${country.dial}`}
        >
          <Text style={[styles.countryButtonText, { color: t.text }]}>
            {country.flag} {country.dial} ▾
          </Text>
        </Pressable>
        <TextInput
          style={[styles.numberInput, { backgroundColor: t.surface, borderColor: t.divider, color: t.text }]}
          keyboardType="phone-pad"
          placeholder="9618579123"
          placeholderTextColor={t.faint}
          value={nationalNumber}
          editable={!disabled}
          onChangeText={(text) => {
            setNationalNumber(text);
            report(country.dial, text.replace(/\D/g, ''));
          }}
          accessibilityLabel="National phone number"
        />
      </View>

      <Modal visible={pickerOpen} animationType="slide" transparent onRequestClose={() => setPickerOpen(false)}>
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
                    report(item.dial, nationalDigits);
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
    </>
  );
}

const styles = StyleSheet.create({
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
