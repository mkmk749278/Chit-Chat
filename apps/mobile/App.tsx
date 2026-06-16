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
import { Alert, Pressable, SafeAreaView, StyleSheet, Text, useColorScheme, View } from 'react-native';

import {
  initialConversationState,
  reduce,
  type ConversationState,
  type MessageTarget,
} from '@chat-app/crypto';

import {
  createMobileController,
  type ChatController,
  type SetupState,
} from './src/app/chat-controller';
import { CallsScreen } from './src/ui/CallsScreen';
import { ChatsListScreen, type ChatSummary } from './src/ui/ChatsListScreen';
import { ConversationScreen } from './src/ui/ConversationScreen';
import { animateNext } from './src/ui/motion';
import { NewChatScreen, type ContactRow } from './src/ui/NewChatScreen';
import { OnboardingScreen } from './src/ui/OnboardingScreen';
import { SettingsScreen } from './src/ui/SettingsScreen';
import { SignInScreen } from './src/ui/SignInScreen';
import { TabBar, type Tab } from './src/ui/TabBar';

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

export default function App(): React.JSX.Element {
  const controllerRef = useRef<ChatController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createMobileController();
  }
  const controller = controllerRef.current;
  const dark = useColorScheme() === 'dark';

  const [uid, setUid] = useState<string | null>(null);
  const [phone, setPhone] = useState<string>('');
  // Onboarding result (UX directive: phone → display name → optional PIN). v1 holds these
  // in-session; durable profile/PIN storage lands with the backend wiring pass.
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [, setAppPin] = useState<string | null>(null);
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

  const onComposerChange = useCallback((text: string) => {
    const target = openChatRef.current;
    if (target === null) {
      return;
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === target ? { ...c, state: reduce(c.state, { type: 'composer-changed', text }) } : c,
      ),
    );
  }, []);

  const onSend = useCallback(() => {
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
    void controller.send(text);
  }, [conversations, controller, onComposerChange]);

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
    setAppPin(null);
  }, [controller]);

  const openConversation = openChatId !== null
    ? conversations.find((c) => c.id === openChatId) ?? null
    : null;

  const summaries: ChatSummary[] = [...conversations]
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((c) => ({
      id: c.id,
      name: c.name,
      preview: previewOf(c.state),
      time: timeLabel(c.lastAt),
      unread: 0,
    }));
  const contacts: ContactRow[] = conversations.map((c) => ({ id: c.id, name: c.name }));

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: dark ? '#15171C' : '#FAFAF9' }]}>
      {uid === null ? (
        <SignInScreen onRequestOtp={(e164) => controller.requestOtp(e164)} onConfirmOtp={confirmOtp} />
      ) : displayName === null ? (
        <OnboardingScreen
          onDone={(name, pin) => {
            animateNext();
            setDisplayName(name);
            setAppPin(pin);
            // Publish the name so peers see it instead of a UID (best-effort).
            void controller.setDisplayName(name);
          }}
        />
      ) : openConversation !== null ? (
        <ConversationScreen
          state={openConversation.state}
          peerName={openConversation.name}
          onComposerChange={onComposerChange}
          onSend={onSend}
          onReact={onReact}
          onEdit={onEdit}
          onDelete={onDelete}
          onSetTimer={onSetTimer}
          getSafetyNumber={getSafetyNumber}
          onBack={() => {
            animateNext();
            setOpenChatId(null);
          }}
        />
      ) : newChatOpen ? (
        <NewChatScreen
          contacts={contacts}
          onStartChat={(id, name) => void startChat(id, name)}
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
