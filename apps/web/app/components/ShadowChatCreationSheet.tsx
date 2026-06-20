'use client';

/**
 * `ShadowChatCreationSheet` — the long-press shadow-chat creation sheet (Shadow Chat, task 15.2;
 * Requirements 11.3, 11.4, 11.6, 11.9, 11.10).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Creating a shadow chat from a long-press"
 * and `requirements.md` → Requirement 11. Opened from the "Shadow chat" action of
 * {@link ShadowChatOverlayMenu}, it collects:
 *   - an **alias** field that must start with `/` and is validated INLINE via the shared-core
 *     `normalizeAlias` (through {@link isValidAlias}); an invalid alias is refused — the confirm
 *     control stays disabled and an inline hint is shown (Requirement 11.3); and
 *   - an **optional per-chat PIN** field that is **blank by default and skippable** (Requirement
 *     11.6, design "Optional per-chat PIN (NEW; default = NO PIN)").
 *
 * On confirm it calls {@link ShadowChatCreationSheetProps.onConfirm} (wired by the container to
 * `bindWebShadowChat` → `ShadowSecretStore.bindAlias('real', alias, peerUid, myUid, pin?)` →
 * `ConversationRegistry.openShadowThread` → dismiss). While the bind/PBKDF2 work is in flight the
 * confirm control is disabled and a spinner shows, so the UI never appears frozen. This component
 * performs NO send and mutates NO surface state — creation never disturbs the surface chat
 * (Requirements 11.7, 11.8); the created thread stays hidden, re-enterable only via its `/alias`
 * (Requirement 11.10). It renders through the top-layer {@link OverlayPortal} (Requirement 11.1).
 */

import { useCallback, useState, type CSSProperties, type FormEvent } from 'react';

import { isValidAlias } from '../lib/shadow-search';
import { OverlayPortal } from './OverlayPortal';

export interface ShadowChatCreationSheetProps {
  /** Whether the sheet is open. */
  open: boolean;
  /** A human label for the contact the shadow chat is being created with (shown for context). */
  contactLabel: string;
  /** Dismiss the sheet without creating anything (no surface mutation). */
  onCancel: () => void;
  /**
   * Confirm creation with the typed alias and the optional PIN (empty ⇒ no per-chat PIN). The
   * container performs the actual `bindAlias` + open; this resolves when binding completes (the
   * sheet shows its in-flight state until then) and may reject on an invalid alias / persistence
   * error, which the sheet surfaces inline.
   */
  onConfirm: (alias: string, pin: string | undefined) => Promise<void>;
}

export function ShadowChatCreationSheet({
  open,
  contactLabel,
  onCancel,
  onConfirm,
}: ShadowChatCreationSheetProps): JSX.Element {
  const [alias, setAlias] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedAlias = alias.trim();
  // Inline validation via the shared-core grammar (Req 11.3). An empty field shows no error yet.
  const aliasValid = isValidAlias(trimmedAlias);
  const showAliasHint = trimmedAlias.length > 0 && !aliasValid;
  const canConfirm = aliasValid && !busy;

  const reset = useCallback((): void => {
    setAlias('');
    setPin('');
    setBusy(false);
    setError(null);
  }, []);

  const handleCancel = useCallback((): void => {
    reset();
    onCancel();
  }, [reset, onCancel]);

  const handleSubmit = useCallback(
    async (event: FormEvent): Promise<void> => {
      event.preventDefault();
      if (!aliasValid || busy) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        // Optional PIN: an empty field means "no per-chat PIN" (the default).
        await onConfirm(trimmedAlias, pin.length > 0 ? pin : undefined);
        reset();
      } catch {
        // Generic, non-revealing failure; the alias is not bound.
        setError('Could not create the chat. Check the alias and try again.');
        setBusy(false);
      }
    },
    [aliasValid, busy, trimmedAlias, pin, onConfirm, reset],
  );

  return (
    <OverlayPortal open={open} onDismiss={handleCancel} ariaLabel="Create shadow chat">
      <form style={styles.container} onSubmit={handleSubmit}>
        <h2 style={styles.heading}>New shadow chat</h2>
        <p style={styles.subhead}>Hidden conversation with {contactLabel}. Re-open it later by typing its alias.</p>

        <label style={styles.label} htmlFor="shadow-alias">
          Alias
        </label>
        <input
          id="shadow-alias"
          style={{ ...styles.input, ...(showAliasHint ? styles.inputError : null) }}
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          placeholder="/example"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={showAliasHint}
          aria-describedby="shadow-alias-hint"
          disabled={busy}
        />
        <span id="shadow-alias-hint" style={{ ...styles.hint, color: showAliasHint ? '#b91c1c' : '#94a3b8' }}>
          {showAliasHint
            ? 'Start with / followed by lowercase letters or numbers (e.g. /notes2).'
            : 'Must start with / (e.g. /notes2). Keep it private — it is the key to this chat.'}
        </span>

        <label style={styles.label} htmlFor="shadow-pin">
          Per-chat PIN <span style={styles.optional}>(optional)</span>
        </label>
        <input
          id="shadow-pin"
          style={styles.input}
          type="password"
          value={pin}
          onChange={(event) => setPin(event.target.value)}
          placeholder="Leave blank for no PIN"
          autoComplete="off"
          disabled={busy}
        />
        <span style={styles.hint}>Optional. If set, you will be asked for it each time you re-open this chat.</span>

        {error !== null && (
          <p role="alert" style={styles.error}>
            {error}
          </p>
        )}

        <div style={styles.actions}>
          <button type="button" style={styles.secondary} onClick={handleCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" style={{ ...styles.primary, ...(canConfirm ? null : styles.primaryDisabled) }} disabled={!canConfirm}>
            {busy ? 'Creating…' : 'Create'}
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
  optional: { fontWeight: 400, color: '#94a3b8' },
  input: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    fontSize: 15,
    boxSizing: 'border-box',
  },
  inputError: { borderColor: '#f87171' },
  hint: { fontSize: 12, margin: '6px 0 16px' },
  error: { margin: '0 0 12px', fontSize: 13, color: '#b91c1c' },
  actions: { display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 },
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
