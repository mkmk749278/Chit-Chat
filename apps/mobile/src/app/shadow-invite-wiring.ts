/**
 * `apps/mobile` — wiring of the shared {@link ShadowInviteCoordinator} (Shadow Chat Invites, design
 * Component A) to the mobile client's messaging, store, registry, and encrypted vault.
 *
 * The coordinator is platform-agnostic; this module supplies the mobile platform seams — a
 * {@link ShadowInviteTransport} bound to `Messaging` (so control payloads ride the existing E2E
 * channel and pre-accept messages flush as ordinary shadow sends), a {@link RandomSource} backed by
 * the device CSPRNG, the wall clock, and a collision-resistant invite-id generator. It resolves the
 * messaging instance lazily through {@link ShadowInviteWiringDeps.messaging} so the controller can
 * break the construction cycle (Messaging needs the coordinator for `shadowInvites`; the coordinator
 * needs Messaging for its transport).
 */

import {
  DefaultShadowInviteCoordinator,
  type AppMode,
  type ConversationRegistry,
  type KeyStore,
  type Messaging,
  type RowThreadAssociation,
  type ShadowInviteCoordinator,
  type ShadowInviteTransport,
  type ShadowSecretStore,
} from '@chat-app/crypto';

export interface ShadowInviteWiringDeps {
  /** Lazily resolve the live Messaging instance (null before bootstrap completes). */
  messaging: () => Messaging | null;
  store: ShadowSecretStore;
  registry: ConversationRegistry;
  rowThreads: RowThreadAssociation;
  /** Only `purgeMessages` is needed for the per-thread history purge on Clear / Revoke. */
  keyStore: Pick<KeyStore, 'purgeMessages'>;
  /** The current App-Lock mode; only `real` releases/acts on shadow context. */
  resolveMode: () => AppMode | null;
  /** The signed-in user's own UID (needed to derive the converged threadId). */
  myUid: () => string | null;
  /** CSPRNG (device WebCrypto), injectable for tests. */
  randomBytes?: (n: number) => Uint8Array;
  /** Wall clock, injectable for tests. */
  now?: () => number;
  /** Invite-id generator, injectable for tests. */
  newInviteId?: () => string;
}

const defaultRandomBytes = (n: number): Uint8Array =>
  (globalThis.crypto as Crypto).getRandomValues(new Uint8Array(n));

const defaultNewInviteId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Construct the mobile {@link ShadowInviteCoordinator}. The returned coordinator is bound to
 * Messaging as `MessagingDeps.shadowInvites` AND used directly by the controller to drive
 * create/accept/decline/revoke/clear and to surface {@link ShadowInviteEvent}s to the UI.
 */
export function buildShadowInviteCoordinator(deps: ShadowInviteWiringDeps): ShadowInviteCoordinator {
  const transport: ShadowInviteTransport = {
    async sendControl(peerUid, payload) {
      await deps.messaging()?.sendShadowControl(peerUid, payload);
    },
    async sendShadow(peerUid, threadId, plaintext) {
      await deps.messaging()?.send(peerUid, plaintext, { threadId });
    },
  };

  return new DefaultShadowInviteCoordinator({
    store: deps.store,
    registry: deps.registry,
    transport,
    random: { bytes: deps.randomBytes ?? defaultRandomBytes },
    rowThreads: deps.rowThreads,
    purgeMessages: (ids) => deps.keyStore.purgeMessages(ids),
    resolveMode: deps.resolveMode,
    // The coordinator only ever calls myUid() in real mode after sign-in; fall back to '' (which it
    // rejects as a non-distinct/empty uid) before a uid is known, so it stays a safe no-op.
    myUid: () => deps.myUid() ?? '',
    now: deps.now ?? Date.now,
    newInviteId: deps.newInviteId ?? defaultNewInviteId,
  });
}
