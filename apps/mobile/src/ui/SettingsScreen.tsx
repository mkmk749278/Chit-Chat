/**
 * Settings tab (design/mockups screen 05): profile card, Security & Privacy group,
 * App group, sign out. Rows that need later wiring (encryption keys, safety number)
 * render as disclosure rows; the container supplies the actions that exist today.
 */

import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { initials, useTheme } from './theme';

/** Diagnostics surfaced for troubleshooting encryption setup + discovery. */
export interface SettingsDiagnostics {
  phase: string;
  error?: string;
  deviceId: string | null;
  uid: string | null;
}

export function SettingsScreen({
  displayName,
  phone,
  diagnostics,
  presenceEnabled = false,
  onTogglePresence,
  onSelfTest,
  onSignOut,
}: {
  displayName: string;
  phone: string;
  diagnostics: SettingsDiagnostics;
  /** Whether the user has opted in to presence/last-seen (Req 5.1). */
  presenceEnabled?: boolean;
  /** Toggle the presence opt-in. */
  onTogglePresence?: (enabled: boolean) => void;
  /** Resolve this device's OWN phone number through the directory (self-test). */
  onSelfTest: () => Promise<{ ok: boolean; detail: string }>;
  onSignOut: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const runSelfTest = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await onSelfTest();
      setTestResult(result.detail);
    } finally {
      setTesting(false);
    }
  };

  const short = (value: string | null): string =>
    value === null ? '—' : value.length > 14 ? `${value.slice(0, 14)}…` : value;
  return (
    <ScrollView style={[styles.screen, { backgroundColor: t.bg }]}>
      <Text style={[styles.title, { color: t.text }]}>Settings</Text>

      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.divider }]}>
        <View style={styles.profileRow}>
          <View style={[styles.avatar, { backgroundColor: t.brand }]}>
            <Text style={[styles.avatarText, { color: t.onBrand }]}>{initials(displayName)}</Text>
          </View>
          <View style={styles.profileBody}>
            <Text style={[styles.profileName, { color: t.text }]}>{displayName}</Text>
            <Text style={[styles.profilePhone, { color: t.subtext }]}>{phone}</Text>
          </View>
        </View>
      </View>

      <Text style={[styles.section, { color: t.faint }]}>SECURITY &amp; PRIVACY</Text>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.divider }]}>
        <Row icon="🔑" label="Encryption keys" theme={t} />
        <Divider color={t.divider} />
        <Row icon="🛡️" label="Safety number" theme={t} />
        <Divider color={t.divider} />
        <Row
          icon="🟢"
          label="Show when I'm online"
          theme={t}
          toggle
          toggleValue={presenceEnabled}
          {...(onTogglePresence !== undefined ? { onToggle: onTogglePresence } : {})}
        />
        <Divider color={t.divider} />
        <Row icon="🧹" label="Wipe data on sign-out" theme={t} toggle toggleValue />
      </View>

      <Text style={[styles.section, { color: t.faint }]}>DIAGNOSTICS</Text>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.divider }]}>
        <View style={styles.row}>
          <Text style={styles.rowIcon}>🔐</Text>
          <Text style={[styles.rowLabel, { color: t.text }]}>Encryption setup</Text>
          <Text style={[styles.rowValue, { color: diagnostics.phase === 'ready' ? t.secure : t.faint }]}>
            {diagnostics.phase}
          </Text>
        </View>
        {diagnostics.error !== undefined && (
          <>
            <Divider color={t.divider} />
            <View style={styles.row}>
              <Text style={styles.rowIcon}>⚠</Text>
              <Text style={[styles.rowLabel, { color: t.danger }]} numberOfLines={3}>
                {diagnostics.error}
              </Text>
            </View>
          </>
        )}
        <Divider color={t.divider} />
        <View style={styles.row}>
          <Text style={styles.rowIcon}>📱</Text>
          <Text style={[styles.rowLabel, { color: t.text }]}>Device registered</Text>
          <Text style={[styles.rowValue, { color: t.faint }]}>
            {diagnostics.deviceId !== null ? `yes (${short(diagnostics.deviceId)})` : 'no'}
          </Text>
        </View>
        <Divider color={t.divider} />
        <Pressable style={styles.row} onPress={() => void runSelfTest()} accessibilityRole="button">
          <Text style={styles.rowIcon}>🔎</Text>
          <Text style={[styles.rowLabel, { color: t.brandSoft }]}>
            {testing ? 'Testing…' : 'Test discovery (my number)'}
          </Text>
        </Pressable>
        {testResult !== null && (
          <>
            <Divider color={t.divider} />
            <View style={styles.row}>
              <Text style={styles.rowIcon}>›</Text>
              <Text style={[styles.rowLabel, { color: t.subtext }]} numberOfLines={3}>
                {testResult}
              </Text>
            </View>
          </>
        )}
      </View>

      <Text style={[styles.section, { color: t.faint }]}>APP</Text>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.divider }]}>
        <Row icon="🔔" label="Notifications" theme={t} toggle toggleValue />
        <Divider color={t.divider} />
        <Row icon="🌙" label="Appearance" theme={t} value="System" />
        <Divider color={t.divider} />
        <Row icon="ℹ️" label="About Lumin" theme={t} />
      </View>

      <Pressable
        style={[styles.signOut, { backgroundColor: t.dangerSoft }]}
        onPress={onSignOut}
        accessibilityRole="button"
      >
        <Text style={[styles.signOutText, { color: t.danger }]}>Sign out</Text>
      </Pressable>
      <View style={styles.footer} />
    </ScrollView>
  );
}

function Row({
  icon,
  label,
  theme: t,
  value,
  toggle = false,
  toggleValue = false,
  onToggle,
}: {
  icon: string;
  label: string;
  theme: ReturnType<typeof useTheme>;
  value?: string;
  toggle?: boolean;
  toggleValue?: boolean;
  /** When provided, the toggle is interactive and reports changes here. */
  onToggle?: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <Text style={[styles.rowLabel, { color: t.text }]}>{label}</Text>
      {toggle ? (
        <Switch
          value={toggleValue}
          trackColor={{ true: t.brand, false: t.field }}
          thumbColor="#FFFFFF"
          // Interactive when an onToggle handler is supplied; display-only otherwise.
          disabled={onToggle === undefined}
          {...(onToggle !== undefined ? { onValueChange: onToggle } : {})}
        />
      ) : (
        <Text style={[styles.rowValue, { color: t.faint }]}>{value ? `${value} ›` : '›'}</Text>
      )}
    </View>
  );
}

function Divider({ color }: { color: string }): React.JSX.Element {
  return <View style={[styles.divider, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  title: { fontSize: 30, fontWeight: '800', paddingHorizontal: 20, paddingTop: 16 },
  card: {
    marginHorizontal: 20,
    marginTop: 12,
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
  },
  profileRow: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 20, fontWeight: '700' },
  profileBody: { marginLeft: 14 },
  profileName: { fontSize: 18, fontWeight: '700' },
  profilePhone: { fontSize: 13, marginTop: 2 },
  section: { fontSize: 12, fontWeight: '700', paddingHorizontal: 26, marginTop: 22 },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  rowIcon: { fontSize: 16, width: 30 },
  rowLabel: { flex: 1, fontSize: 15 },
  rowValue: { fontSize: 14 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  signOut: {
    marginHorizontal: 20,
    marginTop: 28,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  signOutText: { fontSize: 15, fontWeight: '700' },
  footer: { height: 32 },
});
