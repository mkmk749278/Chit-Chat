/**
 * `@chat-app/crypto` — `ShadowInviteCoordinator` (Shadow Chat Invites, design Component A).
 *
 * Source of truth: `.kiro/specs/shadow-chat-invites/design.md` → "Component A:
 * ShadowInviteCoordinator" and the Algorithmic Pseudocode section, plus `requirements.md`
 * (Requirements 1, 2, 3, 4, 7, 8, 10, 13).
 *
 * This is the pure-core owner of the **invite / accept / decline / revoke** control-message
 * lifecycle for two-party, invitation-based shadow threads. It mirrors the shipped in-chat
 * identity-verification flow (`verify-request` / `verify-response` / `verify-result` in
 * `messaging.ts`): the control payloads ride INSIDE the existing libsignal ciphertext, are
 * intercepted by Messaging before conversation routing, and surface as {@link ShadowInviteEvent}s
 * the platform UI renders — never as ordinary conversation rows.
 *
 * **The core fix it embodies.** An invited thread is keyed by a fresh 32-byte SHARED `threadKey`
 * the inviter generates and carries (base64) inside the encrypted `shadow-invite`. Both peers derive
 * `deriveShadowThreadId(threadKey, uidA, uidB)` (no alias discriminator) and therefore converge on
 * an identical `threadId` — the regression the shipped single-shared-secret e2e harness masked.
 *
 * **Platform-agnostic / holds no transport.** All I/O is injected via {@link
 * ShadowInviteCoordinatorDeps}: the {@link ShadowSecretStore} (durable invited-thread records +
 * shared keys, real-mode gated, fail-closed), the {@link ConversationRegistry} (per-thread state +
 * routing override + clear/close), a narrow {@link ShadowInviteTransport} (E2E control + shadow
 * sends), the {@link RowThreadAssociation} + `purgeMessages` (per-`threadId` history purge), an
 * injected {@link RandomSource} and id/clock/mode sources (deterministic in tests).
 *
 * **Decoy/locked inertness.** Every entry point resolves the current {@link AppMode}; in `decoy`
 * or `null` mode `createInvite`/`acceptInvite`/`revokeShadowThread`/`clearShadowThread` are no-ops
 * that release nothing and send nothing, and an inbound invite/revoke is silently ignored
 * (`handleInbound` still returns `true` so nothing renders) — coercion reveals nothing
 * (Correctness Properties 6, 16).
 *
 * **No durable inbound-invite / pre-accept secret beyond what the design mandates.** The inviter's
 * `awaiting-accept` thread (and its shared key) is persisted durably by the store. The recipient's
 * un-accepted inbound `shadow-invite` and the inviter's `Pre_Accept_Queue` are TRANSIENT bookkeeping
 * (design "auto-cleanup of invite-control traffic"); they are held in RAM and deleted the moment the
 * invite resolves, leaving no invite residue (Correctness Property 13).
 */

import type { AppMode } from './app-lock';
import type { ContentPayload } from './content-payload';
import type { ConversationRegistry } from './conversation-registry';
import type { Unsubscribe } from './ports';
import type { RowThreadAssociation } from './row-thread-association';
import type {
  InvitedThreadRef,
  RecipientRouting,
  ShadowSecretStore,
  ShadowThreadRef,
} from './shadow-secret-store';

/** A device-local CSPRNG source, injected for determinism in tests. */
export interface RandomSource {
  /** Return `n` cryptographically-strong random bytes. */
  bytes(n: number): Uint8Array;
}

/**
 * The narrow transport seam the coordinator drives. The platform binds it to `Messaging` so every
 * payload becomes an ordinary `CiphertextEnvelope` between the two surface UIDs (frozen backend).
 */
export interface ShadowInviteTransport {
  /** Encrypt and send a shadow control payload over the existing E2E channel (no threadId on wire). */
  sendControl(peerUid: string, payload: ContentPayload): Promise<void>;
  /**
   * Send an ordinary shadow message into `threadId` (seq `>= SHADOW_SEQ_OFFSET`), routed by the
   * `threadId` carried inside the ciphertext. Used to flush the pre-accept queue on Accept.
   */
  sendShadow(peerUid: string, threadId: string, plaintext: string): Promise<void>;
}

/** Lifecycle events surfaced to the platform UI (analogous to `VerificationEvent`). */
export type ShadowInviteEvent =
  /** Inviter side: we created and sent an invite; UI shows a hidden pending thread. */
  | { type: 'invite-sent'; inviteId: string; peerUid: string; threadId: string }
  /** Recipient side: an invite arrived; UI renders an Accept/Decline card in the MAIN chat. */
  | { type: 'invite-received'; inviteId: string; peerUid: string; label?: string }
  /** Inviter side: the recipient accepted; the pending thread is promoted to active. */
  | { type: 'invite-accepted'; inviteId: string; peerUid: string; threadId: string }
  /** Inviter side: the recipient declined; the pending thread + key are discarded. */
  | { type: 'invite-declined'; inviteId: string; peerUid: string }
  /**
   * EITHER side: an invite reached a terminal state and its invite-control residue (record + visible
   * request card) has been auto-removed. Drives card dismissal (Correctness Property 13).
   */
  | { type: 'invite-resolved'; inviteId: string; reason: 'accepted' | 'declined' | 'expired' }
  /**
   * EITHER side: a shadow thread was revoked (locally, or because a `shadow-revoke` arrived). The
   * thread is closed, its key + local history are gone. Distinct from a local "clear" (keeps the key).
   */
  | { type: 'thread-revoked'; threadId: string; peerUid: string; initiatedBy: 'self' | 'peer' };

/** The inviter's in-flight invite handle. */
export interface InvitePending {
  inviteId: string;
  peerUid: string;
  threadId: string;
  /** While true, sends into this thread are QUEUED locally and not transmitted (pre-accept). */
  awaitingAccept: boolean;
}

/** Injected collaborators (all I/O lives behind these; the coordinator itself is pure orchestration). */
export interface ShadowInviteCoordinatorDeps {
  store: ShadowSecretStore;
  registry: ConversationRegistry;
  transport: ShadowInviteTransport;
  random: RandomSource;
  /** Device-local row→thread association used to resolve history rows for Clear/Revoke. */
  rowThreads: RowThreadAssociation;
  /** Durable per-`threadId` history purge (reuses the app's existing `KeyStore.purgeMessages`). */
  purgeMessages(rowIds: string[]): Promise<void>;
  /** Resolve the current App-Lock mode; only `real` releases/acts on shadow context. */
  resolveMode(): AppMode | null;
  /** The local user's own UID (needed to derive the converged threadId). */
  myUid(): string;
  /** Wall clock (ms) for invite-expiry / pre-accept TTL; injected for deterministic tests. */
  now(): number;
  /** Fresh invite id (uuid v4 in production); injected for determinism. */
  newInviteId(): string;
  /** Invite expiry window in ms (default 7 days). */
  inviteTtlMs?: number;
}

/** Default invite expiry: 7 days (design Decision register). */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Bytes in a shared per-thread key (must match the codec's `shadow-invite.key` validation). */
const THREAD_KEY_BYTES = 32;

/** The contract the platform UI / Messaging drive (design Component A). */
export interface ShadowInviteCoordinator {
  createInvite(peerUid: string, alias?: string, pin?: string): Promise<InvitePending | null>;
  acceptInvite(
    inviteId: string,
    routing: RecipientRouting,
    alias?: string,
    pin?: string,
  ): Promise<ShadowThreadRef | null>;
  declineInvite(inviteId: string): Promise<void>;
  revokeShadowThread(threadId: string): Promise<void>;
  clearShadowThread(threadId: string): Promise<void>;
  expireStaleInvites(now: number): Promise<void>;
  handleInbound(peerUid: string, payload: ContentPayload): Promise<boolean>;
  /**
   * Queue a message typed into an `awaiting-accept` thread on the inviter side; it is held locally
   * and NOT transmitted until the recipient Accepts (Req 4.1). Returns true when queued (thread was
   * awaiting-accept), false otherwise so the caller falls back to a normal shadow send.
   */
  enqueuePreAccept(threadId: string, plaintext: string): boolean;
  onInvite(listener: (event: ShadowInviteEvent) => void): Unsubscribe;
}

/** Recipient-side transient record for an un-accepted inbound invite (RAM only; auto-cleaned). */
interface InboundInvite {
  inviteId: string;
  peerUid: string;
  threadKey: Uint8Array;
  label?: string;
  receivedAt: number;
}

/** Inviter-side transient index of an in-flight outbound invite (RAM; mirrors the durable record). */
interface OutboundInvite {
  inviteId: string;
  peerUid: string;
  threadId: string;
  createdAt: number;
}

/**
 * Reference implementation. Pure orchestration over the injected ports; no cryptography or I/O of
 * its own (key generation is one injected CSPRNG draw; derivation happens in the store).
 */
export class DefaultShadowInviteCoordinator implements ShadowInviteCoordinator {
  private readonly listeners = new Set<(event: ShadowInviteEvent) => void>();
  /** inviteId → inbound (recipient) pending invite awaiting accept/decline. */
  private readonly inbound = new Map<string, InboundInvite>();
  /** inviteId → outbound (inviter) in-flight invite awaiting the recipient's response. */
  private readonly outbound = new Map<string, OutboundInvite>();
  /** threadId → ordered pre-accept messages queued locally on the inviter (never transmitted yet). */
  private readonly preAccept = new Map<string, string[]>();

  constructor(private readonly deps: ShadowInviteCoordinatorDeps) {}

  private get ttl(): number {
    return this.deps.inviteTtlMs ?? DEFAULT_INVITE_TTL_MS;
  }

  /** @inheritdoc */
  async createInvite(peerUid: string, alias?: string, pin?: string): Promise<InvitePending | null> {
    const mode = this.deps.resolveMode();
    if (mode !== 'real') {
      return null; // decoy/locked inertness — release nothing, send nothing (Req 10.2)
    }
    const myUid = this.deps.myUid();
    if (peerUid.length === 0 || myUid.length === 0 || peerUid === myUid) {
      return null;
    }
    const threadKey = this.deps.random.bytes(THREAD_KEY_BYTES);
    const inviteId = this.deps.newInviteId();
    // Persist a PENDING (awaiting-accept) invited thread; the store derives the converged threadId
    // from the SHARED key with no alias discriminator. Fail-closed: a store error propagates.
    const ref = await this.deps.store.bindInvitedThread(mode, threadKey, peerUid, myUid, {
      alias,
      pin,
      routing: 'hidden', // inviter is ALWAYS hidden; only the recipient may choose merge (Req 3.6)
      inviteId,
      state: 'awaiting-accept',
    });
    if (ref === null) {
      return null;
    }
    this.outbound.set(inviteId, {
      inviteId,
      peerUid,
      threadId: ref.threadId,
      createdAt: this.deps.now(),
    });
    await this.deps.transport.sendControl(peerUid, {
      type: 'shadow-invite',
      inviteId,
      key: bytesToBase64(threadKey),
      ...(alias !== undefined ? { label: alias } : {}),
    });
    this.emit({ type: 'invite-sent', inviteId, peerUid, threadId: ref.threadId });
    return { inviteId, peerUid, threadId: ref.threadId, awaitingAccept: true };
  }

  /** @inheritdoc */
  async acceptInvite(
    inviteId: string,
    routing: RecipientRouting,
    alias?: string,
    pin?: string,
  ): Promise<ShadowThreadRef | null> {
    const mode = this.deps.resolveMode();
    if (mode !== 'real') {
      return null; // decoy/locked inertness (Req 10.2)
    }
    const invite = this.inbound.get(inviteId);
    if (invite === undefined) {
      return null; // unknown/stale invite — nothing to accept
    }
    const myUid = this.deps.myUid();
    const ref = await this.deps.store.bindInvitedThread(mode, invite.threadKey, invite.peerUid, myUid, {
      alias,
      pin,
      routing,
      inviteId,
      state: 'active',
    });
    if (ref === null) {
      return null;
    }
    this.deps.registry.openShadowThread(ref.threadId, invite.peerUid);
    if (routing === 'merge') {
      // View-only override: surface-visible in the chat list, yet the thread keeps its OWN isolated
      // ConversationState and +1e9 seqs (Req 3.3, 3.4).
      this.deps.registry.markSurfaceVisible(ref.threadId);
    }
    // The shadow-accept carries NO routing choice — the inviter never learns hidden vs merge (Req 3.5).
    await this.deps.transport.sendControl(invite.peerUid, { type: 'shadow-accept', inviteId });
    // Auto-cleanup: the inbound invite record + request card are removed (Req 8.1, Property 13).
    this.inbound.delete(inviteId);
    this.emit({ type: 'invite-resolved', inviteId, reason: 'accepted' });
    return ref;
  }

  /** @inheritdoc */
  async declineInvite(inviteId: string): Promise<void> {
    const mode = this.deps.resolveMode();
    if (mode !== 'real') {
      return; // decoy/locked inertness
    }
    const invite = this.inbound.get(inviteId);
    if (invite === undefined) {
      return;
    }
    await this.deps.transport.sendControl(invite.peerUid, { type: 'shadow-decline', inviteId });
    // Persist no shadow data; auto-remove the inbound record + card (Req 8.2, Property 13).
    this.inbound.delete(inviteId);
    this.emit({ type: 'invite-resolved', inviteId, reason: 'declined' });
  }

  /** @inheritdoc */
  enqueuePreAccept(threadId: string, plaintext: string): boolean {
    // Only queue while the thread is genuinely awaiting-accept on the inviter side.
    const isAwaiting = [...this.outbound.values()].some((o) => o.threadId === threadId);
    if (!isAwaiting) {
      return false;
    }
    const queue = this.preAccept.get(threadId) ?? [];
    queue.push(plaintext);
    this.preAccept.set(threadId, queue);
    return true;
  }

  /** @inheritdoc */
  async revokeShadowThread(threadId: string): Promise<void> {
    const mode = this.deps.resolveMode();
    if (mode !== 'real') {
      return; // decoy/locked inertness — delete nothing, send nothing (Req 7.7, Property 16)
    }
    // Capture history rows BEFORE deleting the record, then delete locally FIRST (fail-closed,
    // local-first — no peer ack required, Req 7.2).
    const rowIds = await this.deps.rowThreads.rowIdsForThread(threadId);
    const res = await this.deps.store.revokeShadowThread(mode, threadId);
    if (res === null) {
      return; // unknown/already-revoked → total no-op (Req 7.6)
    }
    await this.deps.purgeMessages(rowIds);
    await this.deps.rowThreads.forgetThread(threadId);
    this.deps.registry.closeThread(threadId);
    this.forgetThreadLocally(threadId);
    // Then notify the peer; if the socket is down this rides the existing flush-on-reconnect (Req 7.9).
    await this.deps.transport.sendControl(res.peerUid, {
      type: 'shadow-revoke',
      inviteId: res.inviteId,
      threadId,
    });
    this.emit({ type: 'thread-revoked', threadId, peerUid: res.peerUid, initiatedBy: 'self' });
  }

  /** @inheritdoc */
  async clearShadowThread(threadId: string): Promise<void> {
    const mode = this.deps.resolveMode();
    if (mode !== 'real') {
      return; // decoy/locked inertness — reveal nothing (Req 6.6)
    }
    const ref = await this.deps.store.clearShadowThread(mode, threadId);
    if (ref === null) {
      return; // unknown thread → no-op (Req 6.1)
    }
    const rowIds = await this.deps.rowThreads.rowIdsForThread(threadId);
    await this.deps.purgeMessages(rowIds);
    await this.deps.rowThreads.forgetThread(threadId); // purged rows are gone; new sends re-record
    this.deps.registry.clearThread(threadId); // record + key KEPT → chat still works (Property 18)
  }

  /** @inheritdoc */
  async expireStaleInvites(now: number): Promise<void> {
    const cutoff = now - this.ttl;
    const mode = this.deps.resolveMode();
    // Inviter side: discard durable awaiting-accept records past TTL, drop the queue, emit resolved.
    for (const [inviteId, o] of [...this.outbound.entries()]) {
      if (o.createdAt <= cutoff) {
        if (mode === 'real') {
          await this.deps.store.discardInvitedThread(mode, inviteId);
        }
        this.outbound.delete(inviteId);
        this.preAccept.delete(o.threadId);
        this.emit({ type: 'invite-resolved', inviteId, reason: 'expired' });
      }
    }
    // Recipient side: drop un-accepted inbound invites past TTL (RAM only; no persisted residue).
    for (const [inviteId, inv] of [...this.inbound.entries()]) {
      if (inv.receivedAt <= cutoff) {
        this.inbound.delete(inviteId);
        this.emit({ type: 'invite-resolved', inviteId, reason: 'expired' });
      }
    }
  }

  /** @inheritdoc */
  async handleInbound(peerUid: string, payload: ContentPayload): Promise<boolean> {
    switch (payload.type) {
      case 'shadow-invite':
        return this.onInboundInvite(peerUid, payload);
      case 'shadow-accept':
        return this.onInboundAccept(payload.inviteId);
      case 'shadow-decline':
        return this.onInboundDecline(payload.inviteId);
      case 'shadow-revoke':
        return this.onInboundRevoke(payload.threadId);
      default:
        return false; // not a shadow control payload — Messaging continues normal routing (Req 13.3)
    }
  }

  /** @inheritdoc */
  onInvite(listener: (event: ShadowInviteEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- inbound handlers -------------------------------------------------------------------------

  private async onInboundInvite(
    peerUid: string,
    payload: Extract<ContentPayload, { type: 'shadow-invite' }>,
  ): Promise<boolean> {
    if (this.deps.resolveMode() !== 'real') {
      return true; // decoy/null: silently ignore, render nothing, create no thread (Req 10.1)
    }
    const threadKey = base64ToBytes(payload.key);
    if (threadKey === null || threadKey.length !== THREAD_KEY_BYTES) {
      // Codec already rejects a non-32-byte key to `unsupported`; defend in depth and create nothing.
      return true;
    }
    this.inbound.set(payload.inviteId, {
      inviteId: payload.inviteId,
      peerUid,
      threadKey,
      ...(payload.label !== undefined ? { label: payload.label } : {}),
      receivedAt: this.deps.now(),
    });
    this.emit({
      type: 'invite-received',
      inviteId: payload.inviteId,
      peerUid,
      ...(payload.label !== undefined ? { label: payload.label } : {}),
    });
    return true;
  }

  private async onInboundAccept(inviteId: string): Promise<boolean> {
    if (this.deps.resolveMode() !== 'real') {
      return true;
    }
    const ref = await this.deps.store.markInvitedThreadActive('real', inviteId);
    if (ref === null) {
      return true; // unknown/stale accept → no-op
    }
    this.deps.registry.openShadowThread(ref.threadId, ref.peerUid);
    // Flush every queued pre-accept message exactly once, in order, with contiguous shadow seqs.
    const queue = this.preAccept.get(ref.threadId) ?? [];
    for (const text of queue) {
      await this.deps.transport.sendShadow(ref.peerUid, ref.threadId, text);
    }
    this.preAccept.delete(ref.threadId);
    this.outbound.delete(inviteId);
    this.emit({ type: 'invite-accepted', inviteId, peerUid: ref.peerUid, threadId: ref.threadId });
    this.emit({ type: 'invite-resolved', inviteId, reason: 'accepted' });
    return true;
  }

  private async onInboundDecline(inviteId: string): Promise<boolean> {
    if (this.deps.resolveMode() !== 'real') {
      return true;
    }
    const pending = this.outbound.get(inviteId);
    await this.deps.store.discardInvitedThread('real', inviteId);
    if (pending !== undefined) {
      this.preAccept.delete(pending.threadId);
      this.outbound.delete(inviteId);
      this.emit({ type: 'invite-declined', inviteId, peerUid: pending.peerUid });
    }
    this.emit({ type: 'invite-resolved', inviteId, reason: 'declined' });
    return true;
  }

  private async onInboundRevoke(threadId: string): Promise<boolean> {
    const mode = this.deps.resolveMode();
    if (mode !== 'real') {
      return true; // decoy/null: inert no-op (Property 16)
    }
    const rowIds = await this.deps.rowThreads.rowIdsForThread(threadId);
    const res = await this.deps.store.revokeShadowThread(mode, threadId);
    if (res === null) {
      return true; // unknown/already-revoked → total no-op, never throws (Req 13.4)
    }
    await this.deps.purgeMessages(rowIds);
    await this.deps.rowThreads.forgetThread(threadId);
    this.deps.registry.closeThread(threadId);
    this.forgetThreadLocally(threadId);
    this.emit({ type: 'thread-revoked', threadId, peerUid: res.peerUid, initiatedBy: 'peer' });
    return true;
  }

  // --- internals --------------------------------------------------------------------------------

  /** Drop any RAM bookkeeping that references `threadId` (post-revoke hygiene). */
  private forgetThreadLocally(threadId: string): void {
    this.preAccept.delete(threadId);
    for (const [inviteId, o] of [...this.outbound.entries()]) {
      if (o.threadId === threadId) {
        this.outbound.delete(inviteId);
      }
    }
  }

  private emit(event: ShadowInviteEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

// --- base64 (total, dependency-free; mirrors the codec's strict validation) ---------------------

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode bytes to canonical base64 (with `=` padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64_ALPHABET[b0 >> 2];
    out += BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/** Decode canonical base64 to bytes; returns null on malformed input (total, never throws). */
export function base64ToBytes(b64: string): Uint8Array | null {
  if (b64.length % 4 !== 0) {
    return null;
  }
  const lookup = (c: string): number => BASE64_ALPHABET.indexOf(c);
  const bytes: number[] = [];
  for (let i = 0; i < b64.length; i += 4) {
    const c0 = lookup(b64[i]);
    const c1 = lookup(b64[i + 1]);
    const p2 = b64[i + 2] === '=';
    const p3 = b64[i + 3] === '=';
    const c2 = p2 ? 0 : lookup(b64[i + 2]);
    const c3 = p3 ? 0 : lookup(b64[i + 3]);
    if (c0 < 0 || c1 < 0 || (!p2 && c2 < 0) || (!p3 && c3 < 0) || (p2 && !p3)) {
      return null;
    }
    bytes.push((c0 << 2) | (c1 >> 4));
    if (!p2) {
      bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    }
    if (!p3) {
      bytes.push(((c2 & 0x03) << 6) | c3);
    }
  }
  return new Uint8Array(bytes);
}
