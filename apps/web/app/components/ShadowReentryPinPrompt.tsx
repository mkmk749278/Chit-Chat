'use client';

/**
 * `ShadowReentryPinPrompt` — the per-chat-PIN re-entry prompt (Shadow Chat, task 15.2;
 * Requirements 12.2, 12.3, 12.4, 12.7).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Opening a shadow thread from the search
 * bar (UPDATED — optional PIN branch)". When a typed `/alias` resolves to a thread that carries a
 * per-chat `pinVerifier`, this prompt asks for the PIN and verifies it OFF the main work (an async
 * `verifySecret`): WHILE verification is in flight the submit control is disabled and a spinner
 * shows (Requirement 12.3, 12.7), so the UI never freezes. A correct PIN opens the thread; a WRONG
 * PIN shows a GENERIC failure with no shadow-specific signal (Requirement 12.4) and lets the user
 * retry or cancel. A thread with no per-chat PIN never reaches this prompt — it opens directly
 * (Requirement 12.1), which the container enforces.
 *
 * It renders through the top-layer {@link OverlayPortal} and is purely presentational: it owns its
 * input text only and reports submit/cancel through callbacks. The container (see
 * `useShadowReentryPin`) runs the actual verification and drives `busy` / `error`.
 */

import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';

import { OverlayPortal } from './OverlayPortal';

export interface ShadowReentryPinPromptProps {
  /** Whether the prompt is open. */
  open: boolean;
  /** Whether a verification is currently in flight (disables submit and shows the spinner). */
  busy: boolean;
  /** A generic failure message to show (e.g. after a wrong PIN), or `null` when none. */
  error: string | null;
  /** Submit the typed PIN for verification. */
  onSubmit: (pin: string) => void;
  /** Cancel the prompt without opening the thread. */
  onCancel: () => void;
}

export function ShadowReentryPinPrompt({
  open,
  busy,
  error,
  onSubmit,
  onCancel,
}: ShadowReentryPinPromptProps): JSX.Element {
  const [pin, setPin] = useState('');

  // Clear the field whenever the prompt (re)opens so a stale value never lingers.
  useEffect(() => {
    if (open) {
      setPin('');
    }
  }, [open]);

  const canSubmit = pin.length > 0 && !busy;

  const handleSubmit = useCallback(
    (event: FormEvent): void => {
      event.preventDefault();
      if (!canSubmit) {
        return;
      }
      onSubmit(pin);
    },
    [canSubmit, pin, onSubmit],
  );

  return (
    <OverlayPortal open={open} onDismiss={onCancel} ariaLabel="Enter PIN">
      <form style={styles.container} onSubmit={handleSubmit}>
        <h2 style={styles.heading}>Enter PIN</h2>
        <input
          aria-label="PIN"
          style={styles.input}
          type="password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder="PIN"
          autoComplete="off"
          autoFocus
          disabled={busy}
        />
        {error !== null && (
          <p role="alert" style={styles.error}>
            {error}
          </p>
        )}
        <div style={styles.actions}>
          <button type="button" style={styles.secondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" style={{ ...styles.primary, ...(canSubmit ? null : styles.primaryDisabled) }} disabled={!canSubmit}>
            {busy ? 'Checking…' : 'Open'}
          </button>
        </div>
      </form>
    </OverlayPortal>
  );
}

const styles: Record<string, CSSProperties> = {
  container: { padding: 24, display: 'flex', flexDirection: 'column' },
  heading: { margin: '0 0 14px', fontSize: 18, color: '#0f172a' },
  input: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    fontSize: 15,
    boxSizing: 'border-box',
    marginBottom: 12,
  },
  error: { margin: '0 0 12px', fontSize: 13, color: '#b91c1c' },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  secondary: {
    padding: '10px 18px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    background: '#fff',
    fontSize: 15,
    fontWeight: 600,
    color: '#334155',
    cursor: 'pointer',
  },
  primary: {
    padding: '10px 20px',
    borderRadius: 10,
    border: 'none',
    background: '#4338ca',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
  },
  primaryDisabled: { background: '#c7d2fe', cursor: 'not-allowed' },
};
