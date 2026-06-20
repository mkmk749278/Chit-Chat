/**
 * Disappearing-message timer presets + labelling (shared by the conversation timer sheet and the
 * Contact/Profile screen so both show identical options/labels). Pure, no React.
 */

/** Disappearing-timer presets, label → milliseconds (`0` = off). */
export const TIMER_PRESETS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: 'Off', ms: 0 },
  { label: '30 seconds', ms: 30_000 },
  { label: '5 minutes', ms: 5 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: '1 day', ms: 24 * 60 * 60_000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60_000 },
];

/** Human label for an active timer (matches a preset, else a coarse fallback). */
export function timerLabel(ttlMs: number): string {
  if (ttlMs <= 0) {
    return 'Off';
  }
  return TIMER_PRESETS.find((p) => p.ms === ttlMs)?.label ?? `${Math.round(ttlMs / 1000)}s`;
}
