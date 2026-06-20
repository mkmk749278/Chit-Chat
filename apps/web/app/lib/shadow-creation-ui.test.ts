import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  ShadowSecretStore,
  createConversationRegistry,
  type AppMode,
  type ConversationRegistry,
  type ShadowThreadRef,
} from '@chat-app/crypto';

import { isShadowActionVisible } from '../components/ShadowChatOverlayMenu';
import {
  bindWebShadowChat,
  createInMemoryShadowSecretPersistence,
  deriveSurfaceChatList,
} from './shadow-search';

/**
 * Creation-UI adapter tests for the WEB Shadow Chat long-press creation overlay (task 15.3,
 * Requirements 11.2, 11.3, 11.5, 11.7, 11.8, 11.10; design Correctness Property 13 & Property 1b).
 *
 * They assert, per the task:
 *   (a) the overlay menu's "Shadow chat" action visibility follows real mode (the exported
 *       `isShadowActionVisible`): present iff `App_Mode === 'real'`, absent under decoy/`null`
 *       (Req 11.2, Property 13);
 *   (b) creation via the web binding path leaves the surface chat untouched — after binding,
 *       `registry.listSurfaceConversations()` stays empty (Req 11.7);
 *   (c) an invalid alias is rejected and binds nothing (Req 11.5);
 *   (d) the overlay renders through the top-level portal (`OverlayPortal` → `createPortal` into
 *       `document.body`) — a structural assertion over the component sources (Req 11.8).
 */

const MY_UID = 'demo-uid-me';
const PEER = 'demo-uid-bob';

/** Provision the in-memory store with a real master secret + alias key (no aliases yet). */
function provisionStore(): ShadowSecretStore {
  const persistence = createInMemoryShadowSecretPersistence();
  void persistence.saveMasterSecret(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
  void persistence.saveAliasKey(Uint8Array.from([9, 10, 11, 12, 13, 14, 15, 16]));
  return new ShadowSecretStore(persistence);
}

interface CreationHarness {
  registry: ConversationRegistry;
  opened: ShadowThreadRef[];
  bind: (alias: string, pin?: string) => Promise<ShadowThreadRef | null>;
}

function creationHarness(getMode: () => AppMode | null): CreationHarness {
  const store = provisionStore();
  const registry = createConversationRegistry({ platform: 'web' });
  const opened: ShadowThreadRef[] = [];
  const bind = (alias: string, pin?: string): Promise<ShadowThreadRef | null> =>
    bindWebShadowChat(
      { store, registry, getMode, myUid: MY_UID, onOpenShadowThread: (ref) => opened.push(ref) },
      PEER,
      alias,
      pin,
    );
  return { registry, opened, bind };
}


describe('(a) shadow overlay action visibility follows real mode (Req 11.2, Property 13)', () => {
  test('the "Shadow chat" action is present ONLY in real mode', () => {
    expect(isShadowActionVisible('real')).toBe(true);
    expect(isShadowActionVisible('decoy')).toBe(false);
    expect(isShadowActionVisible(null)).toBe(false);
  });
});

describe('(b) creation never disturbs the surface chat (Req 11.7)', () => {
  test('real-mode binding opens the thread but leaves the surface chat list empty', async () => {
    const h = creationHarness(() => 'real');
    const ref = await h.bind('/secret');

    expect(ref).not.toBeNull();
    expect(ref?.peerUid).toBe(PEER);
    expect(ref?.threadId).toMatch(/^[0-9a-f]{64}$/);
    // The thread was opened/navigated...
    expect(h.opened).toEqual([ref]);
    // ...but NO surface conversation was created — creation is inert on the surface (Req 11.7, 11.10).
    expect(deriveSurfaceChatList(h.registry)).toEqual([]);
    expect(h.registry.listSurfaceConversations()).toEqual([]);
  });

  test('binding two distinct aliases for the same contact still leaves the surface empty', async () => {
    const h = creationHarness(() => 'real');
    const a = await h.bind('/one');
    const b = await h.bind('/two');
    // Alias discrimination → distinct threads (Property 1b)...
    expect(a?.threadId).not.toBe(b?.threadId);
    // ...and neither touches the surface chat list.
    expect(h.registry.listSurfaceConversations()).toEqual([]);
  });
});

describe('(c) an invalid alias is rejected and binds nothing (Req 11.5)', () => {
  test('an invalid alias throws and opens/persists nothing', async () => {
    const h = creationHarness(() => 'real');
    await expect(h.bind('not-an-alias')).rejects.toThrow();
    expect(h.opened).toEqual([]);
    expect(h.registry.listSurfaceConversations()).toEqual([]);
  });

  test('non-real mode binds nothing and opens nothing (creation inertness, Property 13)', async () => {
    for (const mode of ['decoy', null] as const) {
      const h = creationHarness(() => mode);
      const ref = await h.bind('/secret');
      expect(ref).toBeNull();
      expect(h.opened).toEqual([]);
      expect(h.registry.listSurfaceConversations()).toEqual([]);
    }
  });
});


describe('(d) the overlay renders through the top-level portal (Req 11.8)', () => {
  // Vitest runs from the package root (apps/web); resolve the component sources from there.
  const COMPONENTS = path.resolve(process.cwd(), 'app/components');
  const read = (name: string): string => readFileSync(path.join(COMPONENTS, name), 'utf8');
  const overlayPortalSrc = read('OverlayPortal.tsx');

  test('OverlayPortal mounts via react-dom createPortal into document.body', () => {
    // The portal target is document.body — top of the DOM, above all chat-list / conversation
    // content — so the overlay can never be clipped by or stacked beneath a row (Req 11.8).
    expect(overlayPortalSrc).toMatch(/import\s*\{\s*createPortal\s*\}\s*from\s*'react-dom'/);
    expect(overlayPortalSrc).toMatch(/createPortal\(/);
    expect(overlayPortalSrc).toMatch(/document\.body/);
    // It also pins an explicit high z-index for the overlay layer.
    expect(overlayPortalSrc).toMatch(/zIndex:\s*SHADOW_OVERLAY_Z_INDEX/);
  });

  test('the menu, creation sheet, and re-entry PIN prompt all render through OverlayPortal', () => {
    for (const name of [
      'ShadowChatOverlayMenu.tsx',
      'ShadowChatCreationSheet.tsx',
      'ShadowReentryPinPrompt.tsx',
    ]) {
      const src = read(name);
      expect(src, `${name} should import OverlayPortal`).toMatch(
        /import\s*\{\s*OverlayPortal\s*\}\s*from\s*'\.\/OverlayPortal'/,
      );
      expect(src, `${name} should render through <OverlayPortal>`).toMatch(/<OverlayPortal\b/);
    }
  });
});
