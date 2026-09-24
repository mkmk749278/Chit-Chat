import type { ReactNode } from 'react';

// Root layout required by the Next.js app router. Phase 0 skeleton only.
export const metadata = {
  title: 'chat-app',
  description: 'Privacy chat application',
};

/**
 * The web client still runs on the in-memory demo controller (`createDemoController`): it performs
 * no real sign-in, encryption, or delivery. Until the real controller is wired (see
 * `docs/phase1-handoff.md` §3.1), every page says so plainly, so nobody on the public domain
 * believes a message typed here was sent.
 */
function PreviewBanner(): JSX.Element {
  return (
    <div
      role="status"
      style={{
        padding: '8px 16px',
        background: '#fff4e5',
        color: '#663c00',
        borderBottom: '1px solid #ffd8a8',
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        textAlign: 'center',
      }}
    >
      Web preview — messages typed here are not sent. Use the Lumin Chat Android app to chat.
    </div>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <PreviewBanner />
        {children}
      </body>
    </html>
  );
}
