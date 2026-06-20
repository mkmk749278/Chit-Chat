'use client';

/**
 * `useLongPress` — a press-and-hold gesture hook for the Shadow Chat long-press creation flow
 * (Shadow Chat, task 15.2; Requirement 11.1).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Creating a shadow chat from a long-press"
 * and `requirements.md` → Requirement 11.1 ("a press-and-hold (long-press) gesture on a chat-list
 * row or a contact / new-chat row"). This is the WEB equivalent of the mobile row's
 * `onLongPress` (React Native exposes it natively; the web has no built-in long-press, so we derive
 * it from pointer events + a hold timer).
 *
 * Behaviour: a pointer/touch press that is held for at least `delayMs` (default 500 ms) WITHOUT
 * moving beyond a small slop radius or being released fires `onLongPress` exactly once for that
 * press. A normal click (press + quick release) does NOT fire it — it cancels the pending timer — so
 * the row's ordinary tap/open behaviour is preserved. The native context menu is suppressed on the
 * row so a desktop right-click / touch-and-hold does not pop the browser menu over our overlay.
 *
 * Pure of any Shadow Chat logic: it only detects the gesture and invokes the injected callback. It
 * holds no Shadow state and performs no I/O, so it is reusable for both the chat-list row and the
 * contact / new-chat row (Requirement 11.1).
 */

import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/** Options for {@link useLongPress}. */
export interface UseLongPressOptions {
  /** Hold duration, in milliseconds, before the long-press fires. Defaults to 500 ms. */
  delayMs?: number;
  /**
   * Movement tolerance, in CSS pixels, before a press is treated as a drag/scroll and cancelled.
   * Defaults to 10 px so a small finger jitter still counts as a hold.
   */
  moveSlopPx?: number;
}

/** The set of handlers returned by {@link useLongPress}, spread onto the target element. */
export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerLeave: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onContextMenu: (event: { preventDefault: () => void }) => void;
}

const DEFAULT_DELAY_MS = 500;
const DEFAULT_MOVE_SLOP_PX = 10;

/**
 * Returns pointer/touch handlers that fire `onLongPress` after a stationary press-and-hold. Spread
 * the returned object onto any focusable/pressable element (e.g. a chat-list row).
 */
export function useLongPress(
  onLongPress: () => void,
  options: UseLongPressOptions = {},
): LongPressHandlers {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const moveSlopPx = options.moveSlopPx ?? DEFAULT_MOVE_SLOP_PX;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  // Latest callback held in a ref so the handlers stay referentially stable across renders.
  const callbackRef = useRef(onLongPress);
  callbackRef.current = onLongPress;

  const clear = useCallback((): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    originRef.current = null;
  }, []);

  // Defensively clear any pending timer if the component unmounts mid-press.
  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent): void => {
      // Only react to the primary button / a touch or pen contact, never a secondary mouse button.
      if (event.button !== undefined && event.button !== 0) {
        return;
      }
      clear();
      originRef.current = { x: event.clientX, y: event.clientY };
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        originRef.current = null;
        callbackRef.current();
      }, delayMs);
    },
    [clear, delayMs],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent): void => {
      const origin = originRef.current;
      if (origin === null) {
        return;
      }
      const dx = event.clientX - origin.x;
      const dy = event.clientY - origin.y;
      if (dx * dx + dy * dy > moveSlopPx * moveSlopPx) {
        // The press turned into a drag/scroll — cancel the pending long-press.
        clear();
      }
    },
    [clear, moveSlopPx],
  );

  const onContextMenu = useCallback((event: { preventDefault: () => void }): void => {
    // Suppress the browser's native context menu so our top-layer overlay owns the interaction.
    event.preventDefault();
  }, []);

  return {
    onPointerDown,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onPointerMove,
    onContextMenu,
  };
}
