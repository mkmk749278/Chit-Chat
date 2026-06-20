'use client';

/**
 * `useShadowReentryPin` — wires the {@link ShadowReentryPinPrompt} to the search handler's per-chat
 * PIN seam (Shadow Chat, task 15.2; Requirements 12.2, 12.3, 12.4, 12.7).
 *
 * It exposes a single promise-returning function, `requestPinAndVerify(ref)`, shaped exactly to the
 * `WebShadowSearchDeps.requestPinAndVerify` seam of {@link createWebShadowSearchHandler}: when the
 * shared search handler matches a PIN-protected thread it calls this function, which opens the
 * prompt, collects the PIN, verifies it OFF the main work via {@link verifyWebPin} (a spinner / a
 * disabled submit while the async `verifySecret` is in flight), and resolves `true` once verified or
 * `false` when cancelled. A wrong PIN keeps the prompt open with a GENERIC failure message
 * (Requirement 12.4) so the user can retry; cancelling resolves `false` and opens nothing.
 *
 * The hook returns the prompt element to render and the seam function to pass into the handler.
 */

import { useCallback, useRef, useState } from 'react';

import { type ShadowThreadRef } from '@chat-app/crypto';

import { verifyWebPin } from '../lib/shadow-search';
import { ShadowReentryPinPrompt } from './ShadowReentryPinPrompt';

interface PendingPrompt {
  readonly verifier: string;
  readonly resolve: (verified: boolean) => void;
}

export interface UseShadowReentryPin {
  /** The {@link WebShadowSearchDeps.requestPinAndVerify} seam: prompt + off-thread verify. */
  requestPinAndVerify: (ref: ShadowThreadRef) => Promise<boolean>;
  /** The prompt element to render in the tree (a top-layer portal; placement-agnostic). */
  element: JSX.Element;
}

const GENERIC_FAILURE = 'Incorrect PIN.';

export function useShadowReentryPin(): UseShadowReentryPin {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingPrompt | null>(null);

  const settle = useCallback((verified: boolean): void => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    setBusy(false);
    setError(null);
    pending?.resolve(verified);
  }, []);

  const requestPinAndVerify = useCallback((ref: ShadowThreadRef): Promise<boolean> => {
    // A thread without a verifier should never reach here, but fail closed if it does.
    if (ref.pinVerifier === undefined || ref.pinVerifier === '') {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      pendingRef.current = { verifier: ref.pinVerifier as string, resolve };
      setError(null);
      setBusy(false);
      setOpen(true);
    });
  }, []);

  const onSubmit = useCallback(
    async (pin: string): Promise<void> => {
      const pending = pendingRef.current;
      if (pending === null) {
        return;
      }
      setBusy(true);
      setError(null);
      const verified = await verifyWebPin(pin, pending.verifier);
      if (verified) {
        settle(true); // correct PIN → resolve true; the handler opens the thread.
        return;
      }
      // Wrong PIN: keep the prompt open with a generic failure so retry is possible (Req 12.4).
      setBusy(false);
      setError(GENERIC_FAILURE);
    },
    [settle],
  );

  const onCancel = useCallback((): void => {
    settle(false);
  }, [settle]);

  const element = (
    <ShadowReentryPinPrompt open={open} busy={busy} error={error} onSubmit={onSubmit} onCancel={onCancel} />
  );

  return { requestPinAndVerify, element };
}
