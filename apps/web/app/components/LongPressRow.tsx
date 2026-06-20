'use client';

/**
 * `LongPressRow` — a chat-list / contact row that supports both a tap (open) and a press-and-hold
 * (open the long-press action menu) (Shadow Chat, task 15.2; Requirement 11.1).
 *
 * One presentational row reused for BOTH required surfaces — the chat-list row and the contact /
 * new-chat row (distinguished by {@link LongPressRowProps.variant}) — so a long-press is available
 * on each, exactly as Requirement 11.1 specifies. The press-and-hold gesture is provided by
 * {@link useLongPress}; the menu it opens is the top-layer overlay from `useShadowChatCreation`. The
 * row itself holds no Shadow Chat logic: it forwards a tap to `onOpen` and a hold to `onLongPress`.
 */

import { type CSSProperties } from 'react';

import { useLongPress } from './useLongPress';

export interface LongPressRowProps {
  /** Primary line (contact name). */
  title: string;
  /** Secondary line (last-message preview for a chat row, or a hint for a contact row). */
  subtitle?: string;
  /** Which surface this row belongs to — affects only the affordance styling. */
  variant: 'chat' | 'contact';
  /** Tap/click handler (open the conversation, or start a new chat). */
  onOpen: () => void;
  /** Press-and-hold handler (open the long-press action menu). */
  onLongPress: () => void;
}

export function LongPressRow({ title, subtitle, variant, onOpen, onLongPress }: LongPressRowProps): JSX.Element {
  const longPress = useLongPress(onLongPress);
  const initial = title.trim().charAt(0).toUpperCase() || '?';

  return (
    <button
      type="button"
      style={styles.row}
      onClick={onOpen}
      {...longPress}
      aria-label={variant === 'contact' ? `Start chat with ${title}` : `Open chat with ${title}`}
    >
      <span style={{ ...styles.avatar, background: variant === 'contact' ? '#e0e7ff' : '#dbeafe' }}>{initial}</span>
      <span style={styles.text}>
        <span style={styles.title}>{title}</span>
        {subtitle !== undefined && <span style={styles.subtitle}>{subtitle}</span>}
      </span>
    </button>
  );
}

const styles: Record<string, CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    padding: '12px 16px',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid #f1f5f9',
    cursor: 'pointer',
    textAlign: 'left',
    // Prevent the browser's text-selection / callout on a touch-and-hold so our long-press owns it.
    userSelect: 'none',
    WebkitUserSelect: 'none',
    touchAction: 'manipulation',
  },
  avatar: {
    flex: '0 0 auto',
    width: 40,
    height: 40,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    color: '#1e293b',
  },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  title: { fontSize: 15, fontWeight: 600, color: '#0f172a' },
  subtitle: { fontSize: 13, color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
};
