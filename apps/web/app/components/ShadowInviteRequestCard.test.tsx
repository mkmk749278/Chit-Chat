import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { RecipientRouting } from '@chat-app/crypto';

import { ShadowInviteRequestCard } from './ShadowInviteRequestCard';

/**
 * Behavioural tests for the web Shadow Chat Invites Accept/Decline request card (design Component A;
 * Req 1.3, 3.1). Renders the REAL component into jsdom and drives its two-step contract: Accept
 * reveals the routing choice (hidden default | merge) and resolves with the chosen routing; Decline
 * resolves immediately with no routing.
 */
describe('ShadowInviteRequestCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const click = (text: string): void => {
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (btn === undefined) throw new Error(`button not found: ${text}`);
    act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };

  test('shows the inviter and, on Accept, the routing choice; chooses hidden by default', () => {
    const onAccept = vi.fn<(routing: RecipientRouting) => void>();
    const onDecline = vi.fn();
    act(() => {
      root.render(
        createElement(ShadowInviteRequestCard, { peerName: 'Bob', onAccept, onDecline }),
      );
    });
    expect(container.textContent).toContain('Bob');
    // Step 1 → Accept reveals routing options.
    click('Accept');
    expect(container.textContent).toContain('Hidden shadow chat');
    expect(container.textContent).toContain('recommended');
    // Choosing the recommended (hidden) option resolves with 'hidden'.
    click('Hidden shadow chat');
    expect(onAccept).toHaveBeenCalledWith('hidden');
    expect(onDecline).not.toHaveBeenCalled();
  });

  test('the merge option resolves Accept with merge', () => {
    const onAccept = vi.fn<(routing: RecipientRouting) => void>();
    act(() => {
      root.render(
        createElement(ShadowInviteRequestCard, { peerName: 'Carol', onAccept, onDecline: vi.fn() }),
      );
    });
    click('Accept');
    click('Show in main chat');
    expect(onAccept).toHaveBeenCalledWith('merge');
  });

  test('Decline resolves immediately with no routing', () => {
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    act(() => {
      root.render(
        createElement(ShadowInviteRequestCard, { peerName: 'Dave', onAccept, onDecline }),
      );
    });
    click('Decline');
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });

  test('renders an optional label next to the inviter', () => {
    act(() => {
      root.render(
        createElement(ShadowInviteRequestCard, {
          peerName: 'Bob',
          label: 'Project X',
          onAccept: vi.fn(),
          onDecline: vi.fn(),
        }),
      );
    });
    expect(container.textContent).toContain('Project X');
  });
});
