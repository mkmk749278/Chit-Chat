'use client';

/**
 * `ChatHomeScreen` — the web chat home that hosts the search bar, the long-pressable rows, and the
 * Shadow Chat overlays (Shadow Chat, task 15.2; Requirement 11).
 *
 * It is the web shell that makes the long-press creation flow + the typed-`/alias` re-entry flow
 * reachable end-to-end:
 *   - the {@link ChatSearchBar} submit is wired to {@link createWebShadowSearchHandler} with the
 *     per-chat-PIN re-entry seam from {@link useShadowReentryPin}, so typing a bound `/alias` opens
 *     its (PIN-gated) shadow thread, while a wrong/non-existent alias falls through to an ordinary
 *     search indistinguishably (Requirements 1.3–1.6, 12.2–12.4);
 *   - a press-and-hold on a chat-list row AND on a contact / new-chat row opens the top-layer
 *     {@link ShadowChatOverlayMenu} (via {@link useShadowChatCreation}), whose real-mode-only
 *     "Shadow chat" action opens the creation sheet that binds a new shadow thread (Requirement
 *     11.1–11.10).
 *
 * Selecting a row (or opening/creating a shadow thread) navigates to {@link RegistryConversation};
 * the created thread stays hidden from this home's chat list (it is never a surface conversation),
 * so it is re-enterable only via its `/alias` (Requirement 7.5, 11.10).
 */

import { useCallback, useMemo, useState, type CSSProperties } from 'react';

import {
  type AppMode,
  type ConversationKey,
  type ConversationRegistry,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import { type WebShadowSecretStore } from '../lib/shadow-secret-persistence';
import { createWebShadowSearchHandler } from '../lib/shadow-search';
import { ChatSearchBar } from './ChatSearchBar';
import { LongPressRow } from './LongPressRow';
import { RegistryConversation } from './RegistryConversation';
import { ShadowPinSettings } from './ShadowPinSettings';
import { useShadowChatCreation } from './useShadowChatCreation';
import { useShadowReentryPin } from './useShadowReentryPin';

/** A demo contact shown on the home screen (the web client has no live directory yet). */
export interface DemoContact {
  readonly uid: string;
  readonly name: string;
  readonly preview?: string;
}

export interface ChatHomeScreenProps {
  /** The signed-in user's UID (also their display label and the `myUid` for thread derivation). */
  myUid: string;
  /** The provisioned web shadow-secret store (its real-PIN-gated `ShadowSecretStore`). */
  shadowSecret: WebShadowSecretStore;
  /** The shared per-thread conversation registry. */
  registry: ConversationRegistry;
  /** Resolve the current app mode; gates the creation menu and alias resolution. */
  getMode: () => AppMode | null;
  /** Demo contacts to populate the chat-list and new-chat sections. */
  contacts: DemoContact[];
}

export function ChatHomeScreen({ myUid, shadowSecret, registry, getMode, contacts }: ChatHomeScreenProps): JSX.Element {
  const [active, setActive] = useState<ConversationKey | null>(null);
  const [lastSearch, setLastSearch] = useState<string | null>(null);
  // Whether the per-chat PIN settings overlay is open for the currently-open shadow thread (task 16.2).
  const [pinSettingsOpen, setPinSettingsOpen] = useState(false);

  const labelFor = useCallback(
    (peerUid: string): string => contacts.find((c) => c.uid === peerUid)?.name ?? peerUid,
    [contacts],
  );

  // The per-chat-PIN re-entry prompt + its verify seam.
  const reentryPin = useShadowReentryPin();

  // Open a (created or re-entered) shadow thread.
  const openShadowThread = useCallback((ref: ShadowThreadRef): void => {
    setActive({ kind: 'shadow', threadId: ref.threadId, peerUid: ref.peerUid });
  }, []);

  // The long-press creation flow (menu + sheet).
  const creation = useShadowChatCreation({
    store: shadowSecret.store,
    registry,
    getMode,
    myUid,
    onOpenShadowThread: openShadowThread,
  });

  // The search-bar submit handler (alias interception + re-entry PIN gate + ordinary search).
  const handleSearch = useMemo(
    () =>
      createWebShadowSearchHandler({
        store: shadowSecret.store,
        registry,
        getMode,
        onOpenShadowThread: openShadowThread,
        onOrdinarySearch: (query) => setLastSearch(query),
        requestPinAndVerify: reentryPin.requestPinAndVerify,
      }),
    [shadowSecret.store, registry, getMode, openShadowThread, reentryPin.requestPinAndVerify],
  );

  const onSubmitSearch = useCallback(
    (text: string): void => {
      void handleSearch(text);
    },
    [handleSearch],
  );

  if (active !== null) {
    const label = active.kind === 'shadow' ? labelFor(active.peerUid) : labelFor(active.remoteUid);
    // The per-chat PIN settings action is reachable ONLY from an open shadow thread and ONLY in real
    // mode — absent/inert otherwise so it cannot prove the shadow feature exists (Req 12.8).
    const canManagePin = active.kind === 'shadow' && getMode() === 'real';
    const closeOpen = (): void => {
      setPinSettingsOpen(false);
      setActive(null);
    };
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <div style={styles.openHeader}>
          <button type="button" style={styles.back} onClick={closeOpen} aria-label="Back to chats">
            ‹ Back
          </button>
          <span style={styles.openTitle}>{label}</span>
          {active.kind === 'shadow' && <span style={styles.hiddenBadge}>hidden</span>}
          {canManagePin && (
            <button
              type="button"
              style={{ ...styles.options, marginLeft: active.kind === 'shadow' ? 8 : 'auto' }}
              onClick={() => setPinSettingsOpen(true)}
              aria-label="Chat PIN settings"
              aria-haspopup="dialog"
            >
              PIN
            </button>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <RegistryConversation registry={registry} conversationKey={active} selfLabel={myUid} />
        </div>
        {active.kind === 'shadow' && (
          <ShadowPinSettings
            open={pinSettingsOpen}
            mode={getMode()}
            threadId={active.threadId}
            store={shadowSecret.store}
            onClose={() => setPinSettingsOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div style={styles.screen}>
      <header style={styles.header}>
        <h1 style={styles.appTitle}>Chats</h1>
      </header>
      <ChatSearchBar onSubmit={onSubmitSearch} placeholder="Search" />
      {lastSearch !== null && (
        <p style={styles.searchNote} role="status">
          No results for “{lastSearch}”.
        </p>
      )}

      <div style={styles.scroll}>
        <section aria-label="Chats">
          <h2 style={styles.sectionTitle}>Chats</h2>
          {contacts.map((c) => (
            <LongPressRow
              key={`chat-${c.uid}`}
              title={c.name}
              subtitle={c.preview ?? 'Tap to open · press and hold for options'}
              variant="chat"
              onOpen={() => setActive({ kind: 'surface', remoteUid: c.uid })}
              onLongPress={() => creation.openMenuFor({ peerUid: c.uid, label: c.name })}
            />
          ))}
        </section>

        <section aria-label="New chat">
          <h2 style={styles.sectionTitle}>New chat</h2>
          {contacts.map((c) => (
            <LongPressRow
              key={`contact-${c.uid}`}
              title={c.name}
              subtitle="Start a new chat · press and hold for options"
              variant="contact"
              onOpen={() => setActive({ kind: 'surface', remoteUid: c.uid })}
              onLongPress={() => creation.openMenuFor({ peerUid: c.uid, label: c.name })}
            />
          ))}
        </section>
      </div>

      {/* Top-layer overlays (rendered through portals): long-press menu + creation sheet, and the
          per-chat-PIN re-entry prompt. */}
      {creation.element}
      {reentryPin.element}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  screen: { display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 640, margin: '0 auto' },
  header: { padding: '12px 16px', borderBottom: '1px solid #e2e8f0' },
  appTitle: { margin: 0, fontSize: 20, color: '#0f172a' },
  scroll: { flex: 1, overflowY: 'auto' },
  sectionTitle: {
    margin: 0,
    padding: '14px 16px 6px',
    fontSize: 12,
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    color: '#94a3b8',
  },
  searchNote: { margin: 0, padding: '8px 16px', fontSize: 13, color: '#64748b' },
  openHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    borderBottom: '1px solid #e2e8f0',
  },
  back: { background: 'transparent', border: 'none', fontSize: 16, color: '#2563eb', cursor: 'pointer' },
  options: {
    background: '#ede9fe',
    border: '1px solid #ddd6fe',
    borderRadius: 8,
    padding: '4px 10px',
    fontSize: 12,
    fontWeight: 700,
    color: '#6d28d9',
    cursor: 'pointer',
  },
  openTitle: { fontWeight: 600, color: '#0f172a' },
  hiddenBadge: {
    marginLeft: 'auto',
    fontSize: 11,
    fontWeight: 700,
    color: '#6d28d9',
    background: '#ede9fe',
    borderRadius: 999,
    padding: '2px 8px',
  },
};
