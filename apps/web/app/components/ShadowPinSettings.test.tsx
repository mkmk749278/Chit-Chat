import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { type AliasEntry, type AppMode, type ShadowSecretStore } from '@chat-app/crypto';

import { ShadowPinSettings } from './ShadowPinSettings';
import type { ShadowThreadRef } from '@chat-app/crypto';

/**
 * Behavioural tests for the WEB per-chat PIN settings overlay `ShadowPinSettings` (task 16.3;
 * Requirements 12.5, 12.7, 12.8; design Correctness Property 11 & Property 13).
 *
 * These render the REAL component into jsdom and drive it through its public contract:
 *   - Property 13 (decoy reveals nothing): the overlay renders ONLY when `mode === 'real'`; in
 *     `decoy` / `null` it is ABSENT and inert — no dialog mounts at all.
 *   - Property 11 (PIN add/change/remove via one shared-core write): typing a non-empty PIN and
 *     saving calls `store.setThreadPin(mode, threadId, <pin>)`; the Remove action calls
 *     `store.setThreadPin(mode, threadId, null)`.
 *   - Requirement 12.7 (off the UI thread, no freeze): while the async `setThreadPin` is pending the
 *     submit/remove controls are DISABLED and an in-flight label ("Saving…") is shown.
 *
 * The component depends only on a duck-typed `ShadowSecretStore` (it spies on `setThreadPin` /
 * `listAliasEntries`), so a fake store is sufficient — no real crypto/persistence is exercised.
 */

// React's `act` requires this flag to be set in a non-browser test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODE: AppMode = 'real';
const THREAD_ID = 'a'.repeat(64);


interface FakeStore {
  store: ShadowSecretStore;
  setThreadPin: ReturnType<typeof vi.fn>;
  listAliasEntries: ReturnType<typeof vi.fn>;
}

/**
 * Build a fake `ShadowSecretStore` exposing only the two methods this component touches. When
 * `hasPin` is true, `listAliasEntries` returns an entry for THREAD_ID carrying a `pinVerifier`, so
 * the overlay surfaces the Remove action. `setThreadPinImpl` controls the timing of the async write
 * (default: resolves immediately to a ref).
 */
function makeFakeStore(opts: {
  hasPin?: boolean;
  setThreadPinImpl?: (mode: unknown, threadId: string, pin: string | null) => Promise<unknown>;
}): FakeStore {
  const entries: AliasEntry<ShadowThreadRef>[] = opts.hasPin
    ? [{ aliasHash: 'h', ref: { peerUid: 'bob', threadId: THREAD_ID, pinVerifier: 'v1$verifier' } }]
    : [];
  const listAliasEntries = vi.fn(async () => entries);
  const setThreadPin = vi.fn(
    opts.setThreadPinImpl ??
      (async (_mode: unknown, threadId: string) => ({ peerUid: 'bob', threadId })),
  );
  const store = { setThreadPin, listAliasEntries } as unknown as ShadowSecretStore;
  return { store, setThreadPin, listAliasEntries };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  vi.clearAllMocks();
});

/** Render (or re-render) the overlay and flush effects/microtasks. */
async function render(props: {
  open: boolean;
  mode: AppMode | null;
  store: ShadowSecretStore;
  onClose?: () => void;
}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ShadowPinSettings, {
        open: props.open,
        mode: props.mode,
        threadId: THREAD_ID,
        store: props.store,
        onClose: props.onClose ?? (() => undefined),
      }),
    );
  });
}

/** The portal mounts into document.body; query the dialog surface there. */
function dialog(): HTMLElement | null {
  return document.body.querySelector('[role="dialog"]');
}

function buttonByText(text: string): HTMLButtonElement | null {
  const buttons = Array.from(document.body.querySelectorAll('button'));
  return (buttons.find((b) => b.textContent?.trim() === text) as HTMLButtonElement) ?? null;
}

/** Set a controlled input's value the way React expects (native setter + input event). */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}


describe('Property 13 — the overlay renders ONLY in real mode (decoy/null reveal nothing)', () => {
  test('mode === "real" mounts the dialog', async () => {
    const { store } = makeFakeStore({});
    await render({ open: true, mode: 'real', store });
    expect(dialog()).not.toBeNull();
  });

  test('mode === "decoy" renders NOTHING — the overlay is absent and inert', async () => {
    const fake = makeFakeStore({});
    await render({ open: true, mode: 'decoy', store: fake.store });
    expect(dialog()).toBeNull();
    // The real-mode-gated read never even runs in decoy mode.
    expect(fake.listAliasEntries).not.toHaveBeenCalled();
  });

  test('mode === null renders NOTHING (same observable result as decoy)', async () => {
    const fake = makeFakeStore({});
    await render({ open: true, mode: null, store: fake.store });
    expect(dialog()).toBeNull();
    expect(fake.listAliasEntries).not.toHaveBeenCalled();
  });

  test('open === false renders nothing even in real mode', async () => {
    const fake = makeFakeStore({});
    await render({ open: false, mode: 'real', store: fake.store });
    expect(dialog()).toBeNull();
  });
});

describe('Property 11 — add/change and remove route through the single setThreadPin write', () => {
  test('typing a non-empty PIN + Save calls setThreadPin(mode, threadId, <pin>)', async () => {
    const fake = makeFakeStore({});
    const onClose = vi.fn();
    await render({ open: true, mode: MODE, store: fake.store, onClose });

    const input = document.body.querySelector('#shadow-pin-settings') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => {
      typeInto(input, '  1357  ');
    });

    const form = document.body.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // The trimmed PIN is forwarded through the one shared-core write, then the overlay dismisses.
    expect(fake.setThreadPin).toHaveBeenCalledTimes(1);
    expect(fake.setThreadPin).toHaveBeenCalledWith(MODE, THREAD_ID, '1357');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('an all-whitespace PIN never triggers a write (Save stays inert)', async () => {
    const fake = makeFakeStore({});
    await render({ open: true, mode: MODE, store: fake.store });
    const input = document.body.querySelector('#shadow-pin-settings') as HTMLInputElement;
    await act(async () => {
      typeInto(input, '   ');
    });
    const form = document.body.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(fake.setThreadPin).not.toHaveBeenCalled();
  });

  test('the Remove action calls setThreadPin(mode, threadId, null)', async () => {
    const fake = makeFakeStore({ hasPin: true });
    const onClose = vi.fn();
    await render({ open: true, mode: MODE, store: fake.store, onClose });

    // Remove only appears once the existing-PIN state has loaded from listAliasEntries.
    const remove = buttonByText('Remove PIN');
    expect(remove).not.toBeNull();
    await act(async () => {
      remove?.click();
    });

    expect(fake.setThreadPin).toHaveBeenCalledTimes(1);
    expect(fake.setThreadPin).toHaveBeenCalledWith(MODE, THREAD_ID, null);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('the Remove action is ABSENT when the thread has no PIN yet', async () => {
    const fake = makeFakeStore({ hasPin: false });
    await render({ open: true, mode: MODE, store: fake.store });
    expect(buttonByText('Remove PIN')).toBeNull();
  });
});


describe('Requirement 12.7 — the write runs off the UI thread; controls gate while in flight', () => {
  test('while setThreadPin is pending the Save control is disabled and shows an in-flight label', async () => {
    // A deferred promise lets us observe the in-flight state before the write resolves.
    let resolveWrite: ((ref: unknown) => void) | undefined;
    const pending = new Promise<unknown>((resolve) => {
      resolveWrite = resolve;
    });
    const fake = makeFakeStore({ setThreadPinImpl: () => pending });
    const onClose = vi.fn();
    await render({ open: true, mode: MODE, store: fake.store, onClose });

    const input = document.body.querySelector('#shadow-pin-settings') as HTMLInputElement;
    await act(async () => {
      typeInto(input, '2468');
    });
    const form = document.body.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // The write was launched but has NOT resolved: the overlay stays open, the submit control is
    // disabled, and it shows the in-flight "Saving…" label — the UI never froze waiting on PBKDF2.
    expect(fake.setThreadPin).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    const saving = buttonByText('Saving…');
    expect(saving).not.toBeNull();
    expect(saving?.disabled).toBe(true);
    expect(input.disabled).toBe(true);

    // Resolving the deferred write completes the operation and dismisses the overlay.
    await act(async () => {
      resolveWrite?.({ peerUid: 'bob', threadId: THREAD_ID });
      await pending;
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
