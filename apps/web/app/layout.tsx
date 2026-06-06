import type { ReactNode } from 'react';

// Root layout required by the Next.js app router. Phase 0 skeleton only.
export const metadata = {
  title: 'chat-app',
  description: 'Privacy chat application',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
