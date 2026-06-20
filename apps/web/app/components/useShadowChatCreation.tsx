'use client';

/**
 * `useShadowChatCreation` — orchestrates the long-press creation flow (Shadow Chat, task 15.2;
 * Requirement 11).
 *
 * It ties the long-press {@link ShadowChatOverlayMenu} to the {@link ShadowChatCreationSheet} and to
 * the binding orchestration {@link bindWebShadowChat}. A row's long-press calls `openMenuFor(peer)`;
 * the menu shows the real-mode-only "Shadow chat" action (Requirement 11.2, 11.5); choosing it opens
 * the creation sheet (alias + optional PIN, Requirement 11.3, 11.6); confirming binds the alias to a
 * fresh alias-discriminated shadow thread, opens it in the registry, navigates to it, and dismisses
 * (Requirement 11.4, 11.10). The whole flow never sends and never mutates surface state
 * (Requirement 11.7, 11.8) — it only writes the device-local hash-only `AliasEntry` and opens the
 * hidden thread.
 *
 * Returns the imperative `openMenuFor` to wire onto each long-pressable row, plus the overlay
 * elements (menu + sheet) to render in the tree.
 */

import { useCallback, useState } from 'react';

import { type AppMode, type ShadowThreadRef } from '@chat-app/crypto';

import { bindWebShadowChat, type WebShadowCreationDeps } from '../lib/shadow-search';
import { ShadowChatCreationSheet } from './ShadowChatCreationSheet';
import { ShadowChatOverlayMenu } from './ShadowChatOverlayMenu';

/** A row the long-press menu was opened on. */
export interface ShadowCreationTarget {
  /** The contact's UID the (potential) shadow chat is with. */
  readonly peerUid: string;
  /** A human label for the contact, shown in the menu/sheet. */
  readonly label: string;
}

export interface UseShadowChatCreationDeps extends Omit<WebShadowCreationDeps, 'onOpenShadowThread'> {
  /** The current resolved app mode (or `null`); read live so the menu gates correctly each open. */
  readonly getMode: () => AppMode | null;
  /** Navigate to the newly created (and opened) shadow thread. */
  readonly onOpenShadowThread: (ref: ShadowThreadRef) => void;
}

export interface UseShadowChatCreation {
  /** Open the long-press action menu for a given row/contact. */
  openMenuFor: (target: ShadowCreationTarget) => void;
  /** The overlay elements (menu + creation sheet) to render. */
  element: JSX.Element;
}

type Phase = 'closed' | 'menu' | 'sheet';

export function useShadowChatCreation(deps: UseShadowChatCreationDeps): UseShadowChatCreation {
  const [phase, setPhase] = useState<Phase>('closed');
  const [target, setTarget] = useState<ShadowCreationTarget | null>(null);
  // Snapshot the mode at menu-open time so the menu's gating is stable for that interaction.
  const [menuMode, setMenuMode] = useState<AppMode | null>(null);

  const openMenuFor = useCallback(
    (next: ShadowCreationTarget): void => {
      setTarget(next);
      setMenuMode(deps.getMode());
      setPhase('menu');
    },
    [deps],
  );

  const close = useCallback((): void => {
    setPhase('closed');
    setTarget(null);
  }, []);

  const onShadowChat = useCallback((): void => {
    setPhase('sheet');
  }, []);

  const onConfirm = useCallback(
    async (alias: string, pin: string | undefined): Promise<void> => {
      if (target === null) {
        return;
      }
      const ref = await bindWebShadowChat(
        {
          store: deps.store,
          registry: deps.registry,
          getMode: deps.getMode,
          myUid: deps.myUid,
          onOpenShadowThread: deps.onOpenShadowThread,
        },
        target.peerUid,
        alias,
        pin,
      );
      // A null ref means non-real mode (nothing bound). The sheet only reaches confirm in real mode,
      // but stay defensive: dismiss either way (no surface mutation occurred).
      void ref;
      close();
    },
    [target, deps, close],
  );

  const contextLabel = target?.label ?? '';

  const element = (
    <>
      <ShadowChatOverlayMenu
        open={phase === 'menu'}
        mode={menuMode}
        contextLabel={contextLabel}
        onClose={close}
        onShadowChat={onShadowChat}
      />
      <ShadowChatCreationSheet
        open={phase === 'sheet'}
        contactLabel={contextLabel}
        onCancel={close}
        onConfirm={onConfirm}
      />
    </>
  );

  return { openMenuFor, element };
}
