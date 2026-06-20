/**
 * Creation-UI adapter tests for the mobile Shadow Chat long-press creation overlay (task 15.3,
 * Requirements 11.2, 11.3, 11.5, 11.7, 11.8; design Correctness Property 13 & Property 1b).
 *
 * These run under `node --test` (no React Native renderer is configured in this repo), so — exactly
 * like the sibling `overflow-menu-zorder.test.ts` — the structural/z-order assertions are static
 * checks over the component SOURCE, while the alias-validation assertion exercises the REAL shared
 * `normalizeAlias` the sheet validates through (so the test pins the actual decision, not a copy).
 *
 * They assert, per the task:
 *   (a) `RowActionMenu` includes the "Shadow chat" action ONLY behind its `showShadowAction` prop
 *       (real mode) and never unconditionally — so decoy/`null` mode omits it (Req 11.2, 11.3,
 *       Property 13);
 *   (b) `ShadowChatCreateSheet` refuses an invalid alias (`normalizeAlias === null` ⇒ confirm
 *       disabled / `onCreate` not called) and accepts a valid one (Req 11.5);
 *   (c) `RowActionMenu`, `ShadowChatCreateSheet`, and `ShadowPinPrompt` all render through the
 *       `SheetModal` `Modal` PORTAL (top z-order), never as absolutely-positioned siblings (Req
 *       11.8).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { normalizeAlias } from '@chat-app/crypto';

// The compiled test lives in `dist/ui/`; the TSX sources live in `src/ui/`.
const SRC_UI = path.resolve(__dirname, '../../src/ui');
const rowActionMenuSrc = readFileSync(path.join(SRC_UI, 'RowActionMenu.tsx'), 'utf8');
const createSheetSrc = readFileSync(path.join(SRC_UI, 'ShadowChatCreateSheet.tsx'), 'utf8');
const pinPromptSrc = readFileSync(path.join(SRC_UI, 'ShadowPinPrompt.tsx'), 'utf8');
const actionSheetSrc = readFileSync(path.join(SRC_UI, 'action-sheet.tsx'), 'utf8');


// (a) RowActionMenu — the "Shadow chat" action is gated on `showShadowAction` (real mode) ONLY.

test('RowActionMenu renders the "Shadow chat" action ONLY behind the showShadowAction prop', () => {
  // There is exactly ONE "Shadow chat" action in the menu source...
  const shadowItems = rowActionMenuSrc.match(/label="Shadow chat"/g) ?? [];
  assert.equal(shadowItems.length, 1, 'expected exactly one "Shadow chat" SheetItem in RowActionMenu');

  // ...and that single action is rendered conditionally, guarded by `showShadowAction &&`, so it is
  // present in real mode and ABSENT in any other mode (Req 11.2, 11.3, Property 13).
  assert.match(
    rowActionMenuSrc,
    /showShadowAction\s*&&\s*<SheetItem label="Shadow chat"/,
    'the "Shadow chat" action must be conditional on showShadowAction',
  );
});

test('RowActionMenu never renders the "Shadow chat" action unconditionally', () => {
  // No `<SheetItem label="Shadow chat"` appears without the `showShadowAction &&` guard immediately
  // before it (a coerced/decoy unlock must not even see the creation entry point — Req 11.3).
  const unguarded = /(^|[^&]\s*)<SheetItem label="Shadow chat"/m.test(
    rowActionMenuSrc.replace(/showShadowAction\s*&&\s*<SheetItem label="Shadow chat"/g, ''),
  );
  assert.equal(unguarded, false, 'the "Shadow chat" action must never be rendered unconditionally');
});


// (b) ShadowChatCreateSheet — alias validation through the SHARED normalizeAlias (Req 11.5).

test('normalizeAlias (the sheet validator) accepts valid aliases and rejects invalid ones', () => {
  // Valid: a slash-prefixed alphanumeric alias normalises to non-null (confirm becomes enabled).
  assert.notEqual(normalizeAlias('/secret1'), null);
  assert.equal(normalizeAlias('/Private'), '/private'); // case-insensitive, normalised
  assert.equal(normalizeAlias('  /Work  '), '/work'); // trimmed
  // Invalid: no leading slash, empty body, spaces, punctuation → null (confirm stays disabled).
  assert.equal(normalizeAlias('notanalias'), null);
  assert.equal(normalizeAlias('/'), null);
  assert.equal(normalizeAlias('/two words'), null);
  assert.equal(normalizeAlias(''), null);
});

test('ShadowChatCreateSheet computes alias validity from normalizeAlias and gates confirm on it', () => {
  // The sheet derives validity from the SAME normaliser the resolver uses (Req 11.5) — not a copy.
  assert.match(
    createSheetSrc,
    /aliasValid\s*=\s*normalizeAlias\(alias\)\s*!==\s*null/,
    'alias validity must be derived from normalizeAlias(alias) !== null',
  );
  // The Create control is disabled while the alias is invalid (or while busy).
  assert.match(
    createSheetSrc,
    /disabled=\{!aliasValid \|\| busy\}/,
    'the Create button must be disabled when the alias is invalid',
  );
});

test('ShadowChatCreateSheet does not call onCreate for an invalid alias', () => {
  // submit() short-circuits before invoking onCreate when the alias is invalid (binds nothing).
  assert.match(
    createSheetSrc,
    /if \(!aliasValid\) \{\s*return;\s*\}/,
    'submit must early-return (skip onCreate) when the alias is invalid',
  );
  // The single onCreate call sits AFTER that guard, inside the busy action.
  assert.match(createSheetSrc, /await onCreate\(alias\.trim\(\)/, 'expected onCreate to be invoked with the alias');
});


// (c) Top z-order — every shadow creation overlay renders through the SheetModal Modal portal.

test('the shadow creation overlays all render through the SheetModal portal', () => {
  for (const [name, src] of [
    ['RowActionMenu', rowActionMenuSrc],
    ['ShadowChatCreateSheet', createSheetSrc],
    ['ShadowPinPrompt', pinPromptSrc],
  ] as const) {
    assert.match(src, /<SheetModal\b/, `${name} must render through <SheetModal> (top-level portal)`);
  }
});

test('SheetModal mounts at the top overlay layer via a react-native Modal portal', () => {
  // SheetModal imports `Modal` from react-native and renders through it — the same root-overlay
  // portal approach the overflow-menu fix uses, so the menu draws ABOVE all chat content (Req 11.8).
  assert.match(
    actionSheetSrc,
    /import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*'react-native'/,
    'action-sheet must import Modal from react-native',
  );
  assert.match(actionSheetSrc, /<Modal\b/, 'SheetModal must render through <Modal>');
});

test('the shadow creation overlays never use absolute positioning (no sibling z-order collision)', () => {
  for (const [name, src] of [
    ['RowActionMenu', rowActionMenuSrc],
    ['ShadowChatCreateSheet', createSheetSrc],
    ['ShadowPinPrompt', pinPromptSrc],
  ] as const) {
    assert.doesNotMatch(
      src,
      /position:\s*'absolute'/,
      `${name} must not use absolute positioning; it lays out within the Modal portal`,
    );
  }
});
