/**
 * Settings tab (design/mockups screen 05): profile card, Security & Privacy group,
 * App group, sign out. Rows that need later wiring (encryption keys, safety number)
 * render as disclosure rows; the container supplies the actions that exist today.
 */

import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { runBusy, submitGate } from './async-submit';
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
  appLockEnabled = false,
  decoyEnabled = false,
  onSetAppPin,
  onClearAppPin,
  onLockNow,
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
  /** Whether a real app-lock PIN is set (Signature Feature 4, §6). */
  appLockEnabled?: boolean;
  /** Whether a decoy PIN is set (§6). */
  decoyEnabled?: boolean;
  /** Set the real or decoy PIN. May hash asynchronously (Requirement 1.3). */
  onSetAppPin?: (pin: string, kind: 'real' | 'decoy') => void | Promise<void>;
  /** Remove the real or decoy PIN. May resolve asynchronously (Requirement 1.3). */
  onClearAppPin?: (kind: 'real' | 'decoy') => void | Promise<void>;
  /** Lock the app immediately (to test the lock screen); requires a real PIN. */
  onLockNow?: () => void;
}): React.JSX.Element {
  const t = useTheme();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  // PIN-entry modal: which kind we're setting, plus the entered digits.
  const [pinModal, setPinModal] = useState<'real' | 'decoy' | null>(null);
  const [pinDraft, setPinDraft] = useState('');
  // True while a real/decoy PIN set-or-clear hash is in flight (Requirement 1.3).
  const [pinBusy, setPinBusy] = useState(false);
  const pinValid = /^\d{4,6}$/.test(pinDraft);
  const pinGate = submitGate({ valid: pinValid, busy: pinBusy });

  const closePinModal = (): void => {
    if (pinBusy) {
      return;
    }
    setPinModal(null);
    setPinDraft('');
  };
  const submitPin = (): void => {
    if (pinModal === null) {
      return;
    }
    const kind = pinModal;
    void runBusy({
      enabled: pinValid,
      busy: pinBusy,
      setBusy: setPinBusy,
      action: async () => {
        await onSetAppPin?.(pinDraft, kind);
        setPinModal(null);
        setPinDraft('');
      },
    });
  };
  // Set (open the entry modal) or clear an existing PIN; clearing runs behind the same busy flag so
  // its row is disabled while the vault mutation resolves.
  const onPinRow = (kind: 'real' | 'decoy', enabled: boolean): void => {
    if (pinBusy) {
      return;
    }
    if (enabled) {
      void runBusy({ enabled: true, busy: pinBusy, setBusy: setPinBusy, action: () => onClearAppPin?.(kind) });
    } else {
      setPinModal(kind);
    }
  };

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

      <Text style={[styles.section, { color: t.faint }]}>APP LOCK</Text>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.divider }]}>
        {/* App-lock PIN (Signature Feature 4, §6): set it, then the app locks on launch/background. */}
        <Pressable
          style={styles.row}
          accessibilityRole="button"
          disabled={pinBusy}
          onPress={() => onPinRow('real', appLockEnabled)}
        >
          <Text style={styles.rowIcon}>🔒</Text>
          <Text style={[styles.rowLabel, { color: t.text }]}>App lock PIN</Text>
          {pinBusy ? (
            <ActivityIndicator color={t.brandSoft} accessibilityLabel="Updating app lock PIN" />
          ) : (
            <Text style={[styles.rowValue, { color: appLockEnabled ? t.secure : t.brandSoft }]}>
              {appLockEnabled ? 'On · tap to remove' : 'Set PIN ›'}
            </Text>
          )}
        </Pressable>
        <Divider color={t.divider} />
        {/* Decoy PIN (§6): opens a sanitised app state — hidden chats stay hidden. */}
        <Pressable
          style={styles.row}
          accessibilityRole="button"
          disabled={pinBusy}
          onPress={() => onPinRow('decoy', decoyEnabled)}
        >
          <Text style={styles.rowIcon}>🕶️</Text>
          <Text style={[styles.rowLabel, { color: t.text }]}>Decoy PIN</Text>
          <Text style={[styles.rowValue, { color: decoyEnabled ? t.secure : t.brandSoft }]}>
            {decoyEnabled ? 'On · tap to remove' : 'Set decoy ›'}
          </Text>
        </Pressable>
        {appLockEnabled && onLockNow !== undefined && (
          <>
            <Divider color={t.divider} />
            <Pressable style={styles.row} accessibilityRole="button" onPress={onLockNow}>
              <Text style={styles.rowIcon}>🔐</Text>
              <Text style={[styles.rowLabel, { color: t.brandSoft }]}>Lock now</Text>
            </Pressable>
          </>
        )}
      </View>
      <Text style={[styles.hintText, { color: t.faint }]}>
        Set a PIN, then tap “Lock now” (or reopen the app) to see the lock screen. A decoy PIN opens a
        sanitised view that hides your hidden chats. There’s no recovery if you forget a PIN.
      </Text>

      <Text style={[styles.section, { color: t.faint }]}>SECURITY &amp; PRIVACY</Text>
      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.divider }]}>
        <Row icon="🤫" label="Hidden chats" theme={t} value="In a chat: 🫥" />
        <Divider color={t.divider} />
        <Row icon="👤" label="Verify identity" theme={t} value="In a chat: 👤" />
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

      {/* PIN-entry modal for setting the real or decoy app-lock PIN (§6). */}
      <Modal visible={pinModal !== null} transparent animationType="fade" onRequestClose={closePinModal}>
        <Pressable style={styles.backdrop} onPress={closePinModal} accessibilityLabel="Dismiss">
          <Pressable style={[styles.sheet, { backgroundColor: t.surface }]} onPress={() => undefined}>
            <Text style={[styles.sheetTitle, { color: t.text }]}>
              {pinModal === 'decoy' ? 'Set decoy PIN' : 'Set app lock PIN'}
            </Text>
            <Text style={[styles.sheetHint, { color: t.faint }]}>
              {pinModal === 'decoy'
                ? 'Entering this PIN opens a sanitised view with your hidden chats kept hidden.'
                : 'A 4–6 digit PIN. The app locks on launch and when backgrounded.'}
            </Text>
            <TextInput
              style={[styles.pinInput, { color: t.text, backgroundColor: t.field }]}
              value={pinDraft}
              onChangeText={setPinDraft}
              keyboardType="number-pad"
              secureTextEntry
              maxLength={6}
              editable={!pinBusy}
              autoFocus
              accessibilityLabel="PIN"
              onSubmitEditing={submitPin}
            />
            <Pressable
              style={[styles.sheetButton, { backgroundColor: t.brand }, pinGate.disabled && styles.sheetButtonDisabled]}
              disabled={pinGate.disabled}
              onPress={submitPin}
              accessibilityRole="button"
              accessibilityState={{ disabled: pinGate.disabled, busy: pinGate.showProgress }}
            >
              {pinGate.showProgress ? (
                <ActivityIndicator color={t.onBrand} accessibilityLabel="Saving PIN" />
              ) : (
                <Text style={[styles.sheetButtonText, { color: t.onBrand }]}>Save PIN</Text>
              )}
            </Pressable>
            <Pressable style={styles.sheetCancel} onPress={closePinModal} disabled={pinBusy} accessibilityRole="button">
              <Text style={[styles.sheetCancelText, { color: t.brandSoft }]}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
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
  hintText: { fontSize: 12, lineHeight: 17, paddingHorizontal: 26, marginTop: 8 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'center', paddingHorizontal: 28 },
  sheet: { borderRadius: 18, padding: 20 },
  sheetTitle: { fontSize: 18, fontWeight: '700' },
  sheetHint: { fontSize: 13, marginTop: 8, marginBottom: 16, lineHeight: 18 },
  pinInput: {
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 22,
    letterSpacing: 8,
    textAlign: 'center',
  },
  sheetButton: { marginTop: 16, borderRadius: 12, paddingVertical: 13, alignItems: 'center' },
  sheetButtonDisabled: { opacity: 0.4 },
  sheetButtonText: { fontSize: 15, fontWeight: '700' },
  sheetCancel: { marginTop: 6, paddingVertical: 10, alignItems: 'center' },
  sheetCancelText: { fontSize: 14, fontWeight: '600' },
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
