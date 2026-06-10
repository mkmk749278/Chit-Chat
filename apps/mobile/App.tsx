/**
 * Lumin Chat — mobile app shell (design/mockups; Phase 1 Client Component 7: UI).
 *
 * Container that composes the Lumin 3-tab shell (Chats / Contacts / Settings) around the
 * shared crypto core. Navigation is state-driven (see TabBar.tsx for why React Navigation
 * is deliberately not used at this size): an auth gate shows `SignInScreen` until the user
 * signs in; afterwards the tab shell renders, and opening a chat pushes the
 * `ConversationScreen` over it.
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
} from '@chat-app/crypto';

import {
  createMobileController,
  type ChatController,
  type SetupState,
} from './src/app/chat-controller';
import { ChatsListScreen, type ChatSummary } from './src/ui/ChatsListScreen';
import { ContactsScreen, type ContactRow } from './src/ui/ContactsScreen';
import { ConversationScreen } from './src/ui/ConversationScreen';
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
  const [tab, setTab] = useState<Tab>('chats');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [openChatId, setOpenChatId] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupState>({ phase: 'idle' });
  // The subscription callback below must see the CURRENT open chat, not the one captured
  // when the controller was subscribed.
  const openChatRef = useRef<string | null>(null);
  openChatRef.current = openChatId;

  // Controller events drive the open conversation's reducer.
  useEffect(
    () =>
      controller.subscribe((event) => {
        const target = openChatRef.current;
        if (target === null) {
          return;
        }
        setConversations((prev) =>
          prev.map((c) =>
            c.id === target ? { ...c, state: reduce(c.state, event), lastAt: Date.now() } : c,
          ),
        );
      }),
    [controller],
  );

  // Surface encryption-setup progress/failure (identity + device registration + connect).
  useEffect(() => controller.onSetupChange(setSetup), [controller]);

  const confirmOtp = useCallback(
    async (code: string, e164: string): Promise<boolean> => {
      const signedInUid = await controller.confirmOtp(code);
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
      setOpenChatId(id);
    },
    [controller],
  );

  // Start a chat from the Contacts tab. A tap on an existing peer reopens it; a phone number
  // is resolved to a recipient UID via the backend directory, and the conversation is keyed
  // by that UID (so sends/receives address the right device).
  const startChat = useCallback(
    async (phoneOrId: string, name: string) => {
      const existing = conversations.find((c) => c.id === phoneOrId);
      if (existing !== undefined) {
        openChat(existing.id);
        setTab('chats');
        return;
      }
      const result = await controller.resolveContact(phoneOrId.replace(/\s+/g, ''));
      if (!result.ok) {
        Alert.alert('Cannot start chat', result.error);
        return;
      }
      const uid = result.uid;
      setConversations((prev) =>
        prev.some((c) => c.id === uid)
          ? prev
          : [
              { id: uid, name, state: initialConversationState('mobile'), lastAt: Date.now() },
              ...prev,
            ],
      );
      openChat(uid);
      setTab('chats');
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

  const signOut = useCallback(() => {
    void controller.signOut();
    // Session-end hygiene: drop all conversation state with the session.
    setConversations([]);
    setOpenChatId(null);
    setTab('chats');
    setUid(null);
    setPhone('');
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
    <SafeAreaView style={[styles.root, { backgroundColor: dark ? '#0C0C12' : '#FBFBFE' }]}>
      {uid === null ? (
        <SignInScreen onRequestOtp={(e164) => controller.requestOtp(e164)} onConfirmOtp={confirmOtp} />
      ) : openConversation !== null ? (
        <ConversationScreen
          state={openConversation.state}
          peerName={openConversation.name}
          onComposerChange={onComposerChange}
          onSend={onSend}
          onBack={() => setOpenChatId(null)}
        />
      ) : (
        <>
          {setup.phase === 'registering' && (
            <View style={[styles.banner, { backgroundColor: '#2A2A3C' }]}>
              <Text style={styles.bannerText}>🔐 Setting up encryption…</Text>
            </View>
          )}
          {setup.phase === 'failed' && (
            <Pressable
              style={[styles.banner, { backgroundColor: '#7A1F2B' }]}
              onPress={() => void controller.retrySetup()}
              accessibilityRole="button"
            >
              <Text style={styles.bannerText} numberOfLines={2}>
                ⚠ Encryption setup failed: {setup.error ?? 'unknown error'}
              </Text>
              <Text style={styles.bannerAction}>Tap to retry</Text>
            </Pressable>
          )}
          {tab === 'chats' && (
            <ChatsListScreen
              chats={summaries}
              onOpenChat={openChat}
              onNewChat={() => setTab('contacts')}
            />
          )}
          {tab === 'contacts' && <ContactsScreen contacts={contacts} onStartChat={startChat} />}
          {tab === 'settings' && (
            <SettingsScreen displayName="You" phone={phone} onSignOut={signOut} />
          )}
          <TabBar active={tab} onSelect={setTab} />
        </>
      )}
      <StatusBar style={dark ? 'light' : 'dark'} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: { paddingHorizontal: 16, paddingVertical: 10 },
  bannerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  bannerAction: { color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 2, opacity: 0.9 },
});
