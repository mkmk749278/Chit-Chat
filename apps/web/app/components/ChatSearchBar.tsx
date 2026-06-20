'use client';

/**
 * Web chat search bar (Shadow Chat, task 8.1).
 *
 * A purely presentational, Spotlight-style search field (mirroring the mobile `ChatsListScreen`
 * search input): it owns only its own input text and reports submit through a single callback. It
 * holds NO shadow logic — on submit it hands the raw text to {@link ChatSearchBarProps.onSubmit},
 * which the container wires to the shared `createWebShadowSearchHandler` (and thence to the one
 * shared `@chat-app/crypto` decision path, C2).
 *
 * Indistinguishability (Requirements 1.5, 8.4, 8.6): the bar renders and behaves IDENTICALLY for an
 * `/alias`, a wrong alias, and an ordinary query — it shows no shadow-specific hint, result, or
 * error, and always clears the field on submit. Whether an alias opened a shadow thread or fell
 * through to an ordinary search is decided downstream and never reflected in this component.
 */

import { useCallback, useState, type CSSProperties, type FormEvent } from 'react';

export interface ChatSearchBarProps {
  /**
   * Called with the raw, untrimmed search text when the user submits (Enter). The container wires
   * this to the shared shadow-search handler; this component does not interpret the text. Submitting
   * empty text is ignored.
   */
  onSubmit: (text: string) => void;
  /** Optional placeholder; defaults to "Search". */
  placeholder?: string;
}

export function ChatSearchBar({ onSubmit, placeholder = 'Search' }: ChatSearchBarProps): JSX.Element {
  const [query, setQuery] = useState('');

  const handleSubmit = useCallback(
    (event: FormEvent): void => {
      event.preventDefault();
      if (query.trim().length === 0) {
        return;
      }
      // Hand the raw text downstream; clear the field exactly as an ordinary search would, so an
      // alias submit is visually indistinguishable from a normal search submit.
      onSubmit(query);
      setQuery('');
    },
    [query, onSubmit],
  );

  return (
    <form role="search" aria-label="Search chats" style={styles.form} onSubmit={handleSubmit}>
      <input
        aria-label="Search chats"
        style={styles.input}
        type="search"
        value={query}
        placeholder={placeholder}
        onChange={(event) => setQuery(event.target.value)}
      />
    </form>
  );
}

const styles: Record<string, CSSProperties> = {
  form: { padding: '8px 16px', borderBottom: '1px solid #e2e8f0' },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #cbd5e1',
    fontSize: 15,
    boxSizing: 'border-box',
  },
};
