'use client';

/**
 * Web `Sign_In_Screen` with the ephemerality-warning gate (Phase 1, design Component 7).
 *
 * Source of truth: `.kiro/specs/phase1-client-messaging/design.md` →
 *   "Client Component 7: UI" + product decisions D9/D10, and `requirements.md` →
 *   Requirements 1.1, 1.5, 6.1, 7.3, 7.7, 8.3.
 *
 * Presentational only: phone-number + OTP inputs wired to the shared `AuthService`
 * through injected callbacks, plus the web-only ephemerality warning. The warning
 * (messages live in memory only and history is unreadable after the session ends —
 * there is no key backup or recovery) stays visible and MUST be explicitly acknowledged;
 * sign-in — and therefore all messaging — is gated on that acknowledgment (7.3, 7.7, 8.3).
 *
 * On a rejected credential the entered phone number is retained and a non-technical
 * error is shown (1.5); the component holds only local input/UI state and performs no
 * I/O itself — Firebase interaction flows through the injected handlers.
 */

import { useState } from 'react';
import type { CSSProperties } from 'react';

export interface SignInScreenProps {
  /** Whether the user has acknowledged the ephemerality warning (lifted to the container). */
  warningAcknowledged: boolean;
  /** Record the explicit acknowledgment of the ephemerality warning (7.7, 8.3). */
  onAcknowledgeWarning: () => void;
  /** Request an OTP for the entered E.164 phone number; resolves true on success (1.1). */
  onRequestOtp: (e164: string) => Promise<boolean>;
  /** Confirm the entered 6-digit code; resolves true on a successful sign-in (1.5). */
  onConfirmOtp: (code: string) => Promise<boolean>;
}

export function SignInScreen({
  warningAcknowledged,
  onAcknowledgeWarning,
  onRequestOtp,
  onConfirmOtp,
}: SignInScreenProps): JSX.Element {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Gate every action on the explicit ephemerality acknowledgment (7.7, 8.3).
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
    <main style={styles.screen}>
      <h1 style={styles.title}>chat-app</h1>

      <section aria-label="Privacy notice" style={styles.warning}>
        <strong style={styles.warningTitle}>Before you sign in</strong>
        <p style={styles.warningBody}>
          On the web, your messages and encryption keys live in this browser tab&apos;s memory
          only. When you sign out, close the tab, or reload, they are wiped and the
          conversation history becomes <strong>permanently unreadable</strong>. There is no
          key backup and no way to recover past messages — this is by design.
        </p>
        <label style={styles.ackLabel}>
          <input
            type="checkbox"
            checked={warningAcknowledged}
            onChange={onAcknowledgeWarning}
            aria-label="I understand messages are not saved"
          />
          I understand my messages are not saved and cannot be recovered.
        </label>
      </section>

      <fieldset style={styles.fieldset} disabled={!warningAcknowledged || busy}>
        <label style={styles.field}>
          Phone number
          <input
            style={styles.input}
            inputMode="tel"
            placeholder="+15551234567"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            aria-label="Phone number"
          />
        </label>

        {!codeRequested ? (
          <button
            type="button"
            style={styles.button}
            disabled={!e164Valid}
            onClick={() => void requestCode()}
          >
            Send code
          </button>
        ) : (
          <>
            <label style={styles.field}>
              Verification code
              <input
                style={styles.input}
                inputMode="numeric"
                placeholder="123456"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-label="Verification code"
              />
            </label>
            <button
              type="button"
              style={styles.button}
              disabled={!codeValid}
              onClick={() => void confirmCode()}
            >
              Verify &amp; sign in
            </button>
          </>
        )}
      </fieldset>

      {error !== null && (
        <p role="alert" style={styles.error}>
          {error}
        </p>
      )}
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  screen: { maxWidth: 420, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 16 },
  title: { fontSize: 28, fontWeight: 700, textAlign: 'center' },
  warning: { border: '1px solid #fbbf24', backgroundColor: '#fffbeb', borderRadius: 12, padding: 16, display: 'flex', flexDirection: 'column', gap: 8 },
  warningTitle: { fontSize: 15 },
  warningBody: { fontSize: 13, lineHeight: 1.5, margin: 0, color: '#78350f' },
  ackLabel: { display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, fontWeight: 600 },
  fieldset: { border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 600 },
  input: { padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 15 },
  button: { padding: '10px 20px', borderRadius: 8, border: 'none', backgroundColor: '#2563eb', color: '#fff', fontWeight: 600, cursor: 'pointer' },
  error: { color: '#b91c1c', fontSize: 13, margin: 0 },
};
