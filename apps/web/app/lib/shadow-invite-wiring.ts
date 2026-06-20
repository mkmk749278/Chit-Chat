/**
 * `apps/web` — wiring of the shared {@link ShadowInviteCoordinator} (Shadow Chat Invites, design
 * Component A) for the web client. Supplies the web platform seams: a {@link RandomSource} backed by
 * the browser WebCrypto CSPRNG, the wall clock, and an invite-id generator. The caller injects the
 * {@link ShadowInviteTransport} (built over the web Messaging adapter), the device-local
 * {@link ShadowSecretStore} / {@link ConversationRegistry} / {@link RowThreadAssociation}, and the
 * `purgeMessages` primitive, so this module stays pure and testable.
 */

import {
  DefaultShadowInviteCoordinator,
  type AppMode,
  type ConversationRegistry,
  type RowThreadAssociation,
  type ShadowInviteCoordinator,
  type ShadowInviteTransport,
  type ShadowSecretStore,
} from '@chat-app/crypto';

export interface WebShadowInviteWiringDeps {
  transport: ShadowInviteTransport;
  store: ShadowSecretStore;
  registry: ConversationRegistry;
  rowThreads: RowThreadAssociation;
  purgeMessages: (ids: string[]) => Promise<void>;
  resolveMode: () => AppMode | null;
  myUid: () => string | null;
  /** CSPRNG (browser WebCrypto), injectable for tests. */
  randomBytes?: (n: number) => Uint8Array;
  now?: () => number;
  newInviteId?: () => string;
}

const defaultRandomBytes = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

const defaultNewInviteId = (): string =>
  typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Construct the web {@link ShadowInviteCoordinator} from the injected platform seams. */
export function buildWebShadowInviteCoordinator(
  deps: WebShadowInviteWiringDeps,
): ShadowInviteCoordinator {
  return new DefaultShadowInviteCoordinator({
    store: deps.store,
    registry: deps.registry,
    transport: deps.transport,
    random: { bytes: deps.randomBytes ?? defaultRandomBytes },
    rowThreads: deps.rowThreads,
    purgeMessages: deps.purgeMessages,
    resolveMode: deps.resolveMode,
    // Safe no-op before sign-in: an empty uid is rejected by the coordinator as non-distinct.
    myUid: () => deps.myUid() ?? '',
    now: deps.now ?? Date.now,
    newInviteId: deps.newInviteId ?? defaultNewInviteId,
  });
}
