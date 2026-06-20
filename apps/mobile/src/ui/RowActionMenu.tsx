/**
 * `RowActionMenu` — the long-press overlay menu for a chat-list row or a contact / new-chat row
 * (Shadow Chat, design Component 7 "Creation flow"; task 15.1, Requirements 11.1, 11.2, 11.3, 11.8).
 *
 * Opened by a press-and-hold gesture on a row, it presents that row's actions. Crucially it is
 * rendered through the SAME React Native `Modal` PORTAL the conversation action sheets use
 * ({@link SheetModal} in `action-sheet.tsx`), so it draws as a TOP-LEVEL overlay above all
 * chat-list / conversation content with explicit z-order — NOT as an absolutely-positioned sibling
 * of the row (Requirement 11.8). This is the deliberate avoidance of the separate, out-of-scope
 * "`⋮` overflow menu draws behind messages" z-order defect.
 *
 * The **"Shadow chat"** action is included ONLY when {@link RowActionMenuProps.showShadowAction} is
 * true — the container passes `App_Mode === 'real'` — so in `decoy` / `null` mode the menu shows
 * only the ordinary row action and never hints that the shadow feature exists (Requirements 11.2,
 * 11.3, design Correctness Property 13).
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { SheetItem, SheetModal, sheetStyles } from './action-sheet';
import type { Theme } from './theme';

export interface RowActionMenuProps {
  /** Whether the overlay is visible. */
  visible: boolean;
  /** Dismiss the overlay (backdrop tap / cancel). */
  onClose: () => void;
  /** Active theme. */
  theme: Theme;
  /** The row's display name, shown as the menu title. */
  title: string;
  /** Label for the ordinary (non-shadow) row action, e.g. "Open chat" / "Start chat". */
  primaryActionLabel: string;
  /** Invoke the ordinary row action (open the surface chat / start a chat). */
  onPrimaryAction: () => void;
  /**
   * Whether to include the "Shadow chat" action. The container passes `App_Mode === 'real'`; in any
   * other mode this is false and the action is absent (Requirements 11.2, 11.3).
   */
  showShadowAction: boolean;
  /** Invoke the "Shadow chat" action (opens the creation sheet). Only reachable when shown. */
  onShadowChat: () => void;
  /**
   * Invoke the "Send shadow invite" action (Shadow Chat Invites, Req 1.1): sends a consent-based
   * invite to the contact, who receives an Accept/Decline card. Shown under the same real-mode gate
   * as {@link onShadowChat} and only for a contact row (a real two-party peer). Optional so existing
   * call sites are unaffected.
   */
  onShadowInvite?: () => void;
}

/** The long-press overlay menu (top-level modal portal). See the module doc. */
export function RowActionMenu({
  visible,
  onClose,
  theme: t,
  title,
  primaryActionLabel,
  onPrimaryAction,
  showShadowAction,
  onShadowChat,
  onShadowInvite,
}: RowActionMenuProps): React.JSX.Element {
  return (
    <SheetModal visible={visible} onClose={onClose} theme={t}>
      <View style={styles.titleRow}>
        <Text style={[sheetStyles.sheetTitle, { color: t.text }]} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <SheetItem label={primaryActionLabel} onPress={onPrimaryAction} theme={t} />
      {showShadowAction && <SheetItem label="Shadow chat" onPress={onShadowChat} theme={t} />}
      {showShadowAction && onShadowInvite !== undefined && (
        <SheetItem label="Send shadow invite" onPress={onShadowInvite} theme={t} />
      )}
      <SheetItem label="Cancel" onPress={onClose} theme={t} destructive />
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  titleRow: { marginBottom: 4 },
});
