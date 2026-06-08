/**
 * Web health endpoint (`GET /health`).
 *
 * Returns a small JSON liveness payload so the deploy pipeline (web.yml) and the
 * Caddy edge can verify the Next.js service is serving. Marked dynamic so it is a
 * real runtime response rather than a statically cached page.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}
