'use client';

/**
 * `OverlayPortal` — a top-layer modal overlay rendered through a React DOM portal (Shadow Chat,
 * task 15.2; Requirement 11.1).
 *
 * Source of truth: `.kiro/specs/shadow-chat/design.md` → "Creation flow (NEW)" — the long-press menu
 * "is built as a proper full-screen overlay with explicit z-order (a `Modal` portal), so it cannot
 * repeat the separate, out-of-scope ⋮-menu-behind-messages bug". This is the WEB analogue of the
 * mobile React Native `Modal` portal (`SheetModal`): it renders its children into a portal attached
 * to `document.body`, ABOVE all chat-list / conversation content, with an explicit high `z-index`
 * and a full-screen backdrop. Because it portals out of the normal flow it is never clipped by, or
 * stacked beneath, any row or message container — satisfying the "correct z-order" requirement
 * (Requirement 11.1) and avoiding the z-order defect class called out in the design.
 *
 * It is purely structural (backdrop + centering + portal + Escape/back-drop dismissal + focus on
 * mount); it holds no Shadow Chat logic. The menu, the creation sheet, and the re-entry PIN prompt
 * all render through it so they share one correct, tested overlay layer.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

/** The fixed stacking order for the shadow overlay layer — comfortably above any app chrome. */
export const SHADOW_OVERLAY_Z_INDEX = 2000;

export interface OverlayPortalProps {
  /** Whether the overlay is mounted/visible. */
  open: boolean;
  /** Called when the user dismisses via the backdrop or the Escape key. */
  onDismiss: () => void;
  /** Accessible label for the dialog surface. */
  ariaLabel: string;
  /** The overlay content (menu / sheet / prompt). */
  children: ReactNode;
  /**
   * Vertical placement of the content within the backdrop: `center` for dialogs/prompts, `bottom`
   * for action-sheet-style menus (the long-press menu). Defaults to `center`.
   */
  placement?: 'center' | 'bottom';
}

/**
 * Render `children` into a top-layer portal with a dimmed full-screen backdrop. Returns `null`
 * (rendering nothing) while closed or before the component has mounted on the client, so it is safe
 * under server-side rendering (the portal target only exists in the browser).
 */
export function OverlayPortal({
  open,
  onDismiss,
  ariaLabel,
  children,
  placement = 'center',
}: OverlayPortalProps): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Portals require a DOM target; only render after the first client mount.
  useEffect(() => {
    setMounted(true);
  }, []);

  // Dismiss on Escape while open, and move focus onto the surface so keyboard users land inside it.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    surfaceRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onDismiss]);

  if (!open || !mounted || typeof document === 'undefined') {
    return null;
  }

  const backdropStyle: CSSProperties = {
    ...styles.backdrop,
    alignItems: placement === 'bottom' ? 'flex-end' : 'center',
  };

  return createPortal(
    <div
      style={backdropStyle}
      // A backdrop click (but not a click that bubbled up from the surface) dismisses.
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
    >
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={placement === 'bottom' ? styles.sheetSurface : styles.dialogSurface}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: SHADOW_OVERLAY_Z_INDEX,
    display: 'flex',
    justifyContent: 'center',
    padding: 16,
    backgroundColor: 'rgba(15, 23, 42, 0.55)',
  },
  dialogSurface: {
    width: '100%',
    maxWidth: 380,
    background: '#ffffff',
    borderRadius: 16,
    boxShadow: '0 20px 50px rgba(15, 23, 42, 0.35)',
    outline: 'none',
    overflow: 'hidden',
  },
  sheetSurface: {
    width: '100%',
    maxWidth: 480,
    background: '#ffffff',
    borderRadius: 16,
    boxShadow: '0 20px 50px rgba(15, 23, 42, 0.35)',
    outline: 'none',
    overflow: 'hidden',
    marginBottom: 8,
  },
};
