# UI Modernization — Visual Mockups

These wireframes accompany [`design.md`](./design.md) and let you **see** the proposed redesign
before any production code changes. They cover the three reported problems the design fixes:

- **P1** — setup/unlock no longer freezes (busy/spinner UX over an off-thread KDF).
- **P2** — chat messages render in true **chronological** order (no more "jumbled" threads).
- **P3** — a **minimal, modern** UI: a clean conversation header (no 5-icon clutter), a profile
  screen, real-looking icons, grouped bubbles, day separators, and time labels.

> These are **visual mockups only** — static/fake data, **no crypto and no real wiring**. They exist
> to validate the look and interaction before implementation. A runnable RN/Expo version of each
> screen lives under `apps/mobile/src/ui/mockups/` (see the index at the bottom).

---

## 1. Conversation header — BEFORE vs AFTER (P3)

**BEFORE** — five tappable emoji icons crowd the header to the right of the name:

```
┌─────────────────────────────────────────────────────────────┐
│  ‹   (MP)  Maya Patel                                         │
│            Encrypted · end-to-end      ⏲   🛡   👤   🫥        │
└─────────────────────────────────────────────────────────────┘
        ^ name + status                 ^^^^^^^^^^^^^^^^^^
                                        timer/safety/verify/hide
                                        = cluttered, unclear, dated
```

**AFTER** — back · tappable avatar · name + one concise status · a single `⋮` overflow:

```
┌─────────────────────────────────────────────────────────────┐
│  ‹    ( MP )  Maya Patel                                ⋮     │
│               online                                          │
└─────────────────────────────────────────────────────────────┘
       └ tap avatar/name → Contact profile        └ tap ⋮ → menu

                                   ⋮ opens:
                                   ┌────────────────────────────┐
                                   │ Disappearing messages       │
                                   │ Verify identity             │
                                   │ Safety number               │
                                   │ Hide chat                   │
                                   └────────────────────────────┘
```

The four actions move into the `⋮` menu **and** the new Contact/Profile screen — every capability
is still reachable, the header is calm.

---

## 2. Conversation thread — AFTER (P2 + P3)

Day separator pills, consecutive-sender grouping (tighter spacing + one tail per run), per-bubble
`HH:mm` time labels, status ticks (`✓✓`) on outbound, a reaction, an "edited" tag, and a
"message deleted" placeholder. The list is **bottom-anchored** (newest visible):

```
┌─────────────────────────────────────────────────────────────┐
│  ‹   ( MP )  Maya Patel · online                        ⋮     │
├─────────────────────────────────────────────────────────────┤
│                      ┌───────────┐                            │
│                      │ Yesterday │   ← day separator pill     │
│                      └───────────┘                            │
│   ┌──────────────────────────────────┐                       │
│   │ Hey! Are we still on for lunch    │                       │
│   │ tomorrow?                  09:30 ✓✓│  ← outbound + ticks   │
│   └──────────────────────────────────┘                       │
│   ┌──────────────────────────────┐                           │
│   │ Yes — 12:30 at the usual?     │  ← inbound                │
│   │                         09:32 │                           │
│   └──────────────────────────────┘                           │
│   ┌──────────────────────────────────┐                       │
│   │ Perfect, see you then     09:33 ✓✓│                       │
│   └──────────────────────────────────┘                       │
│        ( 👍 )  ← reaction chip                                │
│                      ┌─────────┐                              │
│                      │  Today  │                              │
│                      └─────────┘                              │
│   ┌──────────────────────────────┐                           │
│   │ Morning! Running 10 min late  │ ┐                         │
│   │                         09:05 │ │ grouped run             │
│   ├──────────────────────────────┤ │ (tight spacing,         │
│   │ Grab us a table?        09:05 │ ┘  single tail)           │
│   └──────────────────────────────┘                           │
│   ┌──────────────────────────────────┐                       │
│   │ Ordered you a coffee  edited 09:06│  ← edited tag         │
│   └──────────────────────────────────┘                       │
│   ┌──────────────────────────────┐                           │
│   │ message deleted         09:08 │  ← deleted placeholder    │
│   └──────────────────────────────┘                           │
├─────────────────────────────────────────────────────────────┤
│  [ Message…                                      ]   ( ➤ )    │
└─────────────────────────────────────────────────────────────┘
```

### Why this is the P2 fix (ordering by time, not by `seq`)

Inbound and outbound `seq` are **independent** spaces (both start at 1). Ordering by `seq` clumps
the directions and reads out of order. Ordering by `createdAt` interleaves them correctly:

```
 seq value │ direction │ createdAt │ correct chronological read
 ──────────┼───────────┼───────────┼────────────────────────────
  out #1    │   ▶ out   │  09:30    │ 1. Hey! Are we still on…
  in  #1    │   ◀ in    │  09:32    │ 2. Yes — 12:30…
  out #2    │   ▶ out   │  09:33    │ 3. Perfect, see you then
  in  #2    │   ◀ in    │  09:05*   │ 4. Morning! Running late
  in  #3    │   ◀ in    │  09:05*   │ 5. Grab us a table?
  out #3    │   ▶ out   │  09:06    │ 6. No worries…

 OLD (by seq+direction): in#1,in#2,in#3 … out#1,out#2,out#3  → JUMBLED
 NEW (by createdAt):     true back-and-forth above            → CORRECT
 (* "Today" messages; the table shows how seq alone would mis-order them.)
```

---

## 3. Contact / Profile screen (P3, new)

Opened by tapping the name/avatar. Large avatar, encrypted + verified badges, and the grouped
actions that used to live as header icons:

```
┌─────────────────────────────────────────────────────────────┐
│  ‹   Contact info                                             │
├─────────────────────────────────────────────────────────────┤
│                        ┌────────┐                             │
│                        │   MP   │   ← large avatar            │
│                        └────────┘                             │
│                       Maya Patel                              │
│              ( 🛡 Encrypted )  ( ✓ Verified )   ← badges      │
│                                                               │
│   ┌─────────────────────────────────────────────────────┐    │
│   │ ⏲  Disappearing messages                 1 day   ›  │    │
│   │ ✓  Verify identity                      Verified  ›  │    │
│   │ 🛡  View safety number                            ›  │    │
│   │ 🚫  Hide chat                                     ›  │    │
│   └─────────────────────────────────────────────────────┘    │
│                                                               │
│   Messages and calls are end-to-end encrypted. Tap "View      │
│   safety number" to confirm Maya's identity.                  │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Modernized Chats list (P3)

Search bar on top, clean rows (avatar · name · preview · time · unread pill), floating compose
button:

```
┌─────────────────────────────────────────────────────────────┐
│  Chats                                                        │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ 🔍  Search                                           │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                               │
│  ( MP )  Maya Patel                              09:10        │
│          See you in a few!                                    │
│  ───────────────────────────────────────────────────────     │
│  ( LN )  Leo Nguyen                              08:42        │
│          You: sent the files 🔒                               │
│  ───────────────────────────────────────────────────────     │
│  ( AC )  Aria Costa                          Yesterday  ( 3 ) │
│          Can you call me later?                               │
│  ───────────────────────────────────────────────────────     │
│  ( SO )  Sam Okoye                           Yesterday  ( 1 ) │
│          🔒 Encrypted message                                 │
│                                                       ┌─────┐ │
│                                                       │  ✎  │ │← FAB
│                                                       └─────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. App lock — non-freezing busy state (P1)

Idle vs verifying. Tapping **Unlock** disables the field/button and shows a spinner while the
PIN is checked. In production the heavy PBKDF2 runs **off the JS thread** so the UI never freezes;
the mockup simulates the delay only to show the busy UX.

```
        IDLE                              VERIFYING
┌──────────────────────────┐    ┌──────────────────────────┐
│        Enter PIN         │    │        Enter PIN         │
│   Your PIN unlocks the   │    │   Your PIN unlocks the   │
│          app.            │    │          app.            │
│   ┌──────────────────┐   │    │   ┌──────────────────┐   │
│   │  • • • •         │   │    │   │  • • • •  (locked)│   │
│   └──────────────────┘   │    │   └──────────────────┘   │
│   ┌──────────────────┐   │    │   ┌──────────────────┐   │
│   │      Unlock      │   │    │   │ ◌  Verifying…    │   │← spinner
│   └──────────────────┘   │    │   └──────────────────┘   │  + disabled
│                          │    │  Checking your PIN —     │
│                          │    │  the app stays responsive│
└──────────────────────────┘    └──────────────────────────┘
```

---

## What each demo file shows

Runnable React Native / Expo mockups (TypeScript, static data, no crypto) under
`apps/mobile/src/ui/mockups/`:

| Wireframe above | Demo file | Shows |
| --- | --- | --- |
| §1, §2 | `ConversationScreenMockup.tsx` | Clean header + `⋮` overflow (P3); chronological grouped chat with day pills, time labels, ticks, reaction, edited/deleted (P2 + P3). |
| §3 | `ContactProfileScreenMockup.tsx` | New profile screen with badges + grouped actions (P3). |
| §4 | `ChatsListScreenMockup.tsx` | Modernized chat list with search + FAB (P3). |
| §5 | `AppLockScreenMockup.tsx` | Non-freezing unlock with busy/spinner state (P1 UX). |
| — | `theme.mockup.ts` | Refreshed tokens: `spacing`, `radius`, `type` (reuses the real color palette). |
| — | `Icon.mockup.tsx` | Dependency-free View-based icon set (production will use `@expo/vector-icons`). |
| all | `MockupGallery.tsx` | Single switcher component to flip between all the screens above. |

> To view: temporarily render `<MockupGallery />` from `App.tsx` (do not commit that change). The
> gallery is the one entry point that ties the whole redesign together.

**Reminder:** these mockups carry **no cryptography and no transport/state wiring** — they are a
visual prototype to confirm the look and feel before the design is implemented for real.
