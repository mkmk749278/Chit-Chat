/**
 * Lumin Chat — mobile app shell (design/mockups; Phase 1 Client Component 7: UI).
 *
 * Container that composes the Lumin shell (UX directive: Chats / Calls / Settings) around
 * the shared crypto core. Navigation is state-driven (see TabBar.tsx for why React
 * Navigation is deliberately not used at this size): an auth gate shows `SignInScreen`,
 * then a one-time onboarding step (display name + optional PIN), then the tab shell;
 * opening a chat or "new chat" pushes the corresponding screen over it.
 *
 * Each conversation owns a `ConversationState` driven by the shared `reduce` from
 * `@chat-app/crypto` (one render path across web and mobile, Requirement 6.7). User
 * intent routes through the injected {@link ChatController}; controller events feed the
 * OPEN conversation's reducer. The controller is the seam where the real Messaging +
 * libsignal engine wiring lands without touching these screens.
 */

import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  initialConversationState,
  reduce,
  createConversationRegistry,
  verifySecret,
  type ConversationRegistry,
  type ConversationState,
  type MessageTarget,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import {
  createMobileController,
  type ChatController,
  type SetupState,
} from './src/app/chat-controller';
import { createMobileShadowSearchHandler } from './src/app/shadow-search';
import { CallsScreen } from './src/ui/CallsScreen';
import { ChatsListScreen, type ChatSummary } from './src/ui/ChatsListScreen';
import { AppLockScreen } from './src/ui/AppLockScreen';
import { ConversationScreen } from './src/ui/ConversationScreen';
import { animateNext } from './src/ui/motion';
import { NewChatScreen, type ContactRow } from './src/ui/NewChatScreen';
import { OnboardingScreen } from './src/ui/OnboardingScreen';
import { RowActionMenu } from './src/ui/RowActionMenu';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { ShadowChatCreateSheet } from './src/ui/ShadowChatCreateSheet';
import { ShadowPinPrompt } from './src/ui/ShadowPinPrompt';
import { SignInScreen } from './src/ui/SignInScreen';
import { TabBar, type Tab } from './src/ui/TabBar';
import { useTheme } from './src/ui/theme';

/** One chat thread: peer identity + its reducer-owned conversation state. */
interface Conversation {
  id: string;
  name: string;
  state: ConversationState;
  /** Unix ms of the last activity, for list ordering and the time label. */
  lastAt: number;
}

/** Short list-row time label ("9:32" today, weekday otherwise). */
function timeLabel(unixMs: number): string {
  const then = new Date(unixMs);
  const now = new Date();
  if (then.toDateString() === now.toDateString()) {
    return `${then.getHours()}:${String(then.getMinutes()).padStart(2, '0')}`;
  }
  return then.toLocaleDateString(undefined, { weekday: 'short' });
}

/** Derive the chat-list preview line from a conversation's last message. */
function previewOf(state: ConversationState): string {
  const last = state.messages[state.messages.length - 1];
  if (last === undefined) {
    return 'Say hello 👋';
  }
  if (last.direction === 'out') {
    const text = last.text ?? '';
    return last.status === 'failed' ? `You: ⚠ ${text}` : `You: ${text}`;
  }
  return '🔒 Encrypted message';
}

function AppShell(): React.JSX.Element {
  const controllerRef = useRef<ChatController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createMobileController();
  }
  const controller = controllerRef.current;
  const dark = useColorScheme() === 'dark';
  const theme = useTheme();

  // Shadow Chat. The per-thread conversation registry is created once per mount (stable ref) and is
  // the canonical isolator (shadow threads never enter `listSurfaceConversations` / `isNotifiable`).
  // The real-PIN-gated alias resolver + creation binding go through the controller's DURABLE
  // `ShadowSecretStore` (`getShadowSecretStore()`), backed by the encrypted SQLCipher vault, so a
  // shadow chat created via the long-press flow survives restarts and a later `/alias` re-resolves
  // to the same thread (Requirements 9.8, 9.9, 11.6). Until the store is open (setup running) or no
  // alias is bound yet, every `/alias` falls through to an ordinary search, indistinguishably
  // (Req 1.5, 8.6).
  const shadowRegistryRef = useRef<ConversationRegistry | null>(null);
  if (shadowRegistryRef.current === null) {
    shadowRegistryRef.current = createConversationRegistry({ platform: 'mobile' });
  }
  // Open shadow threads: threadId -> peer uid. A shadow message targets the peer with this threadId
  // so it rides the shadow thread (never the surface chat). These ids are EXCLUDED from the chat
  // list / contacts (task 8.3, Req 7.5/7.6).
  const shadowPeerRef = useRef<Map<string, string>>(new Map());
  const [shadowThreadIds, setShadowThreadIds] = useState<ReadonlySet<string>>(new Set());

  // Long-press shadow-chat creation flow (Shadow Chat, task 15.1, Requirement 11). `rowMenu` is the
  // row whose long-press overlay is open; `createSheet` is the contact a shadow chat is being created
  // for; `pinPrompt` bridges the search handler's off-thread PIN re-entry verification to the modal
  // prompt (resolving the handler's promise once the user verifies or cancels).
  const [rowMenu, setRowMenu] = useState<{ id: string; name: string; kind: 'chat' | 'contact' } | null>(
    null,
  );
  const [createSheet, setCreateSheet] = useState<{ peerUid: string; name: string } | null>(null);
  const [pinPrompt, setPinPrompt] = useState<{
    verify: (pin: string) => Promise<boolean>;
    resolve: (opened: boolean) => void;
  } | null>(null);

  const [uid, setUid] = useState<string | null>(null);
  const [phone, setPhone] = useState<string>('');
  // Onboarding result (UX directive: phone → display name → optional PIN). v1 holds these
  // in-session; durable profile/PIN storage lands with the backend wiring pass.
  const [displayName, setDisplayName] = useState<string | null>(null);
  // App-lock / decoy-PIN state (Signature Feature 4, §6). `appMode` is `null` while the app is
  // locked (a real PIN is set but not yet entered); `real` opens the full app, `decoy` opens the
  // sanitised state (hidden chats stay hidden, hiding is disabled). Resolved via the secure-gate.
  const [appMode, setAppMode] = useState<'real' | 'decoy' | null>(null);
  const [lockKnown, setLockKnown] = useState(false); // whether we've checked if a PIN is set
  const [lockError, setLockError] = useState<string | null>(null);
  const [lockLocked, setLockLocked] = useState(false);
  // Whether a real / decoy PIN is configured (reflected in Settings, Signature Feature 4).
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [decoyEnabled, setDecoyEnabled] = useState(false);
  // Peer uids of hidden chats (Signature Feature 1, §3); excluded from the list + search.
  const [hiddenPeers, setHiddenPeers] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>('chats');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupState>({ phase: 'idle' });
  // The subscription callback below must see the CURRENT open chat, not the one captured
  // when the controller was subscribed.
  const openChatRef = useRef<string | null>(null);
  openChatRef.current = openChatId;

  // Peers we've already kicked off a display-name lookup for, so an inbound stream doesn't
  // refetch on every message. A ref (not state) because it's read/written inside the
  // controller subscription closure.
  const peerNameResolvedRef = useRef<Set<string>>(new Set());

  // Resolve a peer's display name from their UID and patch the conversation's name — but only
  // while it's still showing the raw UID, so a name the user already chose (via New-chat) or a
  // later rename is never clobbered. Best-effort: a miss/offline leaves the UID in place.
  const ensurePeerName = useCallback(
    (peerUid: string) => {
      if (peerNameResolvedRef.current.has(peerUid)) {
        return;
      }
      peerNameResolvedRef.current.add(peerUid);
      void controller.resolvePeerName(peerUid).then((name) => {
        if (name === null || name.length === 0) {
          return;
        }
        setConversations((prev) =>
          prev.map((c) => (c.id === peerUid && c.name === peerUid ? { ...c, name } : c)),
        );
      });
    },
    [controller],
  );

  // Controller events drive the right conversation's reducer. Events carry the peer
  // (`remoteUid`) so inbound messages route to their own chat — and a message from someone
  // new auto-creates a chat. `connection-changed` is global and applies to every chat.
  useEffect(
    () =>
      controller.subscribe((event) => {
        if (event.type === 'connection-changed') {
          setConversations((prev) => prev.map((c) => ({ ...c, state: reduce(c.state, event) })));
          return;
        }
        // Shadow Chat (task 8.3): a `threadId`-tagged event belongs to a shadow thread. Track it in
        // the registry (which enforces Req 7.8 — an inbound event for an unopened thread is rejected)
        // and route it to its OWN conversation keyed by `threadId`, so it renders ONLY inside the
        // opened shadow thread and never leaks into the surface chat list, previews, or
        // notifications (Req 7.5/7.6). Shadow events are non-notifiable via the registry's
        // `isNotifiable`, so no OS/in-app notification is ever raised for them.
        const tid = (event as { threadId?: unknown }).threadId;
        if (typeof tid === 'string' && tid.length > 0) {
          try {
            shadowRegistryRef.current?.apply(event);
          } catch {
            return; // unopened shadow thread: drop with no surface effect (Req 7.8).
          }
          const peerUid =
            'remoteUid' in event && typeof event.remoteUid === 'string' ? event.remoteUid : undefined;
          if (peerUid !== undefined) {
            shadowPeerRef.current.set(tid, peerUid);
          }
          animateNext();
          setConversations((prev) => {
            const base = prev.some((c) => c.id === tid)
              ? prev
              : [
                  {
                    id: tid,
                    name: peerUid ?? 'Shadow',
                    state: initialConversationState('mobile'),
                    lastAt: Date.now(),
                  },
                  ...prev,
                ];
            return base.map((c) =>
              c.id === tid ? { ...c, state: reduce(c.state, event), lastAt: Date.now() } : c,
            );
          });
          return;
        }
        const target =
          'remoteUid' in event && event.remoteUid !== undefined ? event.remoteUid : openChatRef.current;
        if (target === null) {
          return;
        }
        // Smooth bubble/list transitions (UX directive motion system, 150–300ms).
        animateNext();
        setConversations((prev) => {
          const base = prev.some((c) => c.id === target)
            ? prev
            : [
                { id: target, name: target, state: initialConversationState('mobile'), lastAt: Date.now() },
                ...prev,
              ];
          return base.map((c) =>
            c.id === target ? { ...c, state: reduce(c.state, event), lastAt: Date.now() } : c,
          );
        });
        // A message from a peer we never started a chat with arrives keyed only by UID; resolve
        // their display name so the header shows a name instead of a raw UID (best-effort).
        ensurePeerName(target);
      }),
    [controller, ensurePeerName],
  );

  // Surface encryption-setup progress/failure (identity + device registration + connect).
  useEffect(() => controller.onSetupChange(setSetup), [controller]);

  // Presence opt-in (Req 5.1): the signed-in user's own setting, restored from the backend.
  const [presenceEnabled, setPresenceEnabled] = useState(false);
  // The open peer's presence (Req 5.2), polled while a conversation is open.
  const [peerPresence, setPeerPresence] = useState<{ online: boolean | null; lastSeen: number | null }>(
    { online: null, lastSeen: null },
  );

  // Inbound typing hints (Req 5.3): remember which peer is typing and auto-expire the indicator
  // a few seconds after the last hint, since there is no explicit "stopped typing" frame.
  const [typingPeer, setTypingPeer] = useState<string | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () =>
      controller.onTyping((fromUid) => {
        setTypingPeer(fromUid);
        if (typingTimerRef.current !== null) {
          clearTimeout(typingTimerRef.current);
        }
        typingTimerRef.current = setTimeout(() => setTypingPeer(null), 6000);
      }),
    [controller],
  );

  // In-chat identity verification (Signature Feature 2, §4): per-peer session badge state, driven
  // by E2E verification control frames. Session-scoped — reset on sign-out with the rest of state.
  const [verificationByPeer, setVerificationByPeer] = useState<
    Record<string, 'none' | 'requested' | 'incoming' | 'verified' | 'unverified'>
  >({});
  useEffect(
    () =>
      controller.onVerification((event) => {
        if (event.type === 'duress-alert-received') {
          // A contact we are the trusted contact for signalled duress. Surface it discreetly (§4.3).
          Alert.alert('Safety alert', 'A contact may need help. Reach out to them privately.');
          return;
        }
        setVerificationByPeer((prev) => {
          switch (event.type) {
            case 'verify-requested':
              return { ...prev, [event.peerUid]: 'requested' };
            case 'verify-incoming':
              return { ...prev, [event.peerUid]: 'incoming' };
            case 'verify-result':
              return { ...prev, [event.peerUid]: event.ok ? 'verified' : 'unverified' };
            default:
              return prev;
          }
        });
      }),
    [controller],
  );
  const onRequestVerification = useCallback(() => void controller.requestVerification(), [controller]);
  const onRespondVerification = useCallback(
    (kind: 'normal' | 'duress') => void controller.respondVerification(kind),
    [controller],
  );

  // App-lock check (Signature Feature 4, §6): once signed in + onboarded, find out whether a real
  // PIN is configured. If so, stay locked (appMode === null) until it is entered; otherwise the app
  // is unlocked in real mode. Runs when the encrypted vault may have become available (setup ready).
  useEffect(() => {
    if (uid === null || displayName === null || lockKnown) {
      return;
    }
    let cancelled = false;
    void Promise.all([controller.hasAppPin(), controller.hasDecoyPin()]).then(([hasPin, hasDecoy]) => {
      if (cancelled) {
        return;
      }
      setLockKnown(true);
      setAppLockEnabled(hasPin);
      setDecoyEnabled(hasDecoy);
      setAppMode(hasPin ? null : 'real');
    });
    return () => {
      cancelled = true;
    };
  }, [controller, uid, displayName, lockKnown, setup]);

  // Load the hidden-chat peer set once unlocked, so the list + search exclude them (§3.1).
  useEffect(() => {
    if (appMode === null) {
      setHiddenPeers([]);
      return;
    }
    let cancelled = false;
    void controller.listHiddenPeers().then((peers) => {
      if (!cancelled) {
        setHiddenPeers(peers);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [controller, appMode]);

  // Auto-relock + re-hide on backgrounding (§3.1 auto-rehide; §6 lock): drop to the lock screen and
  // close any open (possibly revealed) hidden chat when the app leaves the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && lockKnown) {
        void controller.hasAppPin().then((hasPin) => {
          if (hasPin) {
            setAppMode(null);
            setOpenChatId(null);
          }
        });
      }
    });
    return () => sub.remove();
  }, [controller, lockKnown]);

  const onUnlock = useCallback(
    (pin: string) => {
      setLockError(null);
      void controller.unlockApp(pin).then((result) => {
        if ('mode' in result) {
          setAppMode(result.mode);
          setLockLocked(false);
          setLockError(null);
        } else if ('locked' in result) {
          setLockLocked(true);
          const mins = Math.ceil(result.msUntilUnlock / 60000);
          setLockError(`Too many attempts. Try again in ${mins} min.`);
        } else {
          setLockError('Incorrect PIN.');
        }
      });
    },
    [controller],
  );

  // Reveal a hidden chat by typing its secret in the chat-list search bar (§3.3). A match opens that
  // one chat; a non-match is indistinguishable from a failed search (the caller shows no results).
  const onRevealSearch = useCallback(
    (text: string) => {
      if (appMode !== 'real' || text.trim().length === 0) {
        return;
      }
      void controller.revealHiddenChat(text.trim()).then((result) => {
        if ('peerUid' in result) {
          animateNext();
          setOpenChatId(result.peerUid);
        }
      });
    },
    [controller, appMode],
  );

  // Open a resolved shadow thread locally: track it + its peer (so sends ride the shadow thread),
  // exclude it from the surface list, add a hidden conversation entry, and show it. Shared by the
  // /alias search path and the long-press creation path. Never touches the peer's surface chat.
  const openShadowThreadLocal = useCallback(
    (ref: { threadId: string; peerUid: string }, name?: string) => {
      shadowPeerRef.current.set(ref.threadId, ref.peerUid);
      setShadowThreadIds((prev) => {
        const next = new Set(prev);
        next.add(ref.threadId);
        return next;
      });
      setConversations((prev) =>
        prev.some((c) => c.id === ref.threadId)
          ? prev
          : [
              {
                id: ref.threadId,
                name: name ?? ref.peerUid,
                state: initialConversationState('mobile'),
                lastAt: Date.now(),
              },
              ...prev,
            ],
      );
      controller.openConversation(ref.peerUid);
      animateNext();
      setOpenChatId(ref.threadId);
    },
    [controller],
  );

  // Bridge the search handler's off-thread PIN re-entry (Req 12.3) to the modal prompt: the handler
  // calls this with a `verify(pin)` closure; we surface the prompt and resolve the handler's promise
  // once the user verifies (true) or dismisses (false). Verification runs inside the prompt behind
  // its busy spinner, so the UI never freezes (Req 12.7).
  const promptForPin = useCallback(
    (verify: (pin: string) => Promise<boolean>) =>
      new Promise<boolean>((resolve) => {
        setPinPrompt({ verify, resolve });
      }),
    [],
  );

  // Search-bar submit (task 8.2 / 14.x): FIRST intercept a `/alias` through the ONE shared decision
  // path (`createMobileShadowSearchHandler` → `@chat-app/crypto`), identical to the web adapter (C2).
  // A real-mode alias hit opens that contact's shadow thread — prompting for the per-chat PIN first
  // when the bound thread has one (Req 12.3) — while every other outcome (not an alias, wrong alias,
  // decoy/null mode, unprovisioned) falls through to the existing hidden-chat reveal / ordinary
  // search with identical observable behaviour (Req 1.1–1.6, 8.4, 8.6). The handler never reveals
  // that a shadow thread exists.
  const onSearch = useCallback(
    (text: string) => {
      const registry = shadowRegistryRef.current;
      const store = controller.getShadowSecretStore();
      if (registry === null || store === null) {
        onRevealSearch(text);
        return;
      }
      const handle = createMobileShadowSearchHandler({
        store,
        registry,
        getMode: () => appMode,
        onOpenShadowThread: (ref) => openShadowThreadLocal(ref),
        onOrdinarySearch: (query) => onRevealSearch(query),
        requestPinAndVerify: (ref: ShadowThreadRef) =>
          promptForPin((pin) =>
            ref.pinVerifier !== undefined ? verifySecret(pin, ref.pinVerifier) : Promise.resolve(false),
          ),
      });
      void handle(text);
    },
    [appMode, controller, onRevealSearch, openShadowThreadLocal, promptForPin],
  );

  // Long-press → "Shadow chat" → creation sheet confirm (Shadow Chat, Requirement 11.6, 11.7). In
  // real mode only: ensure the device-local shadow secrets exist, bind the alias-discriminated
  // thread (hash-only) durably through the store, open the (hidden) thread in the registry, and show
  // it — WITHOUT sending any message, advancing any surface sequence, or mutating the contact's
  // surface conversation. Throws on failure so the sheet surfaces a generic inline message.
  const onCreateShadowChat = useCallback(
    async (alias: string, pin?: string): Promise<void> => {
      const target = createSheet;
      if (appMode !== 'real' || target === null) {
        throw new Error('Shadow chat is unavailable right now.');
      }
      const store = controller.getShadowSecretStore();
      const myUid = controller.getUid() ?? uid;
      if (store === null || myUid === null) {
        throw new Error('Secure storage is still setting up. Try again in a moment.');
      }
      // Provision the Master_Secret / Alias_Key once (no-op if already provisioned) so bindAlias has
      // a context to derive from (Req 11.6); secrets stay in the encrypted vault (Req 9.1, 9.5).
      await controller.provisionShadowContext();
      const ref = await store.bindAlias('real', alias, target.peerUid, myUid, pin);
      if (ref === null) {
        throw new Error('Could not create the shadow chat.');
      }
      shadowRegistryRef.current?.openShadowThread(ref.threadId, ref.peerUid);
      openShadowThreadLocal(ref, target.name);
      setCreateSheet(null);
    },
    [appMode, controller, uid, createSheet, openShadowThreadLocal],
  );

  // Open the row long-press overlay (Req 11.1). The menu offers "Shadow chat" only in real mode.
  const onLongPressRow = useCallback((id: string, name: string, kind: 'chat' | 'contact') => {
    setRowMenu({ id, name, kind });
  }, []);

  // Add / change / remove the OPEN shadow thread's optional per-chat PIN (Shadow Chat, task 16.1,
  // Requirements 12.5, 12.7, 12.8). Real mode + shadow thread only: route to the DURABLE store's
  // `setThreadPin('real', threadId, newPin | null)` — a non-empty PIN sets/changes the lock, `null`
  // removes it. The PBKDF2 hashing runs off the UI thread inside the store (native provider), and the
  // settings sheet awaits this behind its busy spinner so the UI never freezes (Req 12.7). The PIN is
  // stored hash-only in the encrypted vault and never transmitted (Req 12.6). Throws on failure so
  // the sheet surfaces a generic inline message; success dismisses it.
  const onSetThreadPin = useCallback(
    async (newPin: string | null): Promise<void> => {
      const threadId = openChatRef.current;
      const store = controller.getShadowSecretStore();
      if (appMode !== 'real' || threadId === null || store === null || !shadowThreadIds.has(threadId)) {
        throw new Error('Shadow chat settings are unavailable right now.');
      }
      const ref = await store.setThreadPin('real', threadId, newPin);
      if (ref === null) {
        throw new Error('Could not update the PIN.');
      }
    },
    [appMode, controller, shadowThreadIds],
  );

  // Poll the open peer's presence (Req 5.2) while a conversation is open: immediately on open
  // and every 20s thereafter. Cleared when no chat is open so we don't poll in the background.
  useEffect(() => {
    if (openChatId === null) {
      setPeerPresence({ online: null, lastSeen: null });
      return undefined;
    }
    let cancelled = false;
    const poll = (): void => {
      void controller.getPresence(openChatId).then((p) => {
        if (!cancelled) {
          setPeerPresence(p === null ? { online: null, lastSeen: null } : { online: p.online, lastSeen: p.lastSeen });
        }
      });
    };
    poll();
    const id = setInterval(poll, 20_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [openChatId, controller]);

  // Rehydrate persisted conversation history once the encrypted store is open, so chats
  // survive an app restart instead of starting empty (Phase 2 CC4). Guarded by a ref so it
  // runs once per signed-in session even though `ready` may be reported more than once.
  const rehydratedRef = useRef(false);
  useEffect(
    () =>
      controller.onSetupChange((next) => {
        if (next.phase !== 'ready' || rehydratedRef.current) {
          return;
        }
        rehydratedRef.current = true;
        void controller.loadConversations().then((restored) => {
          if (restored.length === 0) {
            return;
          }
          setConversations((prev) => {
            const present = new Set(prev.map((c) => c.id));
            const added = restored
              .filter((r) => !present.has(r.id))
              .map((r) => ({ id: r.id, name: r.id, state: r.state, lastAt: r.lastAt }));
            return [...added, ...prev];
          });
          // Resolve display names so rehydrated rows show a name instead of a raw UID.
          for (const r of restored) {
            ensurePeerName(r.id);
          }
        });
      }),
    [controller, ensurePeerName],
  );

  // Restore a persisted sign-in on launch: Firebase remembers the session across an app
  // kill, so this fires with the signed-in uid and we skip the Sign_In_Screen. We then load
  // the profile (display name + phone) so a returning user also skips onboarding.
  useEffect(
    () =>
      controller.onAuthStateChanged((signedInUid) => {
        if (signedInUid === null) {
          return;
        }
        setUid(signedInUid);
        // Restore the display name from durable on-device storage first, so a returning user
        // skips onboarding even when the backend is unreachable (the same condition that fails
        // encryption setup). loadDisplayName falls back to the backend profile when no local
        // copy exists, re-persisting it locally.
        void controller.loadDisplayName().then((name) => {
          if (name !== null) {
            setDisplayName(name);
          }
        });
        // Still fetch the profile for the stored phone (and to surface a server-set name if the
        // local copy was empty); this is best-effort and must not gate onboarding.
        void controller.whoAmI().then((me) => {
          if (me === null) {
            return;
          }
          if (me.displayName !== null && me.displayName.length > 0) {
            setDisplayName(me.displayName);
          }
          if (me.storedPhone !== null && me.storedPhone.length > 0) {
            setPhone(me.storedPhone);
          }
          setPresenceEnabled(me.presenceEnabled);
        });
      }),
    [controller],
  );

  const confirmOtp = useCallback(
    async (code: string, e164: string): Promise<boolean> => {
      const signedInUid = await controller.confirmOtp(code, e164);
      if (signedInUid !== null) {
        setUid(signedInUid);
        setPhone(e164);
        return true;
      }
      return false;
    },
    [controller],
  );

  // Open a conversation: tell the controller which peer subsequent sends target, then show it.
  const openChat = useCallback(
    (id: string) => {
      controller.openConversation(id);
      animateNext();
      setOpenChatId(id);
    },
    [controller],
  );

  // Start a chat from the New-chat screen. A tap on an existing peer reopens it; a phone
  // number is resolved to a recipient UID via the backend directory, and the conversation
  // is keyed by that UID (so sends/receives address the right device).
  const startChat = useCallback(
    async (phoneOrId: string, name: string) => {
      const existing = conversations.find((c) => c.id === phoneOrId);
      if (existing !== undefined) {
        setNewChatOpen(false);
        openChat(existing.id);
        return;
      }
      const result = await controller.resolveContact(phoneOrId.replace(/\s+/g, ''));
      if (!result.ok) {
        Alert.alert('Cannot start chat', result.error);
        return;
      }
      const uid = result.uid;
      // Prefer the recipient's chosen display name; fall back to the number they were found by.
      const peerName = result.displayName ?? name;
      setConversations((prev) =>
        prev.some((c) => c.id === uid)
          ? prev
          : [
              { id: uid, name: peerName, state: initialConversationState('mobile'), lastAt: Date.now() },
              ...prev,
            ],
      );
      setNewChatOpen(false);
      openChat(uid);
    },
    [conversations, controller, openChat],
  );

  const onComposerChange = useCallback(
    (text: string) => {
      const target = openChatRef.current;
      if (target === null) {
        return;
      }
      // Notify the peer we're typing (Req 5.3); the controller rate-limits, so per-keystroke is fine.
      if (text.length > 0) {
        controller.sendTyping();
      }
      setConversations((prev) =>
        prev.map((c) =>
          c.id === target ? { ...c, state: reduce(c.state, { type: 'composer-changed', text }) } : c,
        ),
      );
    },
    [controller],
  );

  const onSend = useCallback(
    (options?: { viewOnce?: boolean }) => {
      const target = openChatRef.current;
      if (target === null) {
        return;
      }
      const open = conversations.find((c) => c.id === target);
      const text = open?.state.composer.text.trim() ?? '';
      if (text.length === 0) {
        return;
      }
      // The controller owns the message lifecycle (message-appended + status updates flow
      // back through the subscription); the container only clears the composer.
      onComposerChange('');
      // Shadow Chat (task 8.2): when the open chat is a shadow thread, send WITH its `threadId` so
      // the message rides the shadow thread (the controller targets the peer recipient set when the
      // thread was opened). A surface chat passes no `threadId` — byte-for-byte the prior behaviour.
      const threadId = shadowPeerRef.current.has(target) ? target : undefined;
      void controller.send(text, {
        ...(options ?? {}),
        ...(threadId !== undefined ? { threadId } : {}),
      });
    },
    [conversations, controller, onComposerChange],
  );

  // A view-once message was displayed: purge it (delete-on-display) via the controller (Req 4.3).
  const onView = useCallback((id: string) => void controller.markViewed(id), [controller]);

  // Reaction / edit / delete / timer all target the OPEN conversation (the controller's
  // active recipient); the optimistic reducer events flow back through the subscription.
  const onReact = useCallback(
    (target: MessageTarget, emoji: string) => void controller.react(target, emoji),
    [controller],
  );
  const onEdit = useCallback(
    (target: MessageTarget, body: string) => void controller.editMessage(target, body),
    [controller],
  );
  const onDelete = useCallback(
    (target: MessageTarget) => void controller.deleteMessage(target),
    [controller],
  );
  const onSetTimer = useCallback(
    (ttlMs: number) => void controller.setDisappearingTimer(ttlMs),
    [controller],
  );
  const getSafetyNumber = useCallback(() => {
    const target = openChatRef.current;
    return target !== null ? controller.getSafetyNumber(target) : Promise.resolve(null);
  }, [controller]);

  const signOut = useCallback(() => {
    void controller.signOut();
    // Session-end hygiene: drop all conversation + profile state with the session.
    rehydratedRef.current = false;
    setConversations([]);
    setOpenChatId(null);
    setNewChatOpen(false);
    setTab('chats');
    setUid(null);
    setPhone('');
    setDisplayName(null);
    setAppMode(null);
    setLockKnown(false);
    setLockError(null);
    setLockLocked(false);
    setAppLockEnabled(false);
    setDecoyEnabled(false);
    setHiddenPeers([]);
    setVerificationByPeer({});
    setShadowThreadIds(new Set());
    shadowPeerRef.current.clear();
    setRowMenu(null);
    setCreateSheet(null);
    setPinPrompt(null);
  }, [controller]);

  const openConversation = openChatId !== null
    ? conversations.find((c) => c.id === openChatId) ?? null
    : null;

  // Hidden chats never appear in the list or contacts (§3.1); the only way in is the search-bar
  // secret (onRevealSearch), which opens the chat by id even though it is filtered out here. Shadow
  // threads (task 8.3) are likewise excluded from the list, contacts, and previews — the only way in
  // is an /alias via onSearch, which opens the thread by its threadId even though it is filtered out.
  const hidden = new Set(hiddenPeers);
  const isSurfaceListable = (id: string): boolean => !hidden.has(id) && !shadowThreadIds.has(id);
  const summaries: ChatSummary[] = [...conversations]
    .filter((c) => isSurfaceListable(c.id))
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((c) => ({
      id: c.id,
      name: c.name,
      preview: previewOf(c.state),
      time: timeLabel(c.lastAt),
      unread: 0,
    }));
  const contacts: ContactRow[] = conversations
    .filter((c) => isSurfaceListable(c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: dark ? '#15171C' : '#FAFAF9' }]}>
      {uid === null ? (
        <SignInScreen onRequestOtp={(e164) => controller.requestOtp(e164)} onConfirmOtp={confirmOtp} />
      ) : displayName === null ? (
        <OnboardingScreen
          onDone={(name, pin) => {
            animateNext();
            setDisplayName(name);
            // Durably store the chosen PIN as a salted verifier (§6.2); an unlocked session starts
            // in real mode. A skipped PIN leaves the app unlocked (no gate).
            if (pin !== null) {
              void controller.setAppPin(pin, 'real');
            }
            setAppMode('real');
            setLockKnown(true);
            // Publish the name so peers see it instead of a UID (best-effort).
            void controller.setDisplayName(name);
          }}
        />
      ) : appMode === null ? (
        // A real PIN is set but not yet entered: gate behind the lock screen (§6).
        <AppLockScreen onUnlock={onUnlock} error={lockError} locked={lockLocked} />
      ) : openConversation !== null ? (
        <ConversationScreen
          state={openConversation.state}
          peerName={openConversation.name}
          peerTyping={typingPeer === openConversation.id}
          peerOnline={peerPresence.online}
          peerLastSeen={peerPresence.lastSeen}
          onComposerChange={onComposerChange}
          onSend={onSend}
          onReact={onReact}
          onEdit={onEdit}
          onDelete={onDelete}
          onView={onView}
          onSetTimer={onSetTimer}
          getSafetyNumber={getSafetyNumber}
          verification={verificationByPeer[openConversation.id] ?? 'none'}
          onRequestVerification={onRequestVerification}
          onRespondVerification={onRespondVerification}
          isHidden={hidden.has(openConversation.id)}
          onHideChat={
            appMode === 'real' && !shadowThreadIds.has(openConversation.id)
              ? (secret) => {
                  const id = openConversation.id;
                  void controller.hideChat(id, secret).then(() => {
                    setHiddenPeers((prev) => (prev.includes(id) ? prev : [...prev, id]));
                    setOpenChatId(null);
                  });
                }
              : undefined
          }
          onUnhideChat={
            appMode === 'real' && !shadowThreadIds.has(openConversation.id)
              ? () => {
                  const id = openConversation.id;
                  void controller.unhideChat(id).then(() => {
                    setHiddenPeers((prev) => prev.filter((p) => p !== id));
                  });
                }
              : undefined
          }
          onSetThreadPin={
            appMode === 'real' && shadowThreadIds.has(openConversation.id) ? onSetThreadPin : undefined
          }
          onClearChat={
            appMode === 'real' && !shadowThreadIds.has(openConversation.id)
              ? () => {
                  const id = openConversation.id;
                  // Local-only Clear chat: purge this surface conversation's persisted rows, then
                  // reset the open view (and its list preview) to empty via `conversation-cleared`.
                  // The chat stays in the list; this is "clear history", not "delete conversation".
                  void controller.clearChatHistory(id).then(() => {
                    setConversations((prev) =>
                      prev.map((c) =>
                        c.id === id
                          ? { ...c, state: reduce(c.state, { type: 'conversation-cleared', remoteUid: id }) }
                          : c,
                      ),
                    );
                  });
                }
              : undefined
          }
          onBack={() => {
            animateNext();
            setOpenChatId(null);
          }}
        />
      ) : newChatOpen ? (
        <NewChatScreen
          contacts={contacts}
          onStartChat={(id, name) => void startChat(id, name)}
          onLongPressRow={(id, name) => onLongPressRow(id, name, 'contact')}
          onBack={() => {
            animateNext();
            setNewChatOpen(false);
          }}
        />
      ) : (
        <>
          {setup.phase === 'registering' && (
            <View style={[styles.banner, { backgroundColor: dark ? '#252932' : '#E9EDF5' }]}>
              <Text style={[styles.bannerText, { color: dark ? '#ECEEF1' : '#1F2430' }]}>
                Securing your account…
              </Text>
            </View>
          )}
          {setup.phase === 'failed' && (
            <Pressable
              style={[styles.banner, { backgroundColor: '#7A2D28' }]}
              onPress={() => void controller.retrySetup()}
              accessibilityRole="button"
            >
              <Text style={[styles.bannerText, { color: '#fff' }]} numberOfLines={2}>
                Secure setup didn't finish: {setup.error ?? 'unknown error'}
              </Text>
              <Text style={styles.bannerAction}>Tap to retry</Text>
            </Pressable>
          )}
          {tab === 'chats' && (
            <ChatsListScreen
              chats={summaries}
              onOpenChat={openChat}
              onSearchSubmit={onSearch}
              onLongPressRow={(id, name) => onLongPressRow(id, name, 'chat')}
              onNewChat={() => {
                animateNext();
                setNewChatOpen(true);
              }}
            />
          )}
          {tab === 'calls' && <CallsScreen />}
          {tab === 'settings' && (
            <SettingsScreen
              displayName={displayName}
              phone={phone}
              presenceEnabled={presenceEnabled}
              onTogglePresence={(enabled) => {
                setPresenceEnabled(enabled);
                void controller.setPresenceEnabled(enabled);
              }}
              diagnostics={{
                phase: setup.phase,
                error: setup.error,
                deviceId: controller.getDeviceId(),
                uid: controller.getUid(),
              }}
              onSelfTest={async () => {
                // Decisive probe: compare what the server sees on the TOKEN vs what's STORED.
                const me = await controller.whoAmI();
                if (me === null) {
                  return { ok: false, detail: 'Could not reach the server (not signed in or offline).' };
                }
                const lines = [
                  `token phone: ${me.tokenPhone ?? 'NONE'}`,
                  `stored phone: ${me.storedPhone ?? 'NONE'}`,
                  `devices: ${me.deviceCount}`,
                ];
                // selfLookup is the server's in-process resolve of your own number — ground
                // truth, free of HTTP/rate-limit noise. `ok:<uid>` ⇒ discovery works.
                const works = me.selfLookup.startsWith('ok:');
                const verdict = works
                  ? 'Discovery works — others can find you at your number.'
                  : `Lookup result: ${me.selfLookup}`;
                return { ok: works, detail: `${lines.join(' · ')}\nself-lookup: ${me.selfLookup}\n${verdict}` };
              }}
              appLockEnabled={appLockEnabled}
              decoyEnabled={decoyEnabled}
              onSetAppPin={(pin, kind) => {
                void controller.setAppPin(pin, kind).then(() => {
                  if (kind === 'real') {
                    setAppLockEnabled(true);
                    setLockKnown(true);
                  } else {
                    setDecoyEnabled(true);
                  }
                });
              }}
              onClearAppPin={(kind) => {
                void controller.clearAppPin(kind).then(() => {
                  if (kind === 'real') {
                    setAppLockEnabled(false);
                  } else {
                    setDecoyEnabled(false);
                  }
                });
              }}
              onLockNow={() => {
                if (appLockEnabled) {
                  setOpenChatId(null);
                  setAppMode(null);
                }
              }}
              onSignOut={signOut}
            />
          )}
          <TabBar
            active={tab}
            onSelect={(next) => {
              animateNext();
              setTab(next);
            }}
          />
        </>
      )}
      <RowActionMenu
        visible={rowMenu !== null}
        onClose={() => setRowMenu(null)}
        theme={theme}
        title={rowMenu?.name ?? ''}
        primaryActionLabel={rowMenu?.kind === 'contact' ? 'Start chat' : 'Open chat'}
        onPrimaryAction={() => {
          const row = rowMenu;
          setRowMenu(null);
          if (row === null) {
            return;
          }
          if (row.kind === 'contact') {
            void startChat(row.id, row.name);
          } else {
            openChat(row.id);
          }
        }}
        showShadowAction={appMode === 'real'}
        onShadowChat={() => {
          const row = rowMenu;
          setRowMenu(null);
          if (row !== null) {
            setCreateSheet({ peerUid: row.id, name: row.name });
          }
        }}
      />
      <ShadowChatCreateSheet
        visible={createSheet !== null}
        onClose={() => setCreateSheet(null)}
        contactName={createSheet?.name ?? ''}
        onCreate={onCreateShadowChat}
      />
      <ShadowPinPrompt
        visible={pinPrompt !== null}
        onVerify={pinPrompt?.verify ?? (async () => false)}
        onVerified={() => {
          pinPrompt?.resolve(true);
          setPinPrompt(null);
        }}
        onCancel={() => {
          pinPrompt?.resolve(false);
          setPinPrompt(null);
        }}
      />
      <StatusBar style={dark ? 'light' : 'dark'} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: { paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { fontSize: 13, fontWeight: '600' },
  bannerAction: { color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 2, opacity: 0.9 },
});

/**
 * Root export. Wraps the shell in {@link SafeAreaProvider} so that the shell's
 * {@link SafeAreaView} (and any `useSafeAreaInsets` consumer in the screens it renders)
 * resolves the real device insets on both iOS and Android. The previous root used
 * `SafeAreaView` from `react-native`, which is an iOS-only no-op on Android and therefore
 * let the shell + screen headers render underneath the status bar / notch. The
 * `react-native-safe-area-context` provider/view pair pads the top (status bar / notch)
 * and bottom (home indicator) insets globally, so every screen below sits in the safe area.
 */
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppShell />
    </SafeAreaProvider>
  );
}
