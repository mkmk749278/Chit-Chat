'use client';

/**
 * `ShadowPinSettings` — per-chat PIN settings for an OPEN shadow thread (Shadow Chat, task 16.2;
 * the web mirror of mobile 16.1; Requirements 12.5, 12.7, 12.8).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Per-chat PIN settings (add / change /
 * remove LATER)" and `requirements.md` → Requirement 12. Reachable from within an OPEN shadow
 * thread (the conversation header's options action), this overlay lets the user ADD, CHANGE, or
 * REMOVE the thread's per-chat PIN at any time after creation, all through the single shared-core
 * write `ShadowSecretStore.setThreadPin(mode, threadId, newPin | null)`:
 *   - typing a non-empty PIN and saving ⇒ `setThreadPin(mode, threadId, pin)` (adds or changes);
 *   - the Remove action ⇒ `setThreadPin(mode, threadId, null)` (clears the lock).
 *
 * **Real-mode only (Requirement 12.8).** The whole control is gated on `App_Mode === 'real'`: in
 * decoy / `null` (locked) mode it is ABSENT and inert, so a coerced or observing party cannot prove
 * the per-chat-PIN feature — or the shadow thread — exists. The container also hides the entry point
 * outside real mode, and the shared-core `setThreadPin` is itself a no-op in any non-real mode, so
 * the gate is enforced in depth.
 *
 * **Off the UI thread (Requirement 12.7).** Setting / changing a PIN runs PBKDF2 inside
 * `setThreadPin`; this component awaits that async work while DISABLING the submit/remove controls
 * and showing an in-flight spinner label, so the UI never freezes. Any failure surfaces a single
 * GENERIC message (no shadow-specific signal) and a success dismisses the overlay.
 *
 * It renders through the shared top-layer {@link OverlayPortal} and owns only its own input + busy /
 * error / current-PIN-presence state; the container passes the live `mode`, the open shadow
 * thread's `threadId`, and the provisioned `ShadowSecretStore`.
 */

import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';

import { type AppMode, type ShadowSecretStore } from '@chat-app/crypto';

import { OverlayPortal } from './OverlayPortal';

export interface ShadowPinSettingsProps {
  /** Whether the settings overlay is open. */
  open: boolean;
  /** The current resolved app mode (or `null`); the control is inert/absent unless `real`. */
  mode: AppMode | null;
  /** The open shadow thread whose per-chat PIN is being managed. */
  threadId: string;
  /** The provisioned real-PIN-gated device-local shadow secret store. */
  store: ShadowSecretStore;
  /** Dismiss the overlay (also called on a successful add / change / remove). */
  onClose: () => void;
}

/** Single, non-revealing failure message for any add / change / remove error (Requirement 12.7). */
const GENERIC_FAILURE = 'Could not update the PIN. Please try again.';


export function ShadowPinSettings({
  open,
  mode,
  threadId,
  store,
  onClose,
}: ShadowPinSettingsProps): JSX.Element {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether the thread currently carries a per-chat PIN: `null` while we are still loading it, so
  // the labels (Add vs Change) and the Remove action only appear once the real state is known.
  const [hasPin, setHasPin] = useState<boolean | null>(null);

  // The overlay only ever renders in real mode (Requirement 12.8); a non-real mode keeps it closed.
  const visible = open && mode === 'real';

  // On each (real-mode) open, reset the form and read whether a PIN is already set so the UI can
  // label itself correctly and offer Remove only when there is something to remove. Reading entries
  // is real-mode-gated in the store; any error fails closed to "no PIN" (still safe to add one).
  useEffect(() => {
    if (!visible) {
      return;
    }
    setPin('');
    setError(null);
    setBusy(false);
    setHasPin(null);
    let cancelled = false;
    void (async () => {
      try {
        const entries = await store.listAliasEntries(mode);
        const entry = entries.find((candidate) => candidate.ref.threadId === threadId);
        const verifier = entry?.ref.pinVerifier;
        if (!cancelled) {
          setHasPin(verifier !== undefined && verifier !== '');
        }
      } catch {
        if (!cancelled) {
          setHasPin(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, mode, threadId, store]);


  // The single shared-core write for all three operations: a non-empty string adds/changes the
  // PIN, `null` removes it. Runs PBKDF2 off the UI thread (we await it with the controls disabled),
  // dismisses on success, and surfaces a generic failure on error (Requirement 12.7).
  const applyPin = useCallback(
    async (newPin: string | null): Promise<void> => {
      if (busy) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await store.setThreadPin(mode, threadId, newPin);
        onClose();
      } catch {
        setError(GENERIC_FAILURE);
        setBusy(false);
      }
    },
    [busy, store, mode, threadId, onClose],
  );

  const trimmedPin = pin.trim();
  const canSave = trimmedPin.length > 0 && !busy;
  const canRemove = hasPin === true && !busy;

  const handleSubmit = useCallback(
    (event: FormEvent): void => {
      event.preventDefault();
      if (canSave) {
        void applyPin(trimmedPin);
      }
    },
    [canSave, applyPin, trimmedPin],
  );

  const handleRemove = useCallback((): void => {
    if (canRemove) {
      void applyPin(null);
    }
  }, [canRemove, applyPin]);

  const heading = hasPin ? 'Change PIN' : 'Add a PIN';
  const subhead = hasPin
    ? 'Update or remove the PIN asked for each time you re-open this chat.'
    : 'Set a PIN that will be asked for each time you re-open this chat.';
  const saveLabel = busy ? 'Saving…' : hasPin ? 'Change PIN' : 'Add PIN';


  return (
    <OverlayPortal open={visible} onDismiss={onClose} ariaLabel="Per-chat PIN settings">
      <form style={styles.container} onSubmit={handleSubmit}>
        <h2 style={styles.heading}>{heading}</h2>
        <p style={styles.subhead}>{subhead}</p>

        <label style={styles.label} htmlFor="shadow-pin-settings">
          {hasPin ? 'New PIN' : 'PIN'}
        </label>
        <input
          id="shadow-pin-settings"
          style={styles.input}
          type="password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder={hasPin ? 'Enter a new PIN' : 'Enter a PIN'}
          autoComplete="off"
          autoFocus
          disabled={busy}
        />
        <span style={styles.hint}>
          You will be asked for this PIN each time you re-open this chat.
        </span>

        {error !== null && (
          <p role="alert" style={styles.error}>
            {error}
          </p>
        )}

        <div style={styles.actions}>
          <button type="button" style={styles.secondary} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {hasPin === true && (
            <button
              type="button"
              style={{ ...styles.remove, ...(canRemove ? null : styles.disabled) }}
              onClick={handleRemove}
              disabled={!canRemove}
            >
              {busy ? 'Working…' : 'Remove PIN'}
            </button>
          )}
          <button
            type="submit"
            style={{ ...styles.primary, ...(canSave ? null : styles.disabled) }}
            disabled={!canSave}
          >
            {saveLabel}
          </button>
        </div>
      </form>
    </OverlayPortal>
  );
}


const styles: Record<string, CSSProperties> = {
  container: { padding: 24, display: 'flex', flexDirection: 'column' },
  heading: { margin: '0 0 4px', fontSize: 18, color: '#0f172a' },
  subhead: { margin: '0 0 16px', fontSize: 13, color: '#64748b' },
  label: { fontSize: 13, fontWeight: 600, color: '#334155', marginBottom: 6 },
  input: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    fontSize: 15,
    boxSizing: 'border-box',
  },
  hint: { fontSize: 12, color: '#94a3b8', margin: '6px 0 16px' },
  error: { margin: '0 0 12px', fontSize: 13, color: '#b91c1c' },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap', marginTop: 4 },
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
  remove: {
    padding: '10px 18px',
    borderRadius: 10,
    border: '1px solid #fecaca',
    background: '#fff',
    fontSize: 15,
    fontWeight: 600,
    color: '#b91c1c',
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
  disabled: { opacity: 0.5, cursor: 'not-allowed' },
};
