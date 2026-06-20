'use client';

/**
 * `ShadowInviteRequestCard` — the web Accept / Decline request card for an inbound shadow-chat invite
 * (Shadow Chat Invites, design Component A; Req 1.3, 3.1). Rendered in the recipient's MAIN chat when
 * a `shadow-invite` arrives in real mode. Accept reveals the routing choice — `hidden` (default) or
 * `merge` — then resolves with the chosen routing; Decline persists no shadow data. The container
 * mounts it from the `invite-received` event and unmounts it on `invite-resolved`, so no residue
 * remains. Pure presentation; gating + lifecycle live in the container.
 */

import { type CSSProperties, useState } from 'react';

import { type RecipientRouting } from '@chat-app/crypto';

import { DEFAULT_RECIPIENT_ROUTING, ROUTING_OPTIONS } from '../lib/shadow-invite-actions';

export interface ShadowInviteRequestCardProps {
  /** Inviter display name (or UID) shown on the card. */
  peerName: string;
  /** Optional human-readable thread label (blank by default for deniability). */
  label?: string;
  /** Accept the invite with the chosen routing (stays local to this device). */
  onAccept: (routing: RecipientRouting) => void;
  /** Decline the invite (persists no shadow data). */
  onDecline: () => void;
}

/** Two-step card: ask → (Accept) choose routing | (Decline). */
export function ShadowInviteRequestCard({
  peerName,
  label,
  onAccept,
  onDecline,
}: ShadowInviteRequestCardProps): JSX.Element {
  const [choosingRouting, setChoosingRouting] = useState(false);

  return (
    <section style={styles.card} aria-label="Shadow chat invite">
      <div style={styles.title}>Shadow chat invite</div>
      <p style={styles.subtitle}>
        {peerName}
        {label !== undefined && label.length > 0 ? ` · ${label}` : ''} wants to start a private shadow
        chat with you.
      </p>

      {!choosingRouting ? (
        <div style={styles.row}>
          <button type="button" style={styles.accept} onClick={() => setChoosingRouting(true)}>
            Accept
          </button>
          <button type="button" style={styles.decline} onClick={onDecline}>
            Decline
          </button>
        </div>
      ) : (
        <fieldset style={styles.routing}>
          <legend style={styles.legend}>Where should this chat appear?</legend>
          {ROUTING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              style={styles.routingOption}
              onClick={() => {
                setChoosingRouting(false);
                onAccept(option.value);
              }}
            >
              <span style={styles.routingLabel}>
                {option.label}
                {option.value === DEFAULT_RECIPIENT_ROUTING ? ' (recommended)' : ''}
              </span>
              <span style={styles.routingDesc}>{option.description}</span>
            </button>
          ))}
          <button type="button" style={styles.back} onClick={() => setChoosingRouting(false)}>
            Back
          </button>
        </fieldset>
      )}
    </section>
  );
}

const styles: Record<string, CSSProperties> = {
  card: { margin: '8px 12px', padding: 16, background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 14 },
  title: { fontSize: 14, fontWeight: 700, color: '#3730a3' },
  subtitle: { margin: '4px 0 12px', fontSize: 13, color: '#475569' },
  row: { display: 'flex', gap: 10 },
  accept: { flex: 1, padding: '10px 14px', background: '#4338ca', color: '#fff', border: 'none', borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  decline: { flex: 1, padding: '10px 14px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  routing: { border: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  legend: { fontSize: 13, color: '#475569', padding: 0, marginBottom: 4 },
  routingOption: { textAlign: 'left', padding: '10px 12px', background: '#fff', border: '1px solid #c7d2fe', borderRadius: 10, cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 2 },
  routingLabel: { fontSize: 15, fontWeight: 600, color: '#0f172a' },
  routingDesc: { fontSize: 12, color: '#64748b' },
  back: { alignSelf: 'flex-start', padding: '6px 10px', background: 'transparent', border: 'none', color: '#4338ca', fontSize: 14, cursor: 'pointer' },
};
