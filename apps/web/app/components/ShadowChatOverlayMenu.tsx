'use client';

/**
 * `ShadowChatOverlayMenu` — the long-press overlay action menu (Shadow Chat, task 15.2;
 * Requirements 11.1, 11.2, 11.5).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Creating a shadow chat from a long-press"
 * and `requirements.md` → Requirement 11. A press-and-hold on a chat-list row or a contact /
 * new-chat row opens this menu, rendered as a TOP-LAYER portal overlay (via {@link OverlayPortal})
 * above all chat-list and conversation content, so its z-order is always correct (Requirement 11.1).
 *
 * The menu includes a **"Shadow chat"** action ONLY when `App_Mode === 'real'` (Requirement 11.2,
 * 11.5): in `decoy` mode, in `null` (locked / wrong-PIN) mode, the action is entirely ABSENT, so a
 * coerced or observing party sees an ordinary row menu and cannot prove the shadow feature exists.
 * It is otherwise a plain action menu — this component holds no Shadow Chat logic beyond the
 * real-mode gate; tapping "Shadow chat" simply invokes {@link ShadowChatOverlayMenuProps.onShadowChat}.
 */

import { type AppMode } from '@chat-app/crypto';
import { type CSSProperties } from 'react';

import { OverlayPortal } from './OverlayPortal';

export interface ShadowChatOverlayMenuProps {
  /** Whether the menu is open. */
  open: boolean;
  /** The current resolved app mode (or `null` when locked / no PIN). Gates the shadow action. */
  mode: AppMode | null;
  /** A human label for the row the menu was opened on (contact name), shown as the menu title. */
  contextLabel: string;
  /** Close the menu without choosing an action. */
  onClose: () => void;
  /** Invoked when the user taps the (real-mode-only) "Shadow chat" action. */
  onShadowChat: () => void;
  /**
   * Invoked when the user taps the (real-mode-only) "Send shadow invite" action (Shadow Chat Invites,
   * Req 1.1): sends a consent-based invite to the contact, who receives an Accept/Decline card.
   * Optional, so existing call sites are unaffected; shown under the same real-mode gate.
   */
  onShadowInvite?: () => void;
}

/**
 * Test-only predicate (exported for the 15.3 adapter tests): whether the "Shadow chat" action is
 * present for a given mode. It is present iff the app is in real-PIN mode (Requirement 11.2, 11.5).
 */
export function isShadowActionVisible(mode: AppMode | null): boolean {
  return mode === 'real';
}

export function ShadowChatOverlayMenu({
  open,
  mode,
  contextLabel,
  onClose,
  onShadowChat,
  onShadowInvite,
}: ShadowChatOverlayMenuProps): JSX.Element {
  const showShadow = isShadowActionVisible(mode);
  return (
    <OverlayPortal open={open} onDismiss={onClose} ariaLabel={`Actions for ${contextLabel}`} placement="bottom">
      <div style={styles.container}>
        <div style={styles.title}>{contextLabel}</div>
        <ul style={styles.list} aria-label="Row actions">
          {/* Ordinary row actions (present in every mode) so the menu looks identical to a normal
              long-press menu in decoy / locked mode. */}
          <li>
            <button type="button" style={styles.action} onClick={onClose}>
              Mark as read
            </button>
          </li>
          <li>
            <button type="button" style={styles.action} onClick={onClose}>
              Mute notifications
            </button>
          </li>
          {showShadow && (
            <li>
              <button
                type="button"
                style={{ ...styles.action, ...styles.shadowAction }}
                onClick={onShadowChat}
              >
                Shadow chat
              </button>
            </li>
          )}
          {showShadow && onShadowInvite !== undefined && (
            <li>
              <button
                type="button"
                style={{ ...styles.action, ...styles.shadowAction }}
                onClick={onShadowInvite}
              >
                Send shadow invite
              </button>
            </li>
          )}
        </ul>
        <button type="button" style={styles.cancel} onClick={onClose}>
          Cancel
        </button>
      </div>
    </OverlayPortal>
  );
}

const styles: Record<string, CSSProperties> = {
  container: { padding: '8px 0 12px' },
  title: {
    padding: '12px 20px',
    fontSize: 13,
    fontWeight: 600,
    color: '#64748b',
    borderBottom: '1px solid #f1f5f9',
  },
  list: { listStyle: 'none', margin: 0, padding: 4 },
  action: {
    width: '100%',
    textAlign: 'left',
    padding: '14px 18px',
    background: 'transparent',
    border: 'none',
    fontSize: 16,
    color: '#0f172a',
    cursor: 'pointer',
    borderRadius: 10,
  },
  shadowAction: { color: '#4338ca', fontWeight: 600 },
  cancel: {
    margin: '6px 12px 0',
    width: 'calc(100% - 24px)',
    padding: '14px 18px',
    background: '#f1f5f9',
    border: 'none',
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 600,
    color: '#334155',
    cursor: 'pointer',
  },
};
