/**
 * UI/container-wiring tests for the in-conversation "Clear shadow chat" / "Revoke shadow chat"
 * actions (Shadow Chat Invites, Req 6 + 7).
 *
 * Like the sibling `shadow-pin-settings-ui.test.ts`, these run under `node --test` (no React Native
 * renderer is configured), so the container/menu wiring is pinned with static assertions over the
 * component SOURCE. They guard the regression behind the report "there is no option to clear shadow
 * chats": a shadow conversation must be tagged in `shadowThreadIds` so the shadow-only actions are
 * offered (and the thread stays out of the surface chat list), and the overflow menu must render the
 * Clear/Revoke rows whenever the container provides their callbacks.
 *
 * They assert:
 *   (a) App.tsx offers `onClearShadowChat`/`onRevokeShadowChat` ONLY for a shadow thread in real
 *       mode (`appMode === 'real' && shadowThreadIds.has(openConversation.id)`), and routes them to
 *       the controller's `clearShadowChat`/`revokeShadowChat`;
 *   (b) every code path that surfaces a shadow conversation registers it in `shadowThreadIds` — in
 *       particular the LIVE inbound handler — so a live-arrived thread is treated as shadow (offers
 *       Clear shadow chat, excluded from the surface list) and never as a surface chat;
 *   (c) the surface list excludes shadow threads (`isSurfaceListable` consults `shadowThreadIds`), so
 *       the Clear option lives inside the opened shadow chat and the thread stays hidden from the main
 *       list (Req 7.5/7.6);
 *   (d) the overflow menu renders the Clear/Revoke shadow rows when their callbacks are provided.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const SRC_UI = path.resolve(__dirname, '../../src/ui');
const SRC_APP = path.resolve(__dirname, '../../src/app');
const APP_ROOT = path.resolve(__dirname, '../..');
const appSrc = readFileSync(path.join(APP_ROOT, 'App.tsx'), 'utf8');
const menuSrc = readFileSync(path.join(SRC_UI, 'ConversationOverflowMenu.tsx'), 'utf8');
const settingsSrc = readFileSync(path.join(SRC_UI, 'SettingsScreen.tsx'), 'utf8');
const managerSrc = readFileSync(path.join(SRC_UI, 'ShadowChatManagerSheet.tsx'), 'utf8');
const controllerSrc = readFileSync(path.join(SRC_APP, 'chat-controller.ts'), 'utf8');

// (a) Container gating — Clear/Revoke shadow are offered ONLY for a shadow thread in real mode.

test('App.tsx offers onClearShadowChat ONLY for a shadow thread in real mode', () => {
  assert.match(
    appSrc,
    /onClearShadowChat=\{[\s\S]*?appMode === 'real' && shadowThreadIds\.has\(openConversation\.id\)/,
    'onClearShadowChat must be gated on real mode AND a shadow thread',
  );
  assert.match(appSrc, /controller\.clearShadowChat\(threadId\)/, 'must route to controller.clearShadowChat');
});

test('App.tsx offers onRevokeShadowChat ONLY for a shadow thread in real mode', () => {
  assert.match(
    appSrc,
    /onRevokeShadowChat=\{[\s\S]*?appMode === 'real' && shadowThreadIds\.has\(openConversation\.id\)/,
    'onRevokeShadowChat must be gated on real mode AND a shadow thread',
  );
  assert.match(appSrc, /controller\.revokeShadowChat\(threadId\)/, 'must route to controller.revokeShadowChat');
});

test('App.tsx offers the surface "Clear chat" ONLY for a non-shadow thread', () => {
  // The surface clear is the complement of the shadow gate, so a shadow thread never shows it.
  assert.match(
    appSrc,
    /onClearChat=\{[\s\S]*?appMode === 'real' && !shadowThreadIds\.has\(openConversation\.id\)/,
    'onClearChat (surface) must be gated to NON-shadow threads',
  );
});

// (b) Every surfacing path registers the thread in shadowThreadIds — including the LIVE inbound path.

test('the live inbound shadow handler registers the thread in shadowThreadIds', () => {
  // A shadow conversation first materialised by an inbound message must be tagged as shadow, or it
  // would be treated as a surface chat (no "Clear shadow chat"; leaked into the surface list).
  assert.match(
    appSrc,
    /shadowPeerRef\.current\.set\(tid, peerUid\);[\s\S]*?setShadowThreadIds\(\(prev\) => \{[\s\S]*?next\.add\(tid\);/,
    'the live inbound handler must add tid to shadowThreadIds',
  );
});

// (c) The surface list excludes shadow threads, so the Clear option stays inside the opened chat.

test('the surface chat list excludes shadow threads (kept hidden from the main list)', () => {
  assert.match(
    appSrc,
    /isSurfaceListable\s*=\s*\(id: string\): boolean =>\s*!hidden\.has\(id\) && !shadowThreadIds\.has\(id\)/,
    'isSurfaceListable must exclude shadow threads so they never appear in the main list (Req 7.5/7.6)',
  );
});

// (d) The overflow menu renders the Clear/Revoke shadow rows when their callbacks are provided.

test('the overflow menu renders Clear/Revoke shadow rows when callbacks are provided', () => {
  assert.match(
    menuSrc,
    /onClearShadowChat != null && \([\s\S]*?Clear shadow chat/,
    'the menu must render the "Clear shadow chat" row when onClearShadowChat is provided',
  );
  assert.match(
    menuSrc,
    /onRevokeShadowChat != null && \([\s\S]*?Revoke shadow chat/,
    'the menu must render the "Revoke shadow chat" row when onRevokeShadowChat is provided',
  );
});

// (e) Settings shadow-chat manager — a real-mode-only way to clear/revoke without reopening via /alias.

test('controller.listShadowChats is real-mode gated', () => {
  // The manager source of truth must reveal nothing in decoy/locked mode (Correctness Properties 6, 16).
  assert.match(
    controllerSrc,
    /async listShadowChats\(\): Promise<ShadowChatRef\[\]> \{[\s\S]*?if \(currentAppMode !== 'real'\) \{\s*return \[\];/,
    'listShadowChats must return [] outside real mode',
  );
});

test('Settings passes onManageShadowChats ONLY in real mode', () => {
  assert.match(
    appSrc,
    /onManageShadowChats=\{appMode === 'real' \? openShadowManager : undefined\}/,
    'the Settings manager entry must be gated to real mode',
  );
});

test('SettingsScreen renders the "Shadow chats" row ONLY when onManageShadowChats is provided', () => {
  assert.match(
    settingsSrc,
    /onManageShadowChats !== undefined && \([\s\S]*?label="Shadow chats"/,
    'the "Shadow chats" row must render only when the handler is provided',
  );
});

test('App.tsx wires the manager sheet to the controller clear/revoke + updates local state', () => {
  assert.match(appSrc, /controller\s*\.clearShadowChat\(threadId\)/, 'manager Clear must call controller.clearShadowChat');
  assert.match(appSrc, /controller\s*\.revokeShadowChat\(threadId\)/, 'manager Revoke must call controller.revokeShadowChat');
  // Revoke removes the thread from the thread set so it no longer routes / lists.
  assert.match(appSrc, /revokeShadowChatById[\s\S]*?setShadowThreadIds\(\(prev\) => \{[\s\S]*?next\.delete\(threadId\)/, 'manager Revoke must drop the thread from shadowThreadIds');
});

test('the manager sheet renders a Clear and a Revoke action per chat through SheetModal', () => {
  assert.match(managerSrc, /<SheetModal\b/, 'the manager must render through the SheetModal portal (top z-order)');
  assert.match(managerSrc, /label="Clear shadow chat"[\s\S]*?onPress=\{\(\) => onClear\(chat\.threadId\)\}/, 'each chat must offer Clear');
  assert.match(managerSrc, /label="Revoke shadow chat"[\s\S]*?onPress=\{\(\) => onRevoke\(chat\.threadId\)\}/, 'each chat must offer Revoke');
});
