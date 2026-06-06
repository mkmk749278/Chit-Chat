/**
 * Handshake token extraction (Requirements 3.1, 3.8).
 *
 * The Firebase ID token is carried out-of-band from the WebSocket handshake in one
 * of two ways, in order of preference:
 *
 *   1. **`Sec-WebSocket-Protocol` subprotocol** (preferred). The client connects with
 *      `new WebSocket(url, ['bearer', firebaseIdToken])`, so the negotiated
 *      subprotocol list is `['bearer', '<token>']`. This keeps the token out of URLs
 *      and proxy/access logs (design §"Token passed via subprotocol", Requirement 13.2).
 *   2. **`?token=` query parameter** (fallback) for clients that cannot set a
 *      subprotocol.
 *
 * A handshake that carries neither yields `null`, which the gateway treats as an
 * unauthenticated request and closes with code 4401 (Requirement 3.1).
 */

import type { IncomingMessage } from 'node:http';

/** Subprotocol scheme name the token rides alongside (`['bearer', '<token>']`). */
const BEARER_PROTOCOL = 'bearer';

/** Query-string key used by the fallback transport (`?token=<idToken>`). */
const TOKEN_QUERY_PARAM = 'token';

/**
 * Extracts the Firebase ID token from a WebSocket upgrade request, preferring the
 * `Sec-WebSocket-Protocol` subprotocol and falling back to the `?token=` query param.
 *
 * @param request - the HTTP upgrade request that initiated the handshake.
 * @returns the trimmed token, or `null` when the handshake carries no usable token.
 */
export function extractHandshakeToken(request: IncomingMessage): string | null {
  return extractFromSubprotocol(request.headers['sec-websocket-protocol']) ?? extractFromQuery(request.url);
}

/**
 * Parses a `Sec-WebSocket-Protocol` header value of the form `"bearer, <token>"`.
 *
 * The header is a comma-separated list; a valid token handshake names the `bearer`
 * scheme followed by exactly one non-empty token entry. Returns `null` for any other
 * shape (absent header, `bearer` without a token, or unrelated subprotocols).
 */
function extractFromSubprotocol(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') {
    return null;
  }

  const protocols = header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (protocols.length < 2 || protocols[0].toLowerCase() !== BEARER_PROTOCOL) {
    return null;
  }

  const token = protocols[1];
  return token.length > 0 ? token : null;
}

/**
 * Parses the `?token=<idToken>` query parameter from the upgrade request URL.
 *
 * The request URL is path-relative (e.g. `/?token=abc`), so it is resolved against a
 * throwaway base purely to drive the URL parser. Returns `null` when the URL is
 * absent/unparseable or the parameter is missing/empty.
 */
function extractFromQuery(url: string | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url, 'http://placeholder.invalid');
  } catch {
    return null;
  }

  const token = parsed.searchParams.get(TOKEN_QUERY_PARAM);
  return token !== null && token.length > 0 ? token : null;
}
