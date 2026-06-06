/**
 * In-process local socket registry (Phase 1, design Backend Component B).
 *
 * A small, node-local index of which authenticated WebSocket sockets belong to which
 * recipient uid, used so {@link MessageRelayService.deliverLocal} can push a delivered
 * envelope to every live socket the recipient holds on THIS node.
 *
 * The registry is intentionally transport-agnostic: it knows nothing about `ws`,
 * NestJS, or the wire — it only holds opaque {@link LocalRecipientSocket} handles keyed
 * by uid. The {@link RealtimeGateway} populates it (register on a successful handshake,
 * unregister on disconnect) in task 4.7; this task defines the interface and a concrete
 * in-process implementation so the relay can be unit-tested without a real gateway.
 *
 * Nothing here ever touches the ciphertext body — sockets receive whole server→client
 * frames and the registry only routes them by uid (Requirement 8.2).
 */

import { Injectable } from '@nestjs/common';
import type { ServerToClientFrame } from '@chat-app/types';

/**
 * DI token for the {@link LocalSocketRegistry}. Consumers inject the registry via
 * `@Inject(LOCAL_SOCKET_REGISTRY)` so the concrete implementation can be swapped (e.g.
 * a fake in tests) without depending on the class directly.
 */
export const LOCAL_SOCKET_REGISTRY = Symbol('LOCAL_SOCKET_REGISTRY');

/**
 * The minimal capability the relay needs from a locally-held recipient socket: the
 * ability to receive a server→client frame. Kept library-agnostic (no `ws` types) so
 * the gateway can adapt its own socket onto this surface in task 4.7.
 */
export interface LocalRecipientSocket {
  /** Sends a server→client frame to this socket. */
  send(frame: ServerToClientFrame): void;
}

/**
 * Node-local registry mapping a recipient uid to the live socket(s) it holds on this
 * node. The gateway mutates it via {@link register}/{@link unregister}; the relay reads
 * it via {@link getLocalSockets}.
 */
export interface LocalSocketRegistry {
  /** Records that `socket` is a live connection for `uid` on this node. Idempotent. */
  register(uid: string, socket: LocalRecipientSocket): void;
  /** Removes `socket` from `uid`'s live set. A no-op when it was not registered. */
  unregister(uid: string, socket: LocalRecipientSocket): void;
  /**
   * Returns a snapshot of every socket currently registered for `uid` on this node, or
   * an empty array when the recipient has no local connection. A snapshot (not a live
   * view) so callers may iterate while the underlying set is concurrently mutated.
   */
  getLocalSockets(uid: string): readonly LocalRecipientSocket[];
}

/**
 * Default in-process {@link LocalSocketRegistry}, backed by a `Map<uid, Set<socket>>`.
 *
 * A `Set` deduplicates repeat registrations of the same socket and makes
 * {@link unregister} an O(1) no-op when the socket is absent. Emptied sets are deleted
 * so an offline recipient leaves no residual key.
 */
@Injectable()
export class InProcessSocketRegistry implements LocalSocketRegistry {
  private readonly socketsByUid = new Map<string, Set<LocalRecipientSocket>>();

  register(uid: string, socket: LocalRecipientSocket): void {
    let sockets = this.socketsByUid.get(uid);
    if (sockets === undefined) {
      sockets = new Set<LocalRecipientSocket>();
      this.socketsByUid.set(uid, sockets);
    }
    sockets.add(socket);
  }

  unregister(uid: string, socket: LocalRecipientSocket): void {
    const sockets = this.socketsByUid.get(uid);
    if (sockets === undefined) {
      return;
    }
    sockets.delete(socket);
    if (sockets.size === 0) {
      this.socketsByUid.delete(uid);
    }
  }

  getLocalSockets(uid: string): readonly LocalRecipientSocket[] {
    const sockets = this.socketsByUid.get(uid);
    if (sockets === undefined) {
      return [];
    }
    // Snapshot so the caller can iterate safely even if the set mutates mid-delivery.
    return [...sockets];
  }
}
